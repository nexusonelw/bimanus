export interface McpBridgeServerConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface McpBridgeRuntime {
  listServers(): Promise<readonly McpBridgeServerConfig[]>;
  setServerEnabled(serverId: string, enabled: boolean): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface McpBridgeToolContent {
  readonly type: string;
  readonly text?: string | undefined;
  readonly data?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly [key: string]: unknown;
}

export interface McpBridgeListedTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

export interface McpBridgeCallToolResult {
  readonly content?: McpBridgeToolContent[] | undefined;
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface McpBridgeClient {
  listTools(): Promise<{ readonly tools?: McpBridgeListedTool[] | undefined }>;
  callTool(args: {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
  }): Promise<McpBridgeCallToolResult>;
  close(): Promise<void>;
}

export type McpBridgeClientFactory = (server: McpBridgeServerConfig) => Promise<McpBridgeClient>;
