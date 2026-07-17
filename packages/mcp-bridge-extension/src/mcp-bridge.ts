import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piToolName } from "./names.js";
import { normalizeToolSchema } from "./schema.js";
import type {
  McpBridgeCallToolResult,
  McpBridgeClient,
  McpBridgeClientFactory,
  McpBridgeRuntime,
  McpBridgeServerConfig,
  McpBridgeToolContent,
} from "./types.js";

type RegisteredToolBinding = {
  readonly piToolName: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly mcpToolName: string;
};

type RunningServer = {
  readonly client: McpBridgeClient;
  readonly configFingerprint: string;
  readonly toolNames: ReadonlySet<string>;
};

type ServerStatus = "running" | "stopped" | "disabled" | "unauthorized" | "error";

interface ServerStatusSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: ServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolResultContent(result: McpBridgeCallToolResult): McpBridgeToolContent[] {
  if (Array.isArray(result.content) && result.content.length > 0) {
    return result.content;
  }
  if (result.structuredContent !== undefined) {
    return [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }];
  }
  return [{ type: "text", text: "MCP tool completed without textual output." }];
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serverFingerprint(server: McpBridgeServerConfig): string {
  return JSON.stringify(server);
}

function knownServerConfigurationHint(server: McpBridgeServerConfig): string | undefined {
  try {
    const parsed = new URL(server.url);
    if (parsed.hostname === "api.exa.ai" && parsed.pathname === "/search") {
      return "Configured URL points to Exa Search API, not Exa MCP. Use https://mcp.exa.ai/mcp.";
    }
  } catch {
    // Ignore malformed URLs here; validation happens upstream.
  }
  return undefined;
}

function decorateServerError(server: McpBridgeServerConfig, error: unknown): string {
  const message = normalizeErrorMessage(error);
  const hint = knownServerConfigurationHint(server);
  return hint ? `${message} Hint: ${hint}` : message;
}

export class McpBridge {
  private readonly managementToolName = "mcp";
  private readonly running = new Map<string, RunningServer>();
  private readonly bindings = new Map<string, RegisteredToolBinding>();
  private readonly errors = new Map<string, string>();
  private readonly servers = new Map<string, McpBridgeServerConfig>();
  private unsubscribeRuntime: (() => void) | undefined;
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly runtime: McpBridgeRuntime,
    private readonly createClient: McpBridgeClientFactory,
  ) {
    this.registerManagementTool();
  }

  private registerManagementTool(): void {
    this.pi.registerTool({
      name: this.managementToolName,
      label: "MCP Servers",
      description: "List configured MCP servers, inspect their status, and enable, disable, start, stop, or reload one.",
      promptSnippet: "List or manage configured MCP servers",
      promptGuidelines: [
        "Use mcp when the user asks which MCP servers are configured, whether an MCP server is enabled, or to enable, disable, start, stop, or reload one.",
      ],
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "enable", "disable", "start", "stop", "reload"],
            description: "Management action to perform.",
          },
          server: {
            type: "string",
            description: "Server id or server name. Required for enable, disable, start, and stop.",
          },
        },
        required: ["action"],
      },
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        return this.executeManagementAction(params) as never;
      },
    });
  }

  registerCommands(): void {
    const withUiError = async (
      ctx: { ui: { notify: (message: string, level: "info" | "error") => void } },
      work: () => Promise<void>,
    ) => {
      try {
        await work();
      } catch (error) {
        ctx.ui.notify(normalizeErrorMessage(error), "error");
      }
    };

    this.pi.registerCommand("mcp", {
      description: "Show MCP status, inspect one server, or manage a configured MCP server",
      getArgumentCompletions: (prefix) => this.completeMcpCommandArgs(prefix),
      handler: async (args, ctx) => {
        await withUiError(ctx, async () => {
          const message = await this.executeMcpCommand(args);
          ctx.ui.notify(message, "info");
        });
      },
    });

    this.pi.registerCommand("mcp:start", {
      description: "Start one enabled MCP server for this session",
      getArgumentCompletions: (prefix) => this.completeServerRefs(prefix),
      handler: async (args, ctx) => {
        await withUiError(ctx, async () => {
          await this.enqueue(() => this.syncWithRuntime());
          const server = this.requireServer(args);
          await this.start(server.id);
          ctx.ui.notify(`Started MCP server: ${server.name}`, "info");
        });
      },
    });

    this.pi.registerCommand("mcp:stop", {
      description: "Stop one MCP server for this session",
      getArgumentCompletions: (prefix) => this.completeServerRefs(prefix),
      handler: async (args, ctx) => {
        await withUiError(ctx, async () => {
          await this.enqueue(() => this.syncWithRuntime());
          const server = this.requireServer(args);
          await this.stop(server.id);
          ctx.ui.notify(`Stopped MCP server: ${server.name}`, "info");
        });
      },
    });

    this.pi.registerCommand("mcp:enable", {
      description: "Enable one MCP server globally and activate it in this session",
      getArgumentCompletions: (prefix) => this.completeServerRefs(prefix),
      handler: async (args, ctx) => {
        await withUiError(ctx, async () => {
          await this.enqueue(async () => {
            const server = this.requireServer(args);
            await this.runtime.setServerEnabled(server.id, true);
            await this.syncWithRuntime();
          });
          const server = this.requireServer(args);
          ctx.ui.notify(`Enabled MCP server: ${server.name}`, "info");
        });
      },
    });

    this.pi.registerCommand("mcp:disable", {
      description: "Disable one MCP server globally and deactivate it in this session",
      getArgumentCompletions: (prefix) => this.completeServerRefs(prefix),
      handler: async (args, ctx) => {
        await withUiError(ctx, async () => {
          await this.enqueue(async () => {
            const server = this.requireServer(args);
            await this.runtime.setServerEnabled(server.id, false);
            await this.syncWithRuntime();
          });
          const server = this.requireServer(args);
          ctx.ui.notify(`Disabled MCP server: ${server.name}`, "info");
        });
      },
    });

    this.pi.registerCommand("mcp:reload", {
      description: "Reload MCP bridge state from desktop settings",
      handler: async (_args, ctx) => {
        await withUiError(ctx, async () => {
          await this.enqueue(() => this.syncWithRuntime());
          ctx.ui.notify("Reloaded MCP bridge state.", "info");
        });
      },
    });
  }

  async startSession(): Promise<void> {
    if (this.runtime.subscribe && !this.unsubscribeRuntime) {
      this.unsubscribeRuntime = this.runtime.subscribe(() => {
        void this.enqueue(() => this.syncWithRuntime());
      });
    }
    await this.enqueue(() => this.syncWithRuntime());
  }

  async shutdownSession(): Promise<void> {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    await this.stopAll();
  }

  status(): readonly ServerStatusSnapshot[] {
    return [...this.servers.values()]
      .map((server) => {
        const running = this.running.get(server.id);
        if (!server.enabled) {
          return { id: server.id, name: server.name, status: "disabled", toolCount: 0 } as const;
        }
        if (!server.authorized) {
          return { id: server.id, name: server.name, status: "unauthorized", toolCount: 0 } as const;
        }
        if (running) {
          return {
            id: server.id,
            name: server.name,
            status: "running",
            toolCount: running.toolNames.size,
          } as const;
        }
        const error = this.errors.get(server.id);
        if (error) {
          return { id: server.id, name: server.name, status: "error", toolCount: 0, error } as const;
        }
        return { id: server.id, name: server.name, status: "stopped", toolCount: 0 } as const;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async executeManagementAction(params: unknown): Promise<{
    readonly content: McpBridgeToolContent[];
    readonly details: Record<string, unknown>;
    readonly isError?: boolean;
  }> {
    const action = isRecord(params) && typeof params.action === "string" ? params.action : "";
    const serverRef = isRecord(params) && typeof params.server === "string" ? params.server : "";

    try {
      switch (action) {
        case "list":
          await this.enqueue(() => this.syncWithRuntime());
          return {
            content: [{ type: "text", text: this.renderStatusText() }],
            details: { servers: this.status() },
          };
        case "reload":
          await this.enqueue(() => this.syncWithRuntime());
          return {
            content: [{ type: "text", text: this.renderStatusText("Reloaded MCP bridge state.") }],
            details: { servers: this.status() },
          };
        case "enable": {
          const server = await this.enableServer(serverRef);
          return {
            content: [{ type: "text", text: this.renderStatusText(`Enabled ${server.name}.`) }],
            details: { server, servers: this.status() },
          };
        }
        case "disable": {
          const server = await this.disableServer(serverRef);
          return {
            content: [{ type: "text", text: this.renderStatusText(`Disabled ${server.name}.`) }],
            details: { server, servers: this.status() },
          };
        }
        case "start": {
          const server = await this.startServer(serverRef);
          return {
            content: [{ type: "text", text: this.renderStatusText(`Started ${server.name}.`) }],
            details: { server, servers: this.status() },
          };
        }
        case "stop": {
          const server = await this.stopServer(serverRef);
          return {
            content: [{ type: "text", text: this.renderStatusText(`Stopped ${server.name}.`) }],
            details: { server, servers: this.status() },
          };
        }
        default:
          return {
            content: [{ type: "text", text: "Unsupported MCP action. Use one of: list, enable, disable, start, stop, reload." }],
            details: {},
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: normalizeErrorMessage(error) }],
        details: { servers: this.status() },
        isError: true,
      };
    }
  }

  private renderStatusText(prefix?: string): string {
    const lines = this.status().map((server) => {
      const errorSuffix = server.error ? ` (${server.error})` : "";
      return `${server.name} [${server.id}]: ${server.status}, ${server.toolCount} tools${errorSuffix}`;
    });
    const body = lines.length > 0 ? lines.join("\n") : "No MCP servers configured.";
    return prefix ? `${prefix}\n${body}` : body;
  }

  private renderServerDetail(server: ServerStatusSnapshot): string {
    const errorLine = server.error ? `\nError: ${server.error}` : "";
    return `${server.name} [${server.id}]
Status: ${server.status}
Tools: ${server.toolCount}${errorLine}`;
  }

  private async executeMcpCommand(rawArgs: string): Promise<string> {
    await this.enqueue(() => this.syncWithRuntime());
    const trimmed = rawArgs.trim();
    if (!trimmed || trimmed === "list") {
      return this.renderStatusText();
    }

    const [action = "", ...rest] = trimmed.split(/\s+/);
    const serverRef = rest.join(" ").trim();
    switch (action.toLowerCase()) {
      case "reload":
        await this.enqueue(() => this.syncWithRuntime());
        return this.renderStatusText("Reloaded MCP bridge state.");
      case "enable": {
        const server = await this.enableServer(serverRef);
        return this.renderStatusText(`Enabled ${server.name}.`);
      }
      case "disable": {
        const server = await this.disableServer(serverRef);
        return this.renderStatusText(`Disabled ${server.name}.`);
      }
      case "start": {
        const server = await this.startServer(serverRef);
        return this.renderStatusText(`Started ${server.name}.`);
      }
      case "stop": {
        const server = await this.stopServer(serverRef);
        return this.renderStatusText(`Stopped ${server.name}.`);
      }
      default:
        break;
    }

    const server = this.findServer(trimmed);
    if (server) {
      const status = this.status().find((entry) => entry.id === server.id);
      if (!status) {
        throw new Error(`MCP server status is unavailable: ${server.name}`);
      }
      return this.renderServerDetail(status);
    }

    throw new Error(
      "Unsupported MCP command. Use `/mcp`, `/mcp <server>`, or `/mcp <list|reload|enable|disable|start|stop> [server]`.",
    );
  }

  private async syncWithRuntime(): Promise<void> {
    const nextServers = await this.runtime.listServers();
    this.servers.clear();
    for (const server of nextServers) {
      this.servers.set(server.id, server);
    }

    for (const [serverId, running] of [...this.running.entries()]) {
      const next = this.servers.get(serverId);
      if (!next || !next.enabled || !next.authorized || running.configFingerprint !== serverFingerprint(next)) {
        await this.stop(serverId);
      }
    }

    for (const server of nextServers) {
      if (!server.enabled || !server.authorized || this.running.has(server.id)) {
        continue;
      }
      try {
        await this.start(server.id);
      } catch (error) {
        this.errors.set(server.id, decorateServerError(server, error));
      }
    }
  }

  private async start(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    if (!server.enabled) {
      throw new Error(`${server.name} is disabled.`);
    }
    if (!server.authorized) {
      throw new Error(`${server.name} is not authorized yet.`);
    }

    const current = this.running.get(serverId);
    if (current && current.configFingerprint === serverFingerprint(server)) {
      this.activateTools(current.toolNames);
      return;
    }
    if (current) {
      await this.stop(serverId);
    }

    const client = await this.createClient(server);
    try {
      const listed = await client.listTools();
      const toolNames = new Set<string>();
      for (const tool of listed.tools ?? []) {
        const nextPiToolName = piToolName(server.name, server.id, tool.name);
        this.ensureToolRegistered({
          piToolName: nextPiToolName,
          serverId: server.id,
          serverName: server.name,
          mcpToolName: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        });
        toolNames.add(nextPiToolName);
      }
      this.running.set(server.id, {
        client,
        configFingerprint: serverFingerprint(server),
        toolNames,
      });
      this.errors.delete(server.id);
      this.activateTools(toolNames);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async stop(serverId: string): Promise<void> {
    const running = this.running.get(serverId);
    if (!running) {
      return;
    }
    this.deactivateTools(running.toolNames);
    this.running.delete(serverId);
    await running.client.close().catch(() => undefined);
  }

  private async stopAll(): Promise<void> {
    for (const serverId of [...this.running.keys()]) {
      await this.stop(serverId);
    }
  }

  private async enableServer(serverRef: string): Promise<McpBridgeServerConfig> {
    await this.enqueue(async () => {
      const server = this.requireServer(serverRef);
      await this.runtime.setServerEnabled(server.id, true);
      await this.syncWithRuntime();
    });
    return this.requireServer(serverRef);
  }

  private async disableServer(serverRef: string): Promise<McpBridgeServerConfig> {
    await this.enqueue(async () => {
      const server = this.requireServer(serverRef);
      await this.runtime.setServerEnabled(server.id, false);
      await this.syncWithRuntime();
    });
    return this.requireServer(serverRef);
  }

  private async startServer(serverRef: string): Promise<McpBridgeServerConfig> {
    await this.enqueue(async () => {
      await this.syncWithRuntime();
      const server = this.requireServer(serverRef);
      await this.start(server.id);
    });
    return this.requireServer(serverRef);
  }

  private async stopServer(serverRef: string): Promise<McpBridgeServerConfig> {
    await this.enqueue(async () => {
      await this.syncWithRuntime();
      const server = this.requireServer(serverRef);
      await this.stop(server.id);
    });
    return this.requireServer(serverRef);
  }

  private ensureToolRegistered({
    piToolName: nextPiToolName,
    serverId,
    serverName,
    mcpToolName,
    description,
    inputSchema,
  }: {
    readonly piToolName: string;
    readonly serverId: string;
    readonly serverName: string;
    readonly mcpToolName: string;
    readonly description?: string | undefined;
    readonly inputSchema?: unknown;
  }): void {
    if (this.bindings.has(nextPiToolName)) {
      return;
    }

    this.bindings.set(nextPiToolName, {
      piToolName: nextPiToolName,
      serverId,
      serverName,
      mcpToolName,
    });

    this.pi.registerTool({
      name: nextPiToolName,
      label: `${serverName}.${mcpToolName}`,
      description: description ?? `Call MCP tool ${serverName}.${mcpToolName}.`,
      promptSnippet: `Call MCP tool ${serverName}.${mcpToolName}`,
      promptGuidelines: [
        `Use ${nextPiToolName} only when the user needs the ${serverName}.${mcpToolName} MCP capability.`,
      ],
      parameters: normalizeToolSchema(inputSchema),
      executionMode: "sequential",
      execute: async (_toolCallId, params, _signal, onUpdate) => {
        return this.invokeTool(nextPiToolName, params, onUpdate as never) as never;
      },
    });
  }

  private async invokeTool(
    nextPiToolName: string,
    params: unknown,
    onUpdate:
      | ((update: { content: McpBridgeToolContent[]; details: Record<string, unknown> }) => void)
      | undefined,
  ): Promise<{
    readonly content: McpBridgeToolContent[];
    readonly details: Record<string, unknown>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  }> {
    const binding = this.bindings.get(nextPiToolName);
    if (!binding) {
      return {
        content: [{ type: "text", text: `MCP bridge could not resolve tool ${nextPiToolName}.` }],
        details: { tool: nextPiToolName },
        isError: true,
      };
    }

    const running = this.running.get(binding.serverId);
    if (!running) {
      return {
        content: [{ type: "text", text: `${binding.serverName} is not running in this session.` }],
        details: { server: binding.serverName, tool: binding.mcpToolName },
        isError: true,
      };
    }

    onUpdate?.({
      content: [{ type: "text", text: `Calling ${binding.serverName}.${binding.mcpToolName}...` }],
      details: {},
    });

    try {
      const result = await running.client.callTool({
        name: binding.mcpToolName,
        ...(isRecord(params) ? { arguments: params } : {}),
      });
      return {
        content: normalizeToolResultContent(result),
        details: {
          server: binding.serverName,
          tool: binding.mcpToolName,
          ...(result.details !== undefined ? { mcp: result.details } : {}),
        },
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: normalizeErrorMessage(error) }],
        details: {
          server: binding.serverName,
          tool: binding.mcpToolName,
        },
        isError: true,
      };
    }
  }

  private activateTools(names: Iterable<string>): void {
    const activeTools = new Set(this.pi.getActiveTools());
    for (const name of names) {
      activeTools.add(name);
    }
    this.pi.setActiveTools([...activeTools]);
  }

  private deactivateTools(names: Iterable<string>): void {
    const activeTools = new Set(this.pi.getActiveTools());
    for (const name of names) {
      activeTools.delete(name);
    }
    this.pi.setActiveTools([...activeTools]);
  }

  private completeServerRefs(prefix: string): { value: string; label: string }[] | null {
    const candidates = [...this.servers.values()]
      .flatMap((server) => [
        { value: server.name, label: server.name },
        { value: server.id, label: `${server.name} (${server.id})` },
      ])
      .filter((entry) => entry.value.startsWith(prefix));
    return candidates.length > 0 ? candidates : null;
  }

  private completeMcpCommandArgs(prefix: string): { value: string; label: string }[] | null {
    const trimmed = prefix.trimStart();
    const actions = [
      { value: "list", label: "show status for all configured MCP servers" },
      { value: "reload", label: "reload MCP bridge state from desktop settings" },
      { value: "enable ", label: "enable one MCP server globally" },
      { value: "disable ", label: "disable one MCP server globally" },
      { value: "start ", label: "start one MCP server in this session" },
      { value: "stop ", label: "stop one MCP server in this session" },
    ];

    if (!trimmed) {
      return [{ value: "", label: "list configured MCP servers" }, ...actions];
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length === 1 && !trimmed.endsWith(" ")) {
      const actionPrefix = parts[0]!.toLowerCase();
      const actionCompletions = actions.filter((entry) => entry.value.trim().startsWith(actionPrefix));
      const serverCompletions = this.completeServerRefs(trimmed) ?? [];
      const completions = [...actionCompletions, ...serverCompletions];
      return completions.length > 0 ? completions : null;
    }

    const [action, ...rest] = parts;
    const normalizedAction = action!.toLowerCase();
    if (["enable", "disable", "start", "stop"].includes(normalizedAction)) {
      const serverPrefix = trimmed.endsWith(" ") ? "" : rest.join(" ");
      const serverCompletions = this.completeServerRefs(serverPrefix) ?? [];
      return serverCompletions.map((entry) => ({
        value: `${normalizedAction} ${entry.value}`,
        label: entry.label,
      }));
    }

    return this.completeServerRefs(trimmed);
  }

  private findServer(raw: string): McpBridgeServerConfig | undefined {
    const ref = raw.trim();
    if (!ref) {
      return undefined;
    }
    const exactId = this.servers.get(ref);
    if (exactId) {
      return exactId;
    }
    const exactName = [...this.servers.values()].find((server) => server.name === ref);
    if (exactName) {
      return exactName;
    }
    const matches = [...this.servers.values()].filter(
      (server) => server.id.startsWith(ref) || server.name.startsWith(ref),
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous MCP server reference: ${ref}`);
    }
    return undefined;
  }

  private requireServer(raw: string): McpBridgeServerConfig {
    const ref = raw.trim();
    if (!ref) {
      throw new Error("MCP server name or id is required.");
    }
    const matched = this.findServer(ref);
    if (matched) {
      return matched;
    }
    throw new Error(`Unknown MCP server: ${ref}`);
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.syncQueue.then(work, work);
    this.syncQueue = next.catch(() => undefined);
    return next;
  }
}
