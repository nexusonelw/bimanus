import type { SessionConfig } from "@bimanus/session-driver";
import { createEmptyExtensionUiState as createBaseExtensionUiState, type ExtensionUiState } from "@bimanus/pi-sdk-driver";
import type { RuntimeCommandRecord } from "@bimanus/session-driver/runtime-types";
import type {
  SessionExtensionDialogRecord,
  SessionExtensionUiStateRecord,
} from "../src/desktop-state";

export interface MutableSessionExtensionUiState extends ExtensionUiState {
  pendingDialogs: SessionExtensionDialogRecord[];
}

export interface PendingAutoTitle {
  readonly requestToken: string;
  readonly cancel: () => void;
}

/**
 * Consolidates all per-session Maps (and one Set) that DesktopAppStore
 * maintains for runtime session state.  Having them in a single class
 * makes pruning and deletion consistent — every map is cleaned in one
 * place instead of manually repeating the list across call sites.
 */
export class SessionStateMap {
  readonly sessionConfigBySession = new Map<string, SessionConfig>();
  readonly lastViewedAtBySession = new Map<string, string>();
  readonly sessionErrorsBySession = new Map<string, string>();
  readonly sessionSubscriptions = new Map<string, () => void>();
  readonly runningSinceBySession = new Map<string, string>();
  readonly sessionCommandsBySession = new Map<string, RuntimeCommandRecord[]>();
  readonly extensionUiBySession = new Map<string, MutableSessionExtensionUiState>();
  readonly pendingAutoTitleBySession = new Map<string, PendingAutoTitle>();

  /**
   * Remove entries for session keys that are no longer active.
   * Calls the unsubscribe callback for any stale subscription before deleting it.
   */
  prune(activeKeys: Set<string>): void {
    for (const [key, unsubscribe] of this.sessionSubscriptions) {
      if (!activeKeys.has(key)) {
        unsubscribe();
        this.deleteSession(key);
      }
    }
  }

  /** Remove all state for a single session key. */
  deleteSession(key: string): void {
    const pendingAutoTitle = this.pendingAutoTitleBySession.get(key);
    this.sessionSubscriptions.delete(key);
    this.runningSinceBySession.delete(key);
    this.sessionConfigBySession.delete(key);
    this.lastViewedAtBySession.delete(key);
    this.sessionErrorsBySession.delete(key);
    this.sessionCommandsBySession.delete(key);
    this.extensionUiBySession.delete(key);
    this.pendingAutoTitleBySession.delete(key);
    pendingAutoTitle?.cancel();
  }
}

export function createEmptyExtensionUiState(): MutableSessionExtensionUiState {
  return {
    ...createBaseExtensionUiState(),
    pendingDialogs: [],
  };
}

export function serializeExtensionUiState(state: MutableSessionExtensionUiState): SessionExtensionUiStateRecord {
  return {
    statuses: [...state.statuses.entries()].map(([key, text]) => ({ key, text })),
    widgets: [...state.widgets.values()],
    pendingDialogs: [...state.pendingDialogs],
    ...(state.title ? { title: state.title } : {}),
    ...(state.editorText ? { editorText: state.editorText } : {}),
  };
}
