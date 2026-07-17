import type { DesktopAppStore } from "./app-store";
import type { DesktopAppState } from "../src/desktop-state";
import type { McpBridgeRuntime, McpBridgeServerConfig } from "../../../packages/mcp-bridge-extension/src/types";

type StoreGetter = () => DesktopAppStore | undefined;

export class DesktopMcpBridgeRuntime implements McpBridgeRuntime {
  private readonly listeners = new Set<() => void>();
  private unsubscribeStore: (() => void) | undefined;
  private lastSignature = "";

  constructor(private readonly getStore: StoreGetter) {}

  async listServers(): Promise<readonly McpBridgeServerConfig[]> {
    return this.requireStore().getMcpBridgeServers();
  }

  async setServerEnabled(serverId: string, enabled: boolean): Promise<void> {
    await this.requireStore().setMcpServerEnabled(serverId, enabled);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.ensureStoreSubscription();
    void this.listServers()
      .then((servers) => {
        this.lastSignature = JSON.stringify(servers);
      })
      .catch(() => undefined);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribeStore?.();
        this.unsubscribeStore = undefined;
      }
    };
  }

  private ensureStoreSubscription(): void {
    if (this.unsubscribeStore) {
      return;
    }
    const store = this.requireStore();
    this.unsubscribeStore = store.subscribe((state) => {
      const nextSignature = signatureForState(state);
      if (nextSignature === this.lastSignature) {
        return;
      }
      this.lastSignature = nextSignature;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  private requireStore(): DesktopAppStore {
    const store = this.getStore();
    if (!store) {
      throw new Error("Desktop MCP bridge runtime is not ready yet.");
    }
    return store;
  }
}

function signatureForState(state: DesktopAppState): string {
  return JSON.stringify(
    state.mcpServers.map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      apiKey: server.apiKey,
      oauthEnabled: server.oauthEnabled,
      authorized: server.authorized,
      enabled: server.enabled,
      updatedAt: server.updatedAt,
    })),
  );
}
