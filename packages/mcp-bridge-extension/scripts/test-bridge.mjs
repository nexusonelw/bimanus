import assert from "node:assert/strict";
import { createMcpBridgeExtension } from "../dist/index.js";

function createMockPi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  let activeTools = [];

  return {
    tools,
    commands,
    handlers,
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
      getActiveTools() {
        return [...activeTools];
      },
      setActiveTools(next) {
        activeTools = [...next];
      },
    },
  };
}

const runtimeState = {
  servers: [
    {
      id: "server-1",
      name: "context7",
      url: "https://example.com/mcp",
      enabled: true,
      authorized: true,
      headers: { Authorization: "Bearer token" },
    },
  ],
  listeners: new Set(),
};

const runtime = {
  async listServers() {
    return runtimeState.servers;
  },
  async setServerEnabled(serverId, enabled) {
    runtimeState.servers = runtimeState.servers.map((server) =>
      server.id === serverId ? { ...server, enabled } : server,
    );
    for (const listener of runtimeState.listeners) {
      listener();
    }
  },
  subscribe(listener) {
    runtimeState.listeners.add(listener);
    return () => {
      runtimeState.listeners.delete(listener);
    };
  },
};

const toolCalls = [];
const extension = createMcpBridgeExtension(runtime, {
  async clientFactory() {
    return {
      async listTools() {
        return {
          tools: [
            {
              name: "lookup",
              description: "Lookup docs",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          ],
        };
      },
      async callTool(args) {
        toolCalls.push(args);
        return {
          content: [{ type: "text", text: `lookup:${args.arguments.query}` }],
        };
      },
      async close() {},
    };
  },
});

const { pi, tools, commands, handlers } = createMockPi();
await extension(pi);

const managementTool = tools.get("mcp");
assert.ok(managementTool, "MCP management tool should be registered during extension load");

assert.ok(commands.has("mcp"), "mcp status command should be registered");
assert.ok(commands.has("mcp:disable"), "mcp:disable command should be registered");
assert.ok(handlers.has("session_start"), "MCP bridge should register a session_start handler");
await handlers.get("session_start")({}, {});

const tool = [...tools.values()].find((entry) => entry.name !== "mcp");
assert.ok(tool, "MCP server tool should be registered after session start");
assert.ok(pi.getActiveTools().includes(tool.name), "MCP tool should be active after session start");

const statusResult = await managementTool.execute("call-status", { action: "list" });
assert.match(statusResult.content[0].text, /context7/i);

const notifications = [];
await commands.get("mcp").handler("context7", {
  ui: { notify(message) { notifications.push(message); } },
});
assert.match(notifications.at(-1), /Status: running/);

await commands.get("mcp").handler("disable context7", {
  ui: { notify(message) { notifications.push(message); } },
});
assert.match(notifications.at(-1), /Disabled context7\./);
assert.ok(!pi.getActiveTools().includes(tool.name), "tool should be inactive after /mcp disable");

await commands.get("mcp").handler("enable context7", {
  ui: { notify(message) { notifications.push(message); } },
});
assert.match(notifications.at(-1), /Enabled context7\./);
assert.ok(pi.getActiveTools().includes(tool.name), "tool should be active after /mcp enable");

const firstResult = await tool.execute("call-1", { query: "docs" });
assert.equal(firstResult.content[0].text, "lookup:docs");
assert.deepEqual(toolCalls[0], {
  name: "lookup",
  arguments: { query: "docs" },
});

await commands.get("mcp:disable").handler("context7", {
  ui: { notify() {} },
});
assert.ok(!pi.getActiveTools().includes(tool.name), "tool should be inactive after disable");

await commands.get("mcp:enable").handler("context7", {
  ui: { notify() {} },
});
assert.ok(pi.getActiveTools().includes(tool.name), "tool should be active after re-enable");

await handlers.get("session_shutdown")({}, {});
