import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createSdkMcpClient } from "./mcp-client.js";
import { McpBridge } from "./mcp-bridge.js";
import type { McpBridgeClientFactory, McpBridgeRuntime, McpBridgeServerConfig } from "./types.js";

export type {
  McpBridgeClient,
  McpBridgeClientFactory,
  McpBridgeCallToolResult,
  McpBridgeListedTool,
  McpBridgeRuntime,
  McpBridgeServerConfig,
  McpBridgeToolContent,
} from "./types.js";

export interface CreateMcpBridgeExtensionOptions {
  readonly clientFactory?: McpBridgeClientFactory;
}

const envServersKey = "PI_GUI_MCP_BRIDGE_SERVERS_JSON";
const defaultRuntime: McpBridgeRuntime = createEnvSnapshotRuntime() ?? {
  listServers: async () => [],
  setServerEnabled: async () => {
    throw new Error("MCP bridge runtime is not configured.");
  },
};

export function createMcpBridgeExtension(
  runtime: McpBridgeRuntime = defaultRuntime,
  options: CreateMcpBridgeExtensionOptions = {},
): ExtensionFactory {
  const clientFactory = options.clientFactory ?? createSdkMcpClient;
  return (pi: ExtensionAPI) => {
    registerMcpBridgeExtension(pi, runtime, clientFactory);
  };
}

export default function mcpBridgeExtension(pi: ExtensionAPI): void {
  registerMcpBridgeExtension(pi, defaultRuntime, createSdkMcpClient);
}

function createEnvSnapshotRuntime(): McpBridgeRuntime | undefined {
  const raw = typeof process === "undefined" ? undefined : process.env[envServersKey];
  if (!raw?.trim()) {
    return undefined;
  }

  let servers: readonly McpBridgeServerConfig[];
  try {
    servers = parseEnvServers(raw);
  } catch {
    servers = [];
  }
  return {
    listServers: async () => servers,
    setServerEnabled: async (serverId, enabled) => {
      servers = servers.map((server) => server.id === serverId ? { ...server, enabled } : server);
    },
  };
}

function parseEnvServers(raw: string): readonly McpBridgeServerConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    const server = entry as Partial<McpBridgeServerConfig>;
    if (
      typeof server.id !== "string" ||
      typeof server.name !== "string" ||
      typeof server.url !== "string" ||
      typeof server.enabled !== "boolean" ||
      typeof server.authorized !== "boolean"
    ) {
      return [];
    }
    return [{
      id: server.id,
      name: server.name,
      url: server.url,
      enabled: server.enabled,
      authorized: server.authorized,
      ...(isHeaderRecord(server.headers) ? { headers: server.headers } : {}),
    }];
  });
}

function isHeaderRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function registerMcpBridgeExtension(
  pi: ExtensionAPI,
  runtime: McpBridgeRuntime,
  clientFactory: McpBridgeClientFactory,
): void {
  const bridge = new McpBridge(pi, runtime, clientFactory);
  bridge.registerCommands();
  pi.on("session_start", async () => {
    await bridge.startSession();
  });
  pi.on("session_shutdown", async () => {
    await bridge.shutdownSession();
  });
}
