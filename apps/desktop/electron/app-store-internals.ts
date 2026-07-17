import type { PiSdkDriver, JsonCatalogStore } from "@bimanus/pi-sdk-driver";
import type { CreateSessionOptions, SessionConfig, SessionRef, SessionSnapshot, WorkspaceRef } from "@bimanus/session-driver";
import type { RuntimeCommandRecord, RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import type {
  AppView,
  DesktopAppState,
  ExtensionCommandCompatibilityRecord,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import type { PendingAutoTitle, SessionStateMap } from "./session-state-map";
import type { GitWorktreeManager } from "./worktree-manager";
import type { PendingRuntimeCommandExecution } from "./extension-command-compatibility";

/**
 * Internal interface shared by method-group files
 * (`app-store-workspace.ts`, `app-store-worktree.ts`)
 * so they can call back into the store without needing access to private members.
 */
export interface AppStoreInternals {
  /* ── State ─────────────────────────────────────────────── */
  state: DesktopAppState;
  readonly sessionState: SessionStateMap;
  readonly runtimeByWorkspace: Map<string, RuntimeSnapshot>;
  readonly extensionCommandCompatibilityByWorkspace: Map<string, Map<string, ExtensionCommandCompatibilityRecord>>;
  readonly pendingRuntimeCommandsBySession: Map<string, PendingRuntimeCommandExecution>;

  /* ── Infrastructure ────────────────────────────────────── */
  readonly driver: PiSdkDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;

  /* ── Shared helpers (called by extracted method groups) ── */
  initialize(): Promise<void>;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState>;
  selectSessionFast(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  selectedSessionRef(): SessionRef | undefined;
  getExtensionFilePath(workspaceId: string, filePath: string): string | undefined;
  sessionFromState(sessionRef: SessionRef): { archivedAt?: string; updatedAt: string; title: string; status: string } | undefined;
  ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined>;
  ensureSessionSubscription(sessionRef: SessionRef): Promise<void>;
  ensureSessionSubscribed(sessionRef: SessionRef): Promise<void>;
  refreshSessionCommandsFor(sessionRef: SessionRef): Promise<void>;
  getLearnedRuntimeCommandCompatibility(
    workspaceId: string,
    command: RuntimeCommandRecord,
  ): ExtensionCommandCompatibilityRecord | undefined;
  beginRuntimeCommandExecution(sessionRef: SessionRef, command: RuntimeCommandRecord): void;
  finishRuntimeCommandExecution(sessionRef: SessionRef, timestamp?: string): PendingRuntimeCommandExecution | undefined;
  clearExtensionUiForSession(sessionRef: SessionRef): void;
  cancelPendingDialogsForSession(sessionRef: SessionRef): Promise<void>;
  persistUiState(): Promise<void>;
  schedulePersistUiState(): void;
  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void;
  setPendingAutoTitle(sessionRef: SessionRef, pending: PendingAutoTitle): void;
  getPendingAutoTitle(sessionRef: SessionRef): PendingAutoTitle | undefined;
  clearPendingAutoTitle(sessionRef: SessionRef): void;
  buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined>;
  getActiveSystemPrompt(): string | undefined;
}

export interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly clearLastError?: boolean;
  readonly refreshWorktrees?: boolean;
  readonly activeView?: AppView;
  readonly markSelectedSessionViewed?: boolean;
  readonly hydrateSelectedSession?: boolean;
}
