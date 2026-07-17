import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpBridgeClient, McpBridgeServerConfig } from "./types.js";

export async function createSdkMcpClient(server: McpBridgeServerConfig): Promise<McpBridgeClient> {
  const client = new Client({
    name: `pi-gui-mcp-${server.id}`,
    version: "0.1.0",
  });

  const headers = server.headers ? { ...server.headers } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(headers ? { requestInit: { headers } } : {}),
  });

  await client.connect(transport as never);

  return {
    listTools: async () => client.listTools() as never,
    callTool: async (args) => client.callTool(args as never) as never,
    close: () => client.close(),
  };
}
