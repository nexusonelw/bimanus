import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  applyHostUiRequestToExtensionUiState,
  type GenerateThreadTitleOptions,
  isExtensionUiDialogRequest,
  JsonCatalogStore,
  PiSdkDriver,
  type PiSdkDriverConfig,
  type SessionTranscriptItem,
  sessionKey,
} from "@bimanus/pi-sdk-driver";
import type { SessionCatalogEntry } from "@bimanus/catalogs";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@bimanus/session-driver/types";
import type {
  CreateSessionOptions,
  HostUiResponse,
  SessionConfig,
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@bimanus/session-driver";
import type {
  ModelSettingsSnapshot,
  RuntimeCommandRecord,
  RuntimeLoginCallbacks,
  RuntimePackageRecord,
  RuntimePackageSearchRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@bimanus/session-driver/runtime-types";
import {
  type AppView,
  type ExtensionCommandCompatibilityRecord,
  createEmptyDesktopAppState,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_SURFACE_BG_COLOR,
  normalizeRemoteUiPort,
  normalizeSidebarWidth,
  normalizeSurfaceBgColor,
  normalizeTuiTabLimit,
  normalizeLocale,
  type CreateSessionInput,
  type CreateWorktreeInput,
  type DesktopAppState,
  type LocaleSetting,
  type McpServerConfig,
  type McpServerConfigInput,
  type RemoteUiStatus,
  type SystemPromptRecord,
  type NotificationPreferences,
  type RemoveWorktreeInput,
  type StartThreadInput,
  type WorkspaceSessionTarget,
} from "../src/desktop-state";
import { isKnownCliType, mergeCliEnablement } from "../src/cli-enablement";
import { StateBroadcastService } from "./state-broadcast-service";
import type {
  StateListener,
  SessionEventListener,
} from "./state-broadcast-service";
import { applySessionEventState, updateSessionRecord } from "./app-store-session-state";
import type { AppStoreInternals, RefreshStateOptions } from "./app-store-internals";
import {
  readPersistedUiState,
  type LegacyPersistedUiState,
  type McpServerOAuthTokens,
  type PersistedMcpServerConfig,
  type PersistedUiState,
  writePersistedUiState,
} from "./app-store-persistence";
import {
  type PendingRuntimeCommandExecution,
  getLearnedCommandCompatibility,
  pruneCompatibilityForRuntimeSnapshot,
  recordLearnedCommandCompatibility,
  restoreCompatibilityByWorkspace,
  serializeCompatibilityByWorkspace,
} from "./extension-command-compatibility";
import {
  buildWorktreeRecords,
  buildWorkspaceRecords,
  mapToRecord,
  toSessionRef,
} from "./app-store-utils";
import { SessionStateMap } from "./session-state-map";
import { createEmptyExtensionUiState, serializeExtensionUiState } from "./session-state-map";
import { GitWorktreeManager } from "./worktree-manager";
import { logTuiPerf } from "../src/tui-perf-log";
import * as workspace from "./app-store-workspace";
import * as worktree from "./app-store-worktree";
import { isSessionActivelyViewed, isSessionVisibleInWindow } from "./session-visibility";
import type { McpOAuthManager } from "./mcp-manager";
import type { McpBridgeServerConfig as RuntimeMcpBridgeServerConfig } from "../../../packages/mcp-bridge-extension/src/types";
import { SessionFileWatcher } from "./session-file-watcher";

const globalRuntimeWorkspaceId = "global";
const EXTERNAL_LAUNCH_RUNTIME_REFRESH_TTL_MS = 30_000;

export interface DesktopAppStoreOptions {
  readonly userDataDir: string;
  readonly initialWorkspacePaths: readonly string[];
  readonly getWindow?: () => BrowserWindow | null;
  readonly shouldKeepSessionDialogs?: (sessionRef: SessionRef) => boolean;
  readonly driverOptions?: Pick<PiSdkDriverConfig, "extensionFactories" | "inlineExtensionMetadata">;
  readonly generateThreadTitleOverride?: (
    workspace: WorkspaceRef,
    options: GenerateThreadTitleOptions,
  ) => Promise<string | null | undefined>;
}

export interface DesktopAppViewState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly sidebarCollapsed?: boolean;
  readonly sidebarWidth?: number;
}

export class DesktopAppStore implements AppStoreInternals {
  state = createEmptyDesktopAppState();
  private readonly broadcast: StateBroadcastService;
  readonly driver: PiSdkDriver;
  readonly catalogStore: JsonCatalogStore;
  readonly worktreeManager: GitWorktreeManager;
  private readonly uiStateFilePath: string;
  readonly sessionState = new SessionStateMap();
  readonly runtimeByWorkspace = new Map<string, RuntimeSnapshot>();
  private readonly externalLaunchRuntimeFreshUntilByWorkspace = new Map<string, number>();
  private readonly externalLaunchRuntimeRefreshByWorkspace = new Map<string, Promise<void>>();
  private globalRuntime: RuntimeSnapshot | undefined;
  readonly extensionCommandCompatibilityByWorkspace = new Map<string, Map<string, ExtensionCommandCompatibilityRecord>>();
  readonly pendingRuntimeCommandsBySession = new Map<string, PendingRuntimeCommandExecution>();
  private readonly reportedCompatibilityIssuesBySession = new Map<string, Set<string>>();
  private readonly mcpOAuthTokensByServerId = new Map<string, McpServerOAuthTokens>();
  private readonly initialWorkspacePaths: readonly string[];
  private readonly getWindow: () => BrowserWindow | null;
  private readonly shouldKeepSessionDialogs: (sessionRef: SessionRef) => boolean;
  private persistUiStateTimer: NodeJS.Timeout | undefined;
  private readonly restoredSelectedSessionKeysAwaitingSelection = new Set<string>();
  private initPromise: Promise<void> | undefined;
  private selectionEpoch = 0;
  private refreshStateDepth = 0;
  private readonly sessionFileWatcher: SessionFileWatcher;
  /**
   * Tracks the number of running sessions per workspace so the file
   * watcher can be suppressed while agents are actively running.
   * Key: workspaceId, Value: count of running sessions.
   */
  private readonly runningSessionCountByWorkspace = new Map<string, number>();
  private readonly runningSessionKeys = new Set<string>();

  constructor(options: DesktopAppStoreOptions) {
    const catalogFilePath = join(options.userDataDir, "catalogs.json");
    const driverOptions: PiSdkDriverConfig = {
      catalogFilePath,
      ...(options.driverOptions ?? {}),
      ...(options.generateThreadTitleOverride
        ? { generateThreadTitleOverride: options.generateThreadTitleOverride }
        : {}),
    };

    this.driver = new PiSdkDriver(driverOptions);
    this.catalogStore = new JsonCatalogStore({ catalogFilePath });
    this.worktreeManager = new GitWorktreeManager({ catalogStorage: this.catalogStore });
    this.uiStateFilePath = join(options.userDataDir, "ui-state.json");
    this.initialWorkspacePaths = options.initialWorkspacePaths;
    this.getWindow = options.getWindow ?? (() => null);
    this.shouldKeepSessionDialogs = options.shouldKeepSessionDialogs ?? (() => false);
    this.sessionFileWatcher = new SessionFileWatcher({
      getAgentDir: () => this.getAgentDir(),
      onWorkspaceSessionsChanged: async (workspaceId) => {
        await this.syncWorkspaceInPlace(workspaceId);
      },
    });
    this.broadcast = new StateBroadcastService({
      getState: () => this.state,
    });
  }

  /* ── Lifecycle ──────────────────────────────────────────── */

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeInternal();
    }
    return this.initPromise;
  }

  async getState(): Promise<DesktopAppState> {
    await this.initialize();
    return structuredClone(this.state);
  }

  getAgentDir(): string {
    return this.driver.getAgentDir();
  }

  dispose(): void {
    this.sessionFileWatcher.dispose();
  }

  async getStateForView(view: DesktopAppViewState): Promise<DesktopAppState> {
    await this.initialize();
    return this.projectStateForView(view);
  }

  projectStateForView(
    view: DesktopAppViewState,
    state: DesktopAppState = this.state,
    previousView?: DesktopAppViewState,
  ): DesktopAppState {
    const selectedWorkspaceId = this.resolveViewWorkspaceId(view.selectedWorkspaceId, state);
    const selectedSessionId = this.resolveViewSessionId(selectedWorkspaceId, view.selectedSessionId, state);
    const previousWorkspaceId = previousView
      ? this.resolveViewWorkspaceId(previousView.selectedWorkspaceId, state)
      : selectedWorkspaceId;
    const previousSessionId = previousView
      ? this.resolveViewSessionId(previousWorkspaceId, previousView.selectedSessionId, state)
      : selectedSessionId;
    const selectionChanged =
      selectedWorkspaceId !== previousWorkspaceId || selectedSessionId !== previousSessionId;
    const activeView = view.activeView ?? state.activeView;
    const sidebarCollapsed = view.sidebarCollapsed ?? state.sidebarCollapsed;
    const sidebarWidth = view.sidebarWidth ?? state.sidebarWidth;

    return {
      ...structuredClone(state),
      selectedWorkspaceId,
      selectedSessionId,
      activeView,
      sidebarCollapsed,
      sidebarWidth,
      lastError: this.resolveSelectedSessionError(selectedWorkspaceId, selectedSessionId, false) ?? (
        selectedSessionId ? undefined : state.lastError
      ),
    };
  }

  async flushPersistence(): Promise<void> {
    await this.initialize();
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
      this.persistUiStateTimer = undefined;
    }

    await this.persistUiState();
  }

  async emitTestSessionEvent(event: SessionDriverEvent): Promise<void> {
    await this.initialize();
    await this.handleSessionEvent(event);
  }

  subscribe(listener: StateListener): () => void {
    const unsubscribe = this.broadcast.subscribe(listener);
    void this.getState().then(listener).catch(() => undefined);
    return unsubscribe;
  }

  subscribeToSessionEvents(listener: SessionEventListener): () => void {
    return this.broadcast.subscribeToSessionEvents(listener);
  }

  /* ── Workspace methods (delegated) ─────────────────────── */

  async addWorkspace(path: string): Promise<DesktopAppState> {
    return workspace.addWorkspace(this, path);
  }

  getWorkspacePath(workspaceId: string): string | undefined {
    return this.state.workspaces.find((w) => w.id === workspaceId)?.path;
  }

  getSkillFilePath(workspaceId: string, filePath: string): string | undefined {
    return this.runtimeByWorkspace.get(workspaceId)?.skills.find((s) => s.filePath === filePath)?.filePath;
  }

  getExtensionFilePath(workspaceId: string, filePath: string): string | undefined {
    return this.runtimeByWorkspace.get(workspaceId)?.extensions.find((entry) => entry.path === filePath)?.path;
  }

  async renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState> {
    return workspace.renameWorkspace(this, workspaceId, displayName);
  }

  async removeWorkspace(workspaceId: string): Promise<DesktopAppState> {
    return workspace.removeWorkspace(this, workspaceId);
  }

  async reorderWorkspaces(order: readonly string[]): Promise<DesktopAppState> {
    await this.initialize();
    const primaryIds = new Set(this.state.workspaces.filter((w) => w.kind === "primary").map((w) => w.id));
    const sanitized = [...new Set(order)].filter((id) => primaryIds.has(id));
    this.state = {
      ...this.state,
      workspaceOrder: sanitized,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async selectWorkspace(workspaceId: string): Promise<DesktopAppState> {
    return workspace.selectWorkspace(this, workspaceId);
  }

  async selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.selectSession(this, target);
  }

  async selectSessionFast(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    logTuiPerf("main.store.selectSessionFast.start", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    }, {
      sessionInState: Boolean(this.sessionFromState(sessionRef)),
      selectedWorkspaceId: this.state.selectedWorkspaceId,
      selectedSessionId: this.state.selectedSessionId,
    });
    if (!this.sessionFromState(sessionRef)) {
      return this.withErrorHandling(async () =>
        this.refreshState({
          selectedWorkspaceId: target.workspaceId,
          selectedSessionId: target.sessionId,
          clearLastError: true,
          activeView: "threads",
        }),
      );
    }

    return this.withErrorHandling(async () => {
      const selectionEpoch = ++this.selectionEpoch;
      const snapshot = this.applyFastSessionSelection(sessionRef);
      logTuiPerf("main.store.selectSessionFast.snapshotReturned", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      }, {
        selectionEpoch,
        revision: snapshot.revision,
        selectedWorkspaceId: snapshot.selectedWorkspaceId,
        selectedSessionId: snapshot.selectedSessionId,
      });
      void this.hydrateSelectedSessionAfterSelection(sessionRef, selectionEpoch, { markViewed: true }).catch(
        (error: unknown) => {
          logTuiPerf("main.store.selectSessionFast.hydrateError", {
            workspaceId: sessionRef.workspaceId,
            sessionId: sessionRef.sessionId,
          }, {
            selectionEpoch,
            error: error instanceof Error ? error.message : String(error),
          });
          void this.handleSelectedSessionHydrationError(sessionRef, selectionEpoch, error);
        },
      );
      return snapshot;
    });
  }

  async getSessionFilePath(target: WorkspaceSessionTarget): Promise<string | undefined> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    const sessionFile = await this.catalogStore.getSessionFile(sessionRef);
    const sessionEntry = sessionFile ? undefined : await this.catalogStore.sessions.getSession(sessionRef);
    const resolvedSessionFile = sessionFile ?? sessionEntry?.sessionFilePath;
    logTuiPerf("main.store.getSessionFilePath", {
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
    }, {
      found: Boolean(resolvedSessionFile),
      source: sessionFile ? "sessionFiles" : sessionEntry?.sessionFilePath ? "sessionEntry" : "missing",
      sessionFile: resolvedSessionFile,
    });
    return resolvedSessionFile;
  }

  async archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.archiveSession(this, target);
  }

  async unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    return workspace.unarchiveSession(this, target);
  }

  async reloadSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    return this.withErrorHandling(async () => {
      await this.driver.reopenSessionFromDisk(sessionRef);
      await this.refreshSessionCommandsFor(sessionRef);
      return this.refreshState({
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
    });
  }

  async reloadSessionFromDiskInPlace(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    return this.withErrorHandling(async () => {
      await this.driver.reopenSessionFromDisk(sessionRef);
      await this.refreshSessionCommandsFor(sessionRef);
      return this.refreshState({
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        markSelectedSessionViewed: false,
      });
    });
  }

  async syncCurrentWorkspace(): Promise<DesktopAppState> {
    return workspace.syncCurrentWorkspace(this);
  }

  async syncWorkspaceInPlace(workspaceId: string): Promise<DesktopAppState> {
    await this.initialize();
    const targetWorkspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!targetWorkspace) {
      return this.emit();
    }
    return this.withErrorHandling(async () => {
      await this.driver.syncWorkspace(targetWorkspace.path, targetWorkspace.name);
      return this.refreshState({
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        refreshWorktrees: true,
        markSelectedSessionViewed: false,
      });
    });
  }

  /* ── Worktree methods (delegated) ──────────────────────── */

  async createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState> {
    return worktree.createWorktree(this, input);
  }

  async removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState> {
    return worktree.removeWorktree(this, input);
  }

  async cancelCurrentRun(): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = this.selectedSessionRef();
    if (!sessionRef) {
      return this.emit();
    }
    return this.withErrorHandling(async () => {
      await this.driver.cancelCurrentRun(sessionRef);
      this.sessionState.sessionErrorsBySession.delete(sessionKey(sessionRef));
      this.state = {
        ...this.state,
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      this.schedulePersistUiState();
      return this.emit();
    });
  }

  async getSessionTree(target: WorkspaceSessionTarget): Promise<SessionTreeSnapshot> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    await this.ensureSessionReady(sessionRef);
    return this.driver.getSessionTree(sessionRef);
  }

  async reloadSessionTranscriptFromDisk(target: WorkspaceSessionTarget): Promise<SessionTranscriptItem[]> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    const workspaceRecord = this.state.workspaces.find((workspace) => workspace.id === sessionRef.workspaceId);
    if (workspaceRecord) {
      await this.driver.syncWorkspace(workspaceRecord.path, workspaceRecord.name);
    }
    await this.driver.reopenSessionFromDisk(sessionRef);
    return this.driver.getTranscript(sessionRef);
  }

  async navigateSessionTree(
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<{ readonly state: DesktopAppState; readonly result: NavigateSessionTreeResult }> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    await this.ensureSessionReady(sessionRef);

    const result = await this.driver.navigateSessionTree(sessionRef, targetId, options);
    if (!result.cancelled && !result.aborted) {
      await this.refreshSessionCommandsFor(sessionRef);
      const state = await this.refreshState({
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
      return { state, result };
    }

    return {
      state: structuredClone(this.state),
      result,
    };
  }

  /* ── Session / thread methods (delegated) ───────────────── */

  async startThread(input: StartThreadInput): Promise<DesktopAppState> {
    return worktree.startThread(this, input);
  }

  async createSession(input: CreateSessionInput): Promise<DesktopAppState> {
    return workspace.createSession(this, input);
  }

  /* ── View / UI state ───────────────────────────────────── */

  async setActiveView(activeView: AppView): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.activeView === "threads" && activeView !== "threads") {
      const sessionRef = this.selectedSessionRef();
      if (sessionRef) {
        await this.cancelPendingDialogsForSession(sessionRef);
      }
    }
    this.state = {
      ...this.state,
      activeView,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    if (activeView === "threads") {
      this.markSelectedSessionViewedIfVisible();
    }
    await this.persistUiState();
    return this.emit();
  }

  async setSidebarCollapsed(sidebarCollapsed: boolean): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.sidebarCollapsed === sidebarCollapsed) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      sidebarCollapsed,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setSidebarWidth(sidebarWidth: number): Promise<DesktopAppState> {
    await this.initialize();
    const nextSidebarWidth = normalizeSidebarWidth(sidebarWidth);
    if (this.state.sidebarWidth === nextSidebarWidth) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      sidebarWidth: nextSidebarWidth,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setNotificationPreferences(preferences: Partial<NotificationPreferences>): Promise<DesktopAppState> {
    await this.initialize();
    this.state = {
      ...this.state,
      notificationPreferences: {
        ...this.state.notificationPreferences,
        ...preferences,
      },
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setIntegratedTerminalShell(integratedTerminalShell: string): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedShell = integratedTerminalShell.trim();
    if (this.state.integratedTerminalShell === normalizedShell) {
      return this.emit();
    }
    this.state = {
      ...this.state,
      integratedTerminalShell: normalizedShell,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setTuiTabLimit(limit: number): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedLimit = normalizeTuiTabLimit(limit);
    if (this.state.tuiTabLimit === normalizedLimit) {
      return this.emit();
    }
    this.state = {
      ...this.state,
      tuiTabLimit: normalizedLimit,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setRemoteUiToken(remoteUiToken: string): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedToken = remoteUiToken.trim();
    if (this.state.remoteUiToken === normalizedToken) {
      return this.emit();
    }
    this.state = {
      ...this.state,
      remoteUiToken: normalizedToken,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setRemoteUiPort(remoteUiPort: number): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedPort = normalizeRemoteUiPort(remoteUiPort);
    if (this.state.remoteUiPort === normalizedPort) {
      return this.emit();
    }
    this.state = {
      ...this.state,
      remoteUiPort: normalizedPort,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  setRemoteUiStatus(remoteUiStatus: RemoteUiStatus): DesktopAppState {
    this.state = {
      ...this.state,
      remoteUiStatus,
      revision: this.state.revision + 1,
    };
    return this.emit();
  }

  async setEnableTransparency(enabled: boolean): Promise<DesktopAppState> {
    await this.initialize();
    if (this.state.enableTransparency === enabled) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      enableTransparency: enabled,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setTuiBgColor(color: string): Promise<DesktopAppState> {
    await this.initialize();
    const nextColor = normalizeSurfaceBgColor(color, this.state.tuiBgColor);
    if (this.state.tuiBgColor === nextColor) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      tuiBgColor: nextColor,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setSplitPanelBgColor(color: string): Promise<DesktopAppState> {
    await this.initialize();
    const nextColor = normalizeSurfaceBgColor(color, this.state.splitPanelBgColor);
    if (this.state.splitPanelBgColor === nextColor) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      splitPanelBgColor: nextColor,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async setLocale(locale: LocaleSetting): Promise<DesktopAppState> {
    await this.initialize();
    const nextLocale = normalizeLocale(locale);
    if (this.state.locale === nextLocale) {
      return structuredClone(this.state);
    }
    this.state = {
      ...this.state,
      locale: nextLocale,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  /* ── Runtime / model / provider settings ───────────────── */

  async refreshRuntime(workspaceId?: string): Promise<DesktopAppState> {
    await this.initialize();
    const resolvedWorkspaceId = (normalizeOptionalWorkspaceId(workspaceId) ?? this.state.selectedWorkspaceId) || undefined;
    if (!resolvedWorkspaceId) {
      return this.refreshGlobalRuntime();
    }

    const ws = this.workspaceRefFromState(resolvedWorkspaceId);
    if (!ws) {
      return this.withError(`Unknown workspace: ${resolvedWorkspaceId}`);
    }

    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.refreshRuntime(ws);
      this.runtimeByWorkspace.set(ws.workspaceId, snapshot);
      this.markExternalLaunchRuntimeFresh(ws.workspaceId);
      this.clearExtensionUiForWorkspace(ws.workspaceId);
      await this.reloadSessionsForWorkspace(ws.workspaceId);
      await this.refreshSessionCommandsForWorkspace(ws.workspaceId);
      return this.refreshState({ clearLastError: true });
    });
  }

  async prepareRuntimeForExternalLaunch(workspaceId: string): Promise<void> {
    await this.initialize();
    const ws = this.workspaceRefFromState(workspaceId);
    if (!ws) {
      return;
    }

    const now = Date.now();
    const freshUntil = this.externalLaunchRuntimeFreshUntilByWorkspace.get(ws.workspaceId) ?? 0;
    if (freshUntil > now) {
      logTuiPerf("main.store.prepareRuntimeForExternalLaunch.cacheHit", {
        workspaceId,
      }, {
        path: ws.path,
        freshForMs: freshUntil - now,
      });
      return;
    }

    const existingRefresh = this.externalLaunchRuntimeRefreshByWorkspace.get(ws.workspaceId);
    if (existingRefresh) {
      logTuiPerf("main.store.prepareRuntimeForExternalLaunch.joinPending", {
        workspaceId,
      }, {
        path: ws.path,
      });
      await existingRefresh;
      return;
    }

    const refresh = (async () => {
      logTuiPerf("main.store.prepareRuntimeForExternalLaunch.start", {
        workspaceId,
      }, {
        path: ws.path,
      });
      await this.driver.runtimeSupervisor.prepareRuntimeForExternalLaunch(ws);
      this.markExternalLaunchRuntimeFresh(ws.workspaceId);
      logTuiPerf("main.store.prepareRuntimeForExternalLaunch.done", {
        workspaceId,
      }, {
        path: ws.path,
      });
    })();

    this.externalLaunchRuntimeRefreshByWorkspace.set(ws.workspaceId, refresh);
    try {
      await refresh;
    } finally {
      if (this.externalLaunchRuntimeRefreshByWorkspace.get(ws.workspaceId) === refresh) {
        this.externalLaunchRuntimeRefreshByWorkspace.delete(ws.workspaceId);
      }
    }
  }

  async setSessionModel(target: WorkspaceSessionTarget, provider: string, modelId: string): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    return this.withErrorHandling(async () => {
      await this.driver.setSessionModel(sessionRef, { provider, modelId });
      this.updateSessionConfig(sessionRef, {
        ...this.sessionState.sessionConfigBySession.get(sessionKey(sessionRef)),
        provider,
        modelId,
      });
      return this.refreshState({
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
    });
  }

  async setDefaultModel(workspaceId: string | undefined, provider: string, modelId: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setDefaultModel(ws, { provider, modelId }),
    );
  }

  async setDefaultThinkingLevel(
    workspaceId: string | undefined,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setDefaultThinkingLevel(ws, thinkingLevel),
    );
  }

  async setSessionThinkingLevel(
    sessionRef: SessionRef,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      await this.driver.setSessionThinkingLevel(sessionRef, thinkingLevel);
      this.updateSessionConfig(sessionRef, {
        ...this.sessionState.sessionConfigBySession.get(sessionKey(sessionRef)),
        thinkingLevel,
      });
      return this.refreshState({
        selectedWorkspaceId: this.state.selectedWorkspaceId,
        selectedSessionId: this.state.selectedSessionId,
        clearLastError: true,
        markSelectedSessionViewed: false,
      });
    });
  }

  async loginProvider(
    workspaceId: string | undefined,
    providerId: string,
    callbacks: RuntimeLoginCallbacks,
  ): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(
      workspaceId,
      async (ws) => {
        const snapshot = await this.driver.runtimeSupervisor.login(ws, providerId, callbacks);
        return this.autoEnableModelsForConnectedProvider(workspaceId, providerId, snapshot);
      },
      { refreshWorkspaceRuntimes: !normalizeOptionalWorkspaceId(workspaceId) },
    );
  }

  async logoutProvider(workspaceId: string | undefined, providerId: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(
      workspaceId,
      (ws) => this.driver.runtimeSupervisor.logout(ws, providerId),
      { refreshWorkspaceRuntimes: !normalizeOptionalWorkspaceId(workspaceId) },
    );
  }

  async setProviderApiKey(
    workspaceId: string | undefined,
    providerId: string,
    apiKey: string,
  ): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(
      workspaceId,
      (ws) => this.driver.runtimeSupervisor.setProviderApiKey(ws, providerId, apiKey),
      { refreshWorkspaceRuntimes: !normalizeOptionalWorkspaceId(workspaceId) },
    );
  }


  async addMcpServer(input: McpServerConfigInput): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      const normalized = normalizeMcpServerInput(input);
      const now = new Date().toISOString();
      const server: McpServerConfig = {
        id: randomUUID(),
        ...normalized,
        authorized: !normalized.oauthEnabled,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      this.state = {
        ...this.state,
        mcpServers: [...this.state.mcpServers, server],
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  async updateMcpServer(serverId: string, input: McpServerConfigInput): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      const current = this.state.mcpServers.find((server) => server.id === serverId);
      if (!current) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }

      const normalized = normalizeMcpServerInput(input);
      const authSettingsChanged =
        current.url !== normalized.url || current.oauthEnabled !== normalized.oauthEnabled;
      if (!normalized.oauthEnabled || authSettingsChanged) {
        this.mcpOAuthTokensByServerId.delete(serverId);
      }

      const nextServer: McpServerConfig = {
        ...current,
        ...normalized,
        apiKey: normalized.apiKey,
        authorized: normalized.oauthEnabled ? (!authSettingsChanged && current.authorized) : true,
        ...(normalized.oauthEnabled && !authSettingsChanged && current.authorizedAt
          ? { authorizedAt: current.authorizedAt }
          : { authorizedAt: undefined }),
        lastAuthError: undefined,
        updatedAt: new Date().toISOString(),
      };

      this.state = {
        ...this.state,
        mcpServers: this.state.mcpServers.map((server) => server.id === serverId ? nextServer : server),
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  async removeMcpServer(serverId: string): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      if (!this.state.mcpServers.some((server) => server.id === serverId)) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }
      this.mcpOAuthTokensByServerId.delete(serverId);
      this.state = {
        ...this.state,
        mcpServers: this.state.mcpServers.filter((server) => server.id !== serverId),
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  async authorizeMcpServer(serverId: string, oauthManager: McpOAuthManager): Promise<DesktopAppState> {
    await this.initialize();
    const server = this.state.mcpServers.find((entry) => entry.id === serverId);
    if (!server) {
      return this.withError(`Unknown MCP server: ${serverId}`);
    }
    if (!server.oauthEnabled) {
      return this.withError(`${server.name} does not have OAuth enabled.`);
    }

    try {
      const tokens = await oauthManager.authorize(server);
      this.mcpOAuthTokensByServerId.set(serverId, tokens);
      const authorizedAt = new Date().toISOString();
      this.state = {
        ...this.state,
        mcpServers: this.state.mcpServers.map((entry) =>
          entry.id === serverId
            ? {
                ...entry,
                authorized: true,
                authorizedAt,
                lastAuthError: undefined,
                updatedAt: authorizedAt,
              }
            : entry,
        ),
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.mcpOAuthTokensByServerId.delete(serverId);
      this.state = {
        ...this.state,
        mcpServers: this.state.mcpServers.map((entry) =>
          entry.id === serverId
            ? {
                ...entry,
                authorized: false,
                authorizedAt: undefined,
                lastAuthError: message,
                updatedAt: new Date().toISOString(),
              }
            : entry,
        ),
        lastError: message,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    }
  }

  async setMcpServerEnabled(serverId: string, enabled: boolean): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      const current = this.state.mcpServers.find((server) => server.id === serverId);
      if (!current) {
        throw new Error(`Unknown MCP server: ${serverId}`);
      }

      const nextServer: McpServerConfig = {
        ...current,
        enabled,
        updatedAt: new Date().toISOString(),
      };

      this.state = {
        ...this.state,
        mcpServers: this.state.mcpServers.map((server) => server.id === serverId ? nextServer : server),
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  async setCliEnabled(cliType: string, enabled: boolean): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      const normalized = cliType.trim().toLowerCase();
      if (!normalized || !isKnownCliType(normalized)) {
        throw new Error(`Unknown CLI type: ${cliType}`);
      }

      if (this.state.cliEnablement[normalized] === enabled) {
        return structuredClone(this.state);
      }

      this.state = {
        ...this.state,
        cliEnablement: {
          ...this.state.cliEnablement,
          [normalized]: enabled,
        },
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  /* ── System Prompts ──────────────────────────────────── */

  async saveSystemPrompt(name: string, content: string, promptId?: string): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      const trimmedName = name.trim();
      const trimmedContent = content.trim();
      if (!trimmedName || !trimmedContent) {
        return this.withError("System prompt name and content are required.");
      }

      const now = new Date().toISOString();
      const existing = promptId
        ? this.state.systemPrompts.find((p) => p.id === promptId)
        : this.state.systemPrompts.find((p) => p.name === trimmedName);
      if (promptId && !existing) {
        return this.withError(`Unknown system prompt: ${promptId}`);
      }
      let nextPrompts: readonly SystemPromptRecord[];

      if (existing) {
        nextPrompts = this.state.systemPrompts.map((p) =>
          p.id === existing.id
            ? { ...p, name: trimmedName, content: trimmedContent, updatedAt: now }
            : p,
        );
      } else {
        // Create new prompt
        const newPrompt: SystemPromptRecord = {
          id: randomUUID(),
          name: trimmedName,
          content: trimmedContent,
          createdAt: now,
          updatedAt: now,
        };
        nextPrompts = [...this.state.systemPrompts, newPrompt];
      }

      this.state = {
        ...this.state,
        systemPrompts: nextPrompts,
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  async deleteSystemPrompt(promptId: string): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      const nextPrompts = this.state.systemPrompts.filter((p) => p.id !== promptId);
      const nextActiveId =
        this.state.activeSystemPromptId === promptId ? undefined : this.state.activeSystemPromptId;

      this.state = {
        ...this.state,
        systemPrompts: nextPrompts,
        activeSystemPromptId: nextActiveId,
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  async setActiveSystemPrompt(promptId: string | undefined): Promise<DesktopAppState> {
    await this.initialize();
    return this.withErrorHandling(async () => {
      if (promptId !== undefined && !this.state.systemPrompts.some((p) => p.id === promptId)) {
        return this.withError(`Unknown system prompt: ${promptId}`);
      }

      this.state = {
        ...this.state,
        activeSystemPromptId: promptId,
        lastError: undefined,
        revision: this.state.revision + 1,
      };
      await this.persistUiState();
      return this.emit();
    });
  }

  getActiveSystemPrompt(): string | undefined {
    if (!this.state.activeSystemPromptId) {
      return undefined;
    }
    const active = this.state.systemPrompts.find(
      (p) => p.id === this.state.activeSystemPromptId,
    );
    return active?.content;
  }

  async getMcpBridgeServers(): Promise<readonly RuntimeMcpBridgeServerConfig[]> {
    await this.initialize();
    return this.state.mcpServers.map((server) => {
      const headers: Record<string, string> = {};
      if (server.apiKey) {
        headers["x-api-key"] = server.apiKey;
      }

      const oauthTokens = this.mcpOAuthTokensByServerId.get(server.id);
      const accessToken = oauthTokens?.accessToken?.trim();
      if (accessToken) {
        headers.Authorization = `${oauthTokens?.tokenType?.trim() || "Bearer"} ${accessToken}`;
      }

      return {
        id: server.id,
        name: server.name,
        url: server.url,
        enabled: server.enabled,
        authorized: server.oauthEnabled ? Boolean(accessToken) : true,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    });
  }

  async setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setEnableSkillCommands(ws, enabled),
      { reloadSessions: true },
    );
  }

  async setScopedModelPatterns(workspaceId: string | undefined, patterns: readonly string[]): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setScopedModelPatterns(ws, patterns),
    );
  }

  private async autoEnableModelsForConnectedProvider(
    workspaceId: string | undefined,
    providerId: string,
    snapshot: RuntimeSnapshot,
  ): Promise<RuntimeSnapshot> {
    const providerModelPatterns = [...new Set(
      snapshot.models
        .filter((model) => model.available && model.providerId === providerId)
        .map((model) => `${model.providerId}/${model.modelId}`),
    )];
    if (providerModelPatterns.length === 0) {
      return snapshot;
    }

    const currentPatterns = snapshot.settings.enabledModelPatterns;
    if (currentPatterns.length === 0) {
      return snapshot;
    }

    const nextPatterns = mergeEnabledModelPatterns(currentPatterns, providerModelPatterns);
    if (nextPatterns.length === currentPatterns.length) {
      return snapshot;
    }

    const resolvedWorkspaceId = normalizeOptionalWorkspaceId(workspaceId);
    const ownerWorkspace = resolvedWorkspaceId ? this.workspaceRefFromState(resolvedWorkspaceId) : this.globalWorkspaceRef();
    if (!ownerWorkspace) {
      return snapshot;
    }
    return this.driver.runtimeSupervisor.setScopedModelPatterns(ownerWorkspace, nextPatterns);
  }

  async setSkillEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setSkillEnabled(ws, filePath, enabled),
      { reloadSessions: true },
    );
  }

  async removeSkill(workspaceId: string, filePath: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.removeSkill(ws, filePath),
      { reloadSessions: true },
    );
  }

  async setExtensionEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.setExtensionEnabled(ws, filePath, enabled),
      { reloadSessions: true },
    );
  }

  async removeExtension(workspaceId: string, filePath: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) =>
      this.driver.runtimeSupervisor.removeExtension(ws, filePath),
      { reloadSessions: true },
    );
  }

  async installPackage(workspaceId: string, source: string): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) => this.driver.runtimeSupervisor.installPackage(ws, source), {
      reloadSessions: true,
    });
  }

  async updatePackage(workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) => this.driver.runtimeSupervisor.updatePackage(ws, source, installScope), {
      reloadSessions: true,
    });
  }

  async removePackage(workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(workspaceId, (ws) => this.driver.runtimeSupervisor.removePackage(ws, source, installScope), {
      reloadSessions: true,
    });
  }

  async setPackageEnabled(workspaceId: string, source: string, enabled: boolean): Promise<DesktopAppState> {
    return this.withRuntimeUpdate(
      workspaceId,
      (ws) => this.driver.runtimeSupervisor.setPackageEnabled(ws, source, enabled),
      { reloadSessions: true },
    );
  }

  async searchPackages(query: string): Promise<readonly RuntimePackageSearchRecord[]> {
    await this.initialize();
    return this.driver.runtimeSupervisor.searchPackages(query);
  }

  private async withRuntimeUpdate(
    workspaceId: string | undefined,
    action: (ws: WorkspaceRef) => Promise<RuntimeSnapshot>,
    options?: {
      readonly reloadSessions?: boolean;
      readonly refreshWorkspaceRuntimes?: boolean;
    },
  ): Promise<DesktopAppState> {
    await this.initialize();
    const resolvedWorkspaceId = normalizeOptionalWorkspaceId(workspaceId);
    const ws = resolvedWorkspaceId ? this.workspaceRefFromState(resolvedWorkspaceId) : this.globalWorkspaceRef();
    if (!ws) {
      return this.withError(`Unknown workspace: ${resolvedWorkspaceId ?? globalRuntimeWorkspaceId}`);
    }

    return this.withErrorHandling(async () => {
      const snapshot = await action(ws);
      if (resolvedWorkspaceId) {
        this.runtimeByWorkspace.set(resolvedWorkspaceId, snapshot);
        this.markExternalLaunchRuntimeFresh(resolvedWorkspaceId);
        if (options?.reloadSessions) {
          this.clearExtensionUiForWorkspace(resolvedWorkspaceId);
          await this.reloadSessionsForWorkspace(resolvedWorkspaceId);
        }
        await this.refreshSessionCommandsForWorkspace(resolvedWorkspaceId);
      } else {
        this.applyGlobalRuntimeSnapshot(snapshot);
        if (options?.refreshWorkspaceRuntimes) {
          await this.refreshLoadedWorkspaceRuntimes();
        }
      }
      return this.refreshState({ clearLastError: true });
    });
  }

  private markExternalLaunchRuntimeFresh(workspaceId: string): void {
    this.externalLaunchRuntimeFreshUntilByWorkspace.set(
      workspaceId,
      Date.now() + EXTERNAL_LAUNCH_RUNTIME_REFRESH_TTL_MS,
    );
  }

  /* ── Internal infrastructure (AppStoreInternals) ───────── */

  private async initializeInternal(): Promise<void> {
    const persisted = await this.readUiState();
    try {
      this.state = {
        ...this.state,
        activeView: persisted.activeView ?? this.state.activeView,
        globalModelSettings: persisted.appGlobalModelSettings ?? this.state.globalModelSettings,
        mcpServers: persisted.mcpServers?.map(toPublicMcpServerConfig) ?? [],
        notificationPreferences: {
          ...this.state.notificationPreferences,
          ...persisted.notificationPreferences,
        },
        integratedTerminalShell: persisted.integratedTerminalShell ?? this.state.integratedTerminalShell,
        tuiTabLimit: normalizeTuiTabLimit(persisted.tuiTabLimit ?? this.state.tuiTabLimit),
        remoteUiPort: normalizeRemoteUiPort(persisted.remoteUiPort ?? this.state.remoteUiPort),
        remoteUiToken: persisted.remoteUiToken ?? this.state.remoteUiToken,
        lastViewedAtBySession: persisted.lastViewedAtBySession ?? {},
        workspaceOrder: persisted.workspaceOrder ?? [],
        sidebarCollapsed: persisted.sidebarCollapsed ?? this.state.sidebarCollapsed,
        sidebarWidth: normalizeSidebarWidth(persisted.sidebarWidth ?? this.state.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
        enableTransparency: persisted.enableTransparency ?? this.state.enableTransparency,
        tuiBgColor: normalizeSurfaceBgColor(
          persisted.tuiBgColor ?? this.state.tuiBgColor,
          DEFAULT_SURFACE_BG_COLOR,
        ),
        splitPanelBgColor: normalizeSurfaceBgColor(
          persisted.splitPanelBgColor ?? this.state.splitPanelBgColor,
          DEFAULT_SURFACE_BG_COLOR,
        ),
        locale: normalizeLocale(persisted.locale ?? this.state.locale),
        systemPrompts: persisted.systemPrompts ?? [],
        activeSystemPromptId: persisted.activeSystemPromptId || undefined,
        cliEnablement: mergeCliEnablement(persisted.cliEnablement ?? this.state.cliEnablement),
      };
      this.mcpOAuthTokensByServerId.clear();
      for (const server of persisted.mcpServers ?? []) {
        if (server.oauthTokens) {
          this.mcpOAuthTokensByServerId.set(server.id, server.oauthTokens);
        }
      }
      // Normal chat transcript persistence is retired; keep old files untouched.
      this.sessionState.lastViewedAtBySession.clear();
      for (const [key, viewedAt] of Object.entries(persisted.lastViewedAtBySession ?? {})) {
        if (viewedAt) {
          this.sessionState.lastViewedAtBySession.set(key, viewedAt);
        }
      }
      this.extensionCommandCompatibilityByWorkspace.clear();
      for (const [workspaceId, records] of restoreCompatibilityByWorkspace(
        persisted.extensionCommandCompatibilityByWorkspace,
      )) {
        this.extensionCommandCompatibilityByWorkspace.set(workspaceId, records);
      }
      const initialWorkspacePaths = this.initialWorkspacePaths.map((path) => path.trim()).filter(Boolean);
      const knownWorkspaces = await this.driver.listWorkspaces();
      const workspacesToSync = new Map<string, string | undefined>();

      for (const workspacePath of initialWorkspacePaths) {
        workspacesToSync.set(workspacePath, undefined);
      }

      for (const ws of knownWorkspaces.workspaces) {
        workspacesToSync.set(ws.path, ws.displayName);
      }

      await Promise.all(
        [...workspacesToSync.entries()].map(([workspacePath, displayName]) =>
          this.driver.syncWorkspace(workspacePath, displayName),
        ),
      );

      await this.refreshState({
        selectedWorkspaceId: persisted.selectedWorkspaceId,
        selectedSessionId: persisted.selectedSessionId,
        clearLastError: true,
        refreshWorktrees: true,
        hydrateSelectedSession: false,
        markSelectedSessionViewed: false,
      });
      const restoredSessionRef = this.selectedSessionRef();
      if (restoredSessionRef && persisted.selectedWorkspaceId && persisted.selectedSessionId) {
        this.restoredSelectedSessionKeysAwaitingSelection.add(sessionKey(restoredSessionRef));
      }
      this.startSelectedSessionHydration(restoredSessionRef, { markViewed: false });
    } catch (error) {
      this.state = {
        ...createEmptyDesktopAppState(),
        enableTransparency: persisted.enableTransparency ?? false,
        tuiBgColor: normalizeSurfaceBgColor(persisted.tuiBgColor, DEFAULT_SURFACE_BG_COLOR),
        splitPanelBgColor: normalizeSurfaceBgColor(persisted.splitPanelBgColor, DEFAULT_SURFACE_BG_COLOR),
        locale: normalizeLocale(persisted.locale),
        tuiTabLimit: normalizeTuiTabLimit(persisted.tuiTabLimit),
        remoteUiPort: normalizeRemoteUiPort(persisted.remoteUiPort),
        mcpServers: persisted.mcpServers?.map(toPublicMcpServerConfig) ?? [],
        cliEnablement: mergeCliEnablement(persisted.cliEnablement),
        lastError: error instanceof Error ? error.message : String(error),
        revision: 1,
      };
      await this.persistUiState();
      this.emit();
    }
  }

  async refreshState(options: RefreshStateOptions = {}): Promise<DesktopAppState> {
    this.refreshStateDepth += 1;
    try {
      const previousSelectedKey = this.currentSelectedSessionKey();
      const [workspacesSnapshot, sessionsSnapshot] = await Promise.all([
        this.driver.listWorkspaces(),
        this.driver.listSessions(),
      ]);
      const worktreeEntries = options.refreshWorktrees
        ? await worktree.syncAndListWorktrees(this, workspacesSnapshot.workspaces)
        : (await this.catalogStore.worktrees.listWorktrees()).worktrees;

      await this.pruneStaleSessionSubscriptions(sessionsSnapshot.sessions);
      await this.ensureSubscriptionsForSessions(sessionsSnapshot.sessions);

      const selectedWorkspaceId = resolveSelectedWorkspaceIdFromCatalog(
        options.selectedWorkspaceId ?? this.state.selectedWorkspaceId,
        workspacesSnapshot.workspaces,
      );
      const selectedSessionId = resolveSelectedSessionIdFromCatalog(
        selectedWorkspaceId,
        options.selectedSessionId ?? this.state.selectedSessionId,
        sessionsSnapshot.sessions,
      );

      if (selectedWorkspaceId && selectedSessionId && options.hydrateSelectedSession !== false) {
        const sessionRef = {
          workspaceId: selectedWorkspaceId,
          sessionId: selectedSessionId,
        };
        await this.ensureSessionRuntimeReady(sessionRef, { refreshSnapshot: true });
      }

      const workspaces = buildWorkspaceRecords(
        workspacesSnapshot.workspaces,
        worktreeEntries,
        sessionsSnapshot.sessions,
        this.sessionState.runningSinceBySession,
        this.sessionState.sessionConfigBySession,
        this.sessionState.lastViewedAtBySession,
      );
      const worktreesByWorkspace = buildWorktreeRecords(workspacesSnapshot.workspaces, worktreeEntries);
      const liveWorkspaceIds = new Set(workspaces.map((w) => w.id));
      for (const wsId of this.runtimeByWorkspace.keys()) {
        if (!liveWorkspaceIds.has(wsId)) {
          this.runtimeByWorkspace.delete(wsId);
        }
      }
      for (const workspaceId of this.extensionCommandCompatibilityByWorkspace.keys()) {
        if (!liveWorkspaceIds.has(workspaceId)) {
          this.extensionCommandCompatibilityByWorkspace.delete(workspaceId);
        }
      }

      if (selectedWorkspaceId && !this.runtimeByWorkspace.has(selectedWorkspaceId)) {
        await this.ensureRuntimeLoaded(selectedWorkspaceId, workspacesSnapshot.workspaces);
      }
      const secondaryWorkspacesToLoad = workspacesSnapshot.workspaces
        .filter((workspace) => workspace.workspaceId !== selectedWorkspaceId)
        .filter((workspace) => !this.runtimeByWorkspace.has(workspace.workspaceId));
      const secondaryRuntimeLoads = await Promise.allSettled(
        secondaryWorkspacesToLoad.map((workspace) => this.ensureRuntimeLoaded(workspace.workspaceId, workspacesSnapshot.workspaces)),
      );
      secondaryRuntimeLoads.forEach((result, index) => {
        if (result.status === "fulfilled") {
          return;
        }
        const failedWorkspace = secondaryWorkspacesToLoad[index];
        console.warn(
          `[pi-gui] Failed to preload runtime for ${failedWorkspace?.path ?? "unknown workspace"}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
      });
      for (const runtime of this.runtimeByWorkspace.values()) {
        pruneCompatibilityForRuntimeSnapshot(this.extensionCommandCompatibilityByWorkspace, runtime);
      }
      const globalRuntime = await this.loadGlobalRuntimeSnapshot();
      const globalModelSettings = globalRuntime
        ? toModelSettingsSnapshot(globalRuntime.settings)
        : await this.loadLiveGlobalModelSettings(
            workspacesSnapshot.workspaces,
            selectedWorkspaceId || workspacesSnapshot.workspaces[0]?.workspaceId,
          );
      const runtimeByWorkspace = this.serializeRuntimeState();

      const activeView = options.activeView ?? this.state.activeView;
      this.state = {
        ...this.state,
        workspaces,
        worktreesByWorkspace,
        selectedWorkspaceId,
        selectedSessionId,
        activeView,
        runtimeByWorkspace,
        globalRuntime,
        sessionCommandsBySession: mapToRecord(this.sessionState.sessionCommandsBySession),
        sessionExtensionUiBySession: this.serializeSessionExtensionUiState(),
        extensionCommandCompatibilityByWorkspace: serializeCompatibilityByWorkspace(this.extensionCommandCompatibilityByWorkspace),
        lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
        workspaceOrder: this.state.workspaceOrder,
        globalModelSettings,
        lastError: this.resolveSelectedSessionError(selectedWorkspaceId, selectedSessionId, options.clearLastError),
        revision: this.state.revision + 1,
      };

      if (options.markSelectedSessionViewed ?? true) {
        this.markSelectedSessionViewedIfVisible();
      }

      this.sessionFileWatcher.retainWorkspaces(
        workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          path: workspace.path,
          displayName: workspace.name,
        })),
      );

      await this.persistUiState();
      const snapshot = this.emit();
      return snapshot;
    } finally {
      this.refreshStateDepth = Math.max(0, this.refreshStateDepth - 1);
    }
  }

  private async pruneStaleSessionSubscriptions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    const activeKeys = new Set(sessions.map((session) => sessionKey(session.sessionRef)));
    this.sessionState.prune(activeKeys);
  }

  private async ensureSubscriptionsForSessions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      await this.ensureSessionSubscription(session.sessionRef);
    }
  }

  async ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined> {
    return this.ensureSessionRuntimeReady(sessionRef);
  }

  private async ensureSessionRuntimeReady(
    sessionRef: SessionRef,
    options: { readonly refreshSnapshot?: boolean } = {},
  ): Promise<SessionSnapshot | undefined> {
    const key = sessionKey(sessionRef);
    let snapshot: SessionSnapshot | undefined;
    const hasSubscription = this.sessionState.sessionSubscriptions.has(key);

    if (!hasSubscription) {
      logTuiPerf("main.store.sessionRuntime.openStart", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      }, {
        refreshSnapshot: options.refreshSnapshot ?? false,
      });
      snapshot = await this.driver.openSession(sessionRef);
      logTuiPerf("main.store.sessionRuntime.openDone", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      }, {
        status: snapshot.status,
      });
      this.updateSessionConfig(sessionRef, snapshot.config);
    } else if (options.refreshSnapshot) {
      logTuiPerf("main.store.sessionRuntime.snapshotRefreshStart", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      });
      snapshot = await this.driver.getSessionSnapshot(sessionRef);
      logTuiPerf("main.store.sessionRuntime.snapshotRefreshDone", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      }, {
        status: snapshot.status,
      });
      this.updateSessionConfig(sessionRef, snapshot.config);
    } else {
      logTuiPerf("main.store.sessionRuntime.subscriptionHit", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      });
    }
    logTuiPerf("main.store.sessionRuntime.subscribeStart", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    });
    await this.ensureSessionSubscribed(sessionRef);
    logTuiPerf("main.store.sessionRuntime.refreshCommandsStart", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    });
    await this.refreshSessionCommands(sessionRef);
    logTuiPerf("main.store.sessionRuntime.ready", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    });
    return snapshot;
  }

  async ensureSessionSubscription(sessionRef: SessionRef): Promise<void> {
    if (!this.sessionState.sessionSubscriptions.has(sessionKey(sessionRef))) {
      const snapshot = await this.driver.openSession(sessionRef);
      this.updateSessionConfig(sessionRef, snapshot.config);
    }
    await this.ensureSessionSubscribed(sessionRef);
  }

  private async ensureRuntimeLoaded(
    workspaceId: string,
    workspaces?: readonly { workspaceId: string; path: string; displayName: string }[],
  ): Promise<void> {
    if (this.runtimeByWorkspace.has(workspaceId)) {
      logTuiPerf("main.store.runtime.cacheHit", {
        workspaceId,
      });
      return;
    }

    const ws =
      this.workspaceRefFromState(workspaceId) ??
      workspaces?.find((entry) => entry.workspaceId === workspaceId);
    if (!ws) {
      return;
    }

    logTuiPerf("main.store.runtime.loadStart", {
      workspaceId,
    }, {
      path: ws.path,
    });
    const snapshot = await this.driver.runtimeSupervisor.getRuntimeSnapshot({
      workspaceId: ws.workspaceId,
      path: ws.path,
      displayName: ws.displayName,
    });
    this.runtimeByWorkspace.set(workspaceId, snapshot);
    this.markExternalLaunchRuntimeFresh(workspaceId);
    logTuiPerf("main.store.runtime.loadDone", {
      workspaceId,
    }, {
      modelCount: snapshot.models.length,
      providerCount: snapshot.providers.length,
    });
  }

  async ensureSessionSubscribed(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionState.sessionSubscriptions.has(key)) {
      return;
    }

    const unsubscribe = this.driver.subscribe(sessionRef, (event) => {
      void this.handleSessionEvent(event, key);
    });
    this.sessionState.sessionSubscriptions.set(key, unsubscribe);
  }

  private migrateSessionSubscriptionKey(sourceKey: string, targetKey: string): void {
    if (sourceKey === targetKey) {
      return;
    }

    const unsubscribe = this.sessionState.sessionSubscriptions.get(sourceKey);
    if (!unsubscribe) {
      return;
    }

    if (this.sessionState.sessionSubscriptions.has(targetKey)) {
      unsubscribe();
      this.sessionState.sessionSubscriptions.delete(sourceKey);
      return;
    }

    this.sessionState.sessionSubscriptions.delete(sourceKey);
    this.sessionState.sessionSubscriptions.set(targetKey, unsubscribe);
  }

  async cancelPendingDialogsForSession(
    sessionRef: SessionRef,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    if (!options.force && this.shouldKeepSessionDialogs(sessionRef)) {
      return;
    }
    const key = sessionKey(sessionRef);
    const uiState = this.sessionState.extensionUiBySession.get(key);
    if (!uiState || uiState.pendingDialogs.length === 0) {
      return;
    }

    const pendingDialogs = [...uiState.pendingDialogs];
    uiState.pendingDialogs = [];
    this.state = this.syncDerivedSessionState(
      {
        ...this.state,
        revision: this.state.revision + 1,
      },
      sessionRef,
    );
    this.emit();
    await Promise.all(
      pendingDialogs.map((dialog) =>
        this.driver.respondToHostUiRequest(sessionRef, {
          requestId: dialog.requestId,
          cancelled: true,
        } satisfies HostUiResponse),
      ),
    );
  }

  async cancelPendingDialogsWithoutVisibleWindow(
    isSessionVisible: (sessionRef: SessionRef) => boolean,
  ): Promise<void> {
    await this.initialize();
    const pendingSessionRefs: SessionRef[] = [];
    for (const workspace of this.state.workspaces) {
      for (const session of workspace.sessions) {
        const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
        const uiState = this.sessionState.extensionUiBySession.get(sessionKey(sessionRef));
        if (uiState && uiState.pendingDialogs.length > 0 && !isSessionVisible(sessionRef)) {
          pendingSessionRefs.push(sessionRef);
        }
      }
    }

    await Promise.all(
      pendingSessionRefs.map((sessionRef) => this.cancelPendingDialogsForSession(sessionRef, { force: true })),
    );
  }

  async respondToHostUiRequest(
    sessionRef: SessionRef,
    response: HostUiResponse,
  ): Promise<DesktopAppState> {
    const key = sessionKey(sessionRef);
    const uiState = this.sessionState.extensionUiBySession.get(key);
    if (uiState) {
      uiState.pendingDialogs = uiState.pendingDialogs.filter((dialog) => dialog.requestId !== response.requestId);
    }

    return this.withErrorHandling(async () => {
      await this.driver.respondToHostUiRequest(sessionRef, response);
      return this.refreshState({ clearLastError: true });
    });
  }

  private async refreshSessionCommands(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    logTuiPerf("main.store.sessionCommands.loadStart", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    });
    const commands = await this.driver.getSessionCommands(sessionRef);
    this.sessionState.sessionCommandsBySession.set(key, [...commands]);
    logTuiPerf("main.store.sessionCommands.loadDone", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    }, {
      commandCount: commands.length,
    });
  }

  async refreshSessionCommandsFor(sessionRef: SessionRef): Promise<void> {
    await this.refreshSessionCommands(sessionRef);
  }

  getLearnedRuntimeCommandCompatibility(
    workspaceId: string,
    command: RuntimeCommandRecord,
  ): ExtensionCommandCompatibilityRecord | undefined {
    return getLearnedCommandCompatibility(this.extensionCommandCompatibilityByWorkspace, workspaceId, command);
  }

  beginRuntimeCommandExecution(sessionRef: SessionRef, command: RuntimeCommandRecord): void {
    this.pendingRuntimeCommandsBySession.set(sessionKey(sessionRef), { command });
  }

  finishRuntimeCommandExecution(
    sessionRef: SessionRef,
    timestamp = new Date().toISOString(),
  ): PendingRuntimeCommandExecution | undefined {
    const key = sessionKey(sessionRef);
    const pending = this.pendingRuntimeCommandsBySession.get(key);
    if (!pending) {
      return undefined;
    }

    this.pendingRuntimeCommandsBySession.delete(key);
    if (!pending.blockedMessage) {
      recordLearnedCommandCompatibility(this.extensionCommandCompatibilityByWorkspace, sessionRef.workspaceId, {
        commandName: pending.command.name,
        extensionPath: pending.command.sourceInfo.path,
        status: "supported",
        message: "Observed working in Bimanus.",
        capability: "gui-safe",
        updatedAt: timestamp,
      });
    }

    return pending;
  }

  clearExtensionUiForSession(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (!this.sessionState.extensionUiBySession.has(key)) {
      return;
    }

    this.sessionState.extensionUiBySession.delete(key);
    this.state = this.syncDerivedSessionState(this.state, sessionRef);
  }

  private async refreshSessionCommandsForWorkspace(workspaceId: string): Promise<void> {
    const sessionRefs = this.sessionRefsForWorkspace(workspaceId);
    await Promise.all(sessionRefs.map((sessionRef) => this.refreshSessionCommands(sessionRef)));
  }

  private async reloadSessionsForWorkspace(workspaceId: string): Promise<void> {
    const sessionRefs = this.sessionRefsForWorkspace(workspaceId);
    await Promise.all(sessionRefs.map((sessionRef) => this.driver.reloadSession(sessionRef)));
  }

  private clearExtensionUiForWorkspace(workspaceId: string): void {
    for (const sessionRef of this.sessionRefsForWorkspace(workspaceId)) {
      this.clearExtensionUiForSession(sessionRef);
    }
  }

  private reportExtensionCompatibilityIssue(
    sessionRef: SessionRef,
    issue: Extract<SessionDriverEvent, { type: "extensionCompatibilityIssue" }>["issue"],
    timestamp: string,
  ): void {
    const key = sessionKey(sessionRef);
    const pending = this.pendingRuntimeCommandsBySession.get(key);
    if (pending) {
      const message = `/${pending.command.name} requires terminal-only ${formatCapabilityLabel(issue.capability)} and is not supported in Bimanus yet. Use pi in the terminal for this command.`;
      pending.blockedMessage = message;
      recordLearnedCommandCompatibility(this.extensionCommandCompatibilityByWorkspace, sessionRef.workspaceId, {
        commandName: pending.command.name,
        extensionPath: pending.command.sourceInfo.path,
        status: "terminal-only",
        message,
        capability: issue.capability,
        updatedAt: timestamp,
      });
      this.sessionState.sessionErrorsBySession.set(key, message);
      return;
    }

    const fingerprint = `${issue.extensionPath ?? "<unknown>"}:${issue.eventName ?? "<unknown>"}:${issue.capability}`;
    const seen = this.reportedCompatibilityIssuesBySession.get(key) ?? new Set<string>();
    if (seen.has(fingerprint)) {
      return;
    }

    seen.add(fingerprint);
    this.reportedCompatibilityIssuesBySession.set(key, seen);
    this.sessionState.sessionErrorsBySession.set(key, issue.message);
  }

  private sessionRefsForWorkspace(workspaceId: string): SessionRef[] {
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return [];
    }

    return workspace.sessions
      .map((session) => ({
        workspaceId,
        sessionId: session.id,
      }))
      .filter((sessionRef) => {
        const key = sessionKey(sessionRef);
        return (
          (this.state.selectedWorkspaceId === workspaceId && this.state.selectedSessionId === sessionRef.sessionId) ||
          this.sessionState.sessionCommandsBySession.has(key) ||
          this.sessionState.sessionSubscriptions.has(key)
        );
      });
  }

  private getOrCreateExtensionUiState(sessionRef: SessionRef) {
    const key = sessionKey(sessionRef);
    const existing = this.sessionState.extensionUiBySession.get(key);
    if (existing) {
      return existing;
    }

    const created = createEmptyExtensionUiState();
    this.sessionState.extensionUiBySession.set(key, created);
    return created;
  }

  private applyHostUiRequest(event: Extract<SessionDriverEvent, { type: "hostUiRequest" }>): void {
    const key = sessionKey(event.sessionRef);
    if (event.request.kind === "reset") {
      this.sessionState.extensionUiBySession.delete(key);
      return;
    }

    const uiState = this.getOrCreateExtensionUiState(event.sessionRef);
    applyHostUiRequestToExtensionUiState(uiState, event.request);

    switch (event.request.kind) {
      case "editorText":
        break;
      default:
        if (isExtensionUiDialogRequest(event.request)) {
          const dialog = event.request;
          uiState.pendingDialogs = [
            ...uiState.pendingDialogs.filter((entry) => entry.requestId !== dialog.requestId),
            dialog,
          ];
        }
        break;
    }
  }

  private async handleSessionEvent(event: SessionDriverEvent, subscriptionKey = sessionKey(event.sessionRef)): Promise<void> {
    const key = sessionKey(event.sessionRef);
    if (subscriptionKey !== key) {
      this.migrateSessionSubscriptionKey(subscriptionKey, key);
    }
    const knownSession = this.sessionFromState(event.sessionRef);
    const shouldFollowSessionMutation = subscriptionKey !== key && this.currentSelectedSessionKey() === subscriptionKey;
    let refreshedFollowedSession = false;
    if (
      !knownSession &&
      (event.type === "sessionOpened" ||
        event.type === "sessionUpdated" ||
        event.type === "runCompleted" ||
        event.type === "hostUiRequest")
    ) {
      if (this.refreshStateDepth === 0) {
        await this.refreshState({
          selectedWorkspaceId:
            this.state.selectedWorkspaceId === event.sessionRef.workspaceId
              ? event.sessionRef.workspaceId
              : this.state.selectedWorkspaceId,
          selectedSessionId: shouldFollowSessionMutation ? event.sessionRef.sessionId : this.state.selectedSessionId,
          clearLastError: true,
        });
        refreshedFollowedSession = shouldFollowSessionMutation;
      }
    }

    switch (event.type) {
      case "sessionOpened":
      case "runCompleted":
        if (event.type === "runCompleted") {
          this.updateRunSuppression(event.sessionRef, false);
        }
        this.updateSessionConfig(event.sessionRef, event.snapshot.config);
        await this.refreshSessionCommands(event.sessionRef);
        break;
      case "sessionUpdated":
        this.updateSessionConfig(event.sessionRef, event.snapshot.config);
        if (event.snapshot.status === "running" && event.snapshot.runningRunId) {
          this.updateRunSuppression(event.sessionRef, true);
        } else if (event.snapshot.status !== "running") {
          this.updateRunSuppression(event.sessionRef, false);
          await this.refreshSessionCommands(event.sessionRef);
        }
        break;
      case "runFailed":
        this.updateRunSuppression(event.sessionRef, false);
        this.state = {
          ...this.state,
          lastError: event.error.message,
        };
        await this.refreshSessionCommands(event.sessionRef);
        break;
      case "extensionCompatibilityIssue":
        this.reportExtensionCompatibilityIssue(event.sessionRef, event.issue, event.timestamp);
        break;
      case "sessionClosed":
        this.updateRunSuppression(event.sessionRef, false);
        this.sessionState.extensionUiBySession.delete(key);
        this.sessionState.sessionCommandsBySession.delete(key);
        this.clearPendingAutoTitle(event.sessionRef);
        this.pendingRuntimeCommandsBySession.delete(key);
        this.reportedCompatibilityIssuesBySession.delete(key);
        break;
      case "toolStarted":
      case "toolUpdated":
      case "toolFinished":
        break;
      case "hostUiRequest":
        this.applyHostUiRequest(event);
        break;
      case "assistantDelta":
        return;
      default:
        break;
    }

    if (event.type === "sessionClosed") {
      this.sessionState.sessionSubscriptions.get(key)?.();
      this.sessionState.sessionSubscriptions.delete(key);
    }

    if (event.type === "runFailed") {
      this.sessionState.sessionErrorsBySession.set(key, event.error.message);
    } else if (event.type === "runCompleted" || event.type === "sessionClosed") {
      this.sessionState.sessionErrorsBySession.delete(key);
    }

    this.state = applySessionEventState(
      this.state,
      event,
      this.sessionState.runningSinceBySession,
      this.sessionState.lastViewedAtBySession,
    );
    this.markSessionViewedIfActivelyViewed(event.sessionRef);
    this.state = this.syncDerivedSessionState(this.state, event.sessionRef);
    if (shouldFollowSessionMutation && event.type !== "sessionClosed") {
      this.applyFastSessionSelection(event.sessionRef);
      if (!refreshedFollowedSession) {
        this.startSelectedSessionHydration(event.sessionRef);
      }
    }
    if (event.type === "runCompleted" || event.type === "runFailed" || event.type === "sessionClosed") {
      await this.persistUiState();
    } else if (event.type !== "hostUiRequest") {
      this.schedulePersistUiState();
    }
    const snapshot = this.emit();
    await this.emitSessionEvent(event, snapshot);
  }

  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined {
    const ws = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!ws) {
      return undefined;
    }

    return {
      workspaceId: ws.id,
      path: ws.path,
      displayName: ws.name,
    };
  }

  private async loadLiveGlobalModelSettings(
    workspaces: readonly { workspaceId: string; path: string; displayName: string }[],
    preferredWorkspaceId?: string,
  ): Promise<ModelSettingsSnapshot> {
    try {
      return await this.driver.runtimeSupervisor.getGlobalModelSettings(this.globalWorkspaceRef());
    } catch (error) {
      console.warn(`[pi-gui] Failed to load global model settings: ${normalizeErrorMessage(error)}`);
    }

    const fallbackWorkspace =
      (preferredWorkspaceId ? workspaces.find((entry) => entry.workspaceId === preferredWorkspaceId) : undefined) ?? workspaces[0];
    if (!fallbackWorkspace) {
      return this.state.globalModelSettings;
    }

    try {
      return await this.driver.runtimeSupervisor.getGlobalModelSettings({
        workspaceId: fallbackWorkspace.workspaceId,
        path: fallbackWorkspace.path,
        displayName: fallbackWorkspace.displayName,
      });
    } catch (error) {
      console.warn(`[pi-gui] Failed to load fallback model settings: ${normalizeErrorMessage(error)}`);
      return this.state.globalModelSettings;
    }
  }

  private globalWorkspaceRef(): WorkspaceRef {
    return {
      workspaceId: globalRuntimeWorkspaceId,
      path: this.getAgentDir(),
      displayName: "Global Settings",
    };
  }

  private async loadGlobalRuntimeSnapshot(): Promise<RuntimeSnapshot | undefined> {
    if (this.globalRuntime) {
      return this.globalRuntime;
    }

    try {
      const snapshot = await this.driver.runtimeSupervisor.getRuntimeSnapshot(this.globalWorkspaceRef());
      this.applyGlobalRuntimeSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      console.warn(`[pi-gui] Failed to load global runtime settings: ${normalizeErrorMessage(error)}`);
      return undefined;
    }
  }

  private async refreshGlobalRuntime(): Promise<DesktopAppState> {
    return this.withErrorHandling(async () => {
      const snapshot = await this.driver.runtimeSupervisor.refreshRuntime(this.globalWorkspaceRef());
      this.applyGlobalRuntimeSnapshot(snapshot);
      await this.refreshLoadedWorkspaceRuntimes();
      return this.refreshState({ clearLastError: true });
    });
  }

  private applyGlobalRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
    this.globalRuntime = snapshot;
    this.state = {
      ...this.state,
      globalRuntime: snapshot,
      globalModelSettings: toModelSettingsSnapshot(snapshot.settings),
    };
  }

  private async refreshLoadedWorkspaceRuntimes(): Promise<void> {
    const workspaces = this.state.workspaces
      .map((workspace) => this.workspaceRefFromState(workspace.id))
      .filter((workspace): workspace is WorkspaceRef => Boolean(workspace));
    const results = await Promise.allSettled(
      workspaces.map(async (workspace) => {
        const snapshot = await this.driver.runtimeSupervisor.refreshRuntime(workspace);
        this.runtimeByWorkspace.set(workspace.workspaceId, snapshot);
        this.markExternalLaunchRuntimeFresh(workspace.workspaceId);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }
      const failedWorkspace = workspaces[index];
      console.warn(
        `[pi-gui] Failed to refresh runtime for ${failedWorkspace?.path ?? "unknown workspace"}: ${normalizeErrorMessage(
          result.reason,
        )}`,
      );
    });
  }

  async buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined> {
    void workspaceId;
    const activePrompt = this.getActiveSystemPrompt();
    if (!activePrompt) {
      return undefined;
    }
    return {
      appendSystemPrompt: activePrompt,
    };
  }

  private serializeRuntimeState(): Record<string, RuntimeSnapshot> {
    return mapToRecord(this.runtimeByWorkspace);
  }

  private async serializeRuntimeStateForCurrentWorkspaces(): Promise<Record<string, RuntimeSnapshot>> {
    return this.serializeRuntimeState();
  }

  private serializeSessionExtensionUiState() {
    return Object.fromEntries(
      [...this.sessionState.extensionUiBySession.entries()].map(([key, value]) => [key, serializeExtensionUiState(value)] as const),
    );
  }

  private syncDerivedSessionState(state: DesktopAppState, sessionRef: SessionRef): DesktopAppState {
    const key = sessionKey(sessionRef);
    const serializedExtensionUi = this.sessionState.extensionUiBySession.get(key);

    return {
      ...state,
      sessionCommandsBySession: updateRecordValue(
        state.sessionCommandsBySession,
        key,
        this.sessionState.sessionCommandsBySession.get(key),
      ),
      sessionExtensionUiBySession: updateRecordValue(
        state.sessionExtensionUiBySession,
        key,
        serializedExtensionUi ? serializeExtensionUiState(serializedExtensionUi) : undefined,
      ),
      extensionCommandCompatibilityByWorkspace: serializeCompatibilityByWorkspace(this.extensionCommandCompatibilityByWorkspace),
      lastViewedAtBySession: updateRecordValue(
        state.lastViewedAtBySession,
        key,
        this.sessionState.lastViewedAtBySession.get(key),
      ),
      lastError: this.resolveSelectedSessionError(state.selectedWorkspaceId, state.selectedSessionId, false),
    };
  }

  selectedSessionRef(): SessionRef | undefined {
    if (!this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return undefined;
    }

    return toSessionRef({
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    });
  }

  private selectedSessionRefForView(view: DesktopAppViewState): SessionRef | undefined {
    const selectedWorkspaceId = this.resolveViewWorkspaceId(view.selectedWorkspaceId, this.state);
    const selectedSessionId = this.resolveViewSessionId(selectedWorkspaceId, view.selectedSessionId, this.state);
    if (!selectedWorkspaceId || !selectedSessionId) {
      return undefined;
    }

    return toSessionRef({
      workspaceId: selectedWorkspaceId,
      sessionId: selectedSessionId,
    });
  }

  private resolveViewWorkspaceId(
    preferredWorkspaceId: string | undefined,
    state: DesktopAppState,
  ): string {
    if (preferredWorkspaceId && state.workspaces.some((workspace) => workspace.id === preferredWorkspaceId)) {
      return preferredWorkspaceId;
    }
    if (state.selectedWorkspaceId && state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)) {
      return state.selectedWorkspaceId;
    }
    return state.workspaces[0]?.id ?? "";
  }

  private resolveViewSessionId(
    selectedWorkspaceId: string,
    preferredSessionId: string | undefined,
    state: DesktopAppState,
  ): string {
    const workspace = state.workspaces.find((entry) => entry.id === selectedWorkspaceId);
    if (!workspace) {
      return "";
    }
    if (preferredSessionId && workspace.sessions.some((session) => session.id === preferredSessionId)) {
      return preferredSessionId;
    }
    if (state.selectedWorkspaceId === selectedWorkspaceId && workspace.sessions.some((session) => session.id === state.selectedSessionId)) {
      return state.selectedSessionId;
    }
    return workspace.sessions[0]?.id ?? "";
  }

  sessionFromState(sessionRef: SessionRef) {
    return this.state.workspaces
      .find((w) => w.id === sessionRef.workspaceId)
      ?.sessions.find((s) => s.id === sessionRef.sessionId);
  }

  private async readUiState(): Promise<LegacyPersistedUiState> {
    return readPersistedUiState(this.uiStateFilePath);
  }

  async persistUiState(): Promise<void> {
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
      this.persistUiStateTimer = undefined;
    }
    const payload: PersistedUiState = {
      selectedWorkspaceId: this.state.selectedWorkspaceId || undefined,
      selectedSessionId: this.state.selectedSessionId || undefined,
      activeView: this.state.activeView,
      extensionCommandCompatibilityByWorkspace: serializeCompatibilityByWorkspace(this.extensionCommandCompatibilityByWorkspace),
      notificationPreferences: this.state.notificationPreferences,
      integratedTerminalShell: this.state.integratedTerminalShell || undefined,
      tuiTabLimit: this.state.tuiTabLimit,
      remoteUiPort: this.state.remoteUiPort,
      remoteUiToken: this.state.remoteUiToken || undefined,
      lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
      workspaceOrder: this.state.workspaceOrder.length > 0 ? this.state.workspaceOrder : undefined,
      appGlobalModelSettings: hasStoredModelSettings(this.state.globalModelSettings) ? this.state.globalModelSettings : undefined,
      mcpServers: this.state.mcpServers.map((server) =>
        toPersistedMcpServerConfig(server, this.mcpOAuthTokensByServerId.get(server.id)),
      ),
      sidebarCollapsed: this.state.sidebarCollapsed || undefined,
      sidebarWidth: this.state.sidebarWidth,
      enableTransparency: this.state.enableTransparency,
      tuiBgColor: this.state.tuiBgColor,
      splitPanelBgColor: this.state.splitPanelBgColor,
      locale: this.state.locale,
      systemPrompts: this.state.systemPrompts.length > 0 ? this.state.systemPrompts : undefined,
      activeSystemPromptId: this.state.activeSystemPromptId || undefined,
      cliEnablement: this.state.cliEnablement,
    };

    await writePersistedUiState(this.uiStateFilePath, payload);
  }

  schedulePersistUiState(): void {
    if (this.persistUiStateTimer) {
      clearTimeout(this.persistUiStateTimer);
    }

    this.persistUiStateTimer = setTimeout(() => {
      this.persistUiStateTimer = undefined;
      void this.persistUiState();
    }, 250);
  }

  private currentSelectedSessionKey(): string {
    return this.state.selectedWorkspaceId && this.state.selectedSessionId
      ? sessionKey({
          workspaceId: this.state.selectedWorkspaceId,
          sessionId: this.state.selectedSessionId,
        })
      : "";
  }

  private isSelectedSession(sessionRef: SessionRef): boolean {
    const selected = this.selectedSessionRef();
    return Boolean(
      selected &&
      selected.workspaceId === sessionRef.workspaceId &&
      selected.sessionId === sessionRef.sessionId,
    );
  }

  emit(): DesktopAppState {
    return this.broadcast.emit();
  }

  /**
   * Track whether a session is running and suppress/release the file
   * watcher for its workspace accordingly.
   *
   * When at least one session in a workspace is running, the file watcher
   * is suppressed — the main process already receives events directly
   * from the driver subscription, so the `.jsonl` file watcher is
   * redundant and only causes I/O storms.
   */
  private updateRunSuppression(sessionRef: SessionRef, isRunning: boolean): void {
    const key = sessionKey(sessionRef);
    const wasRunning = this.runningSessionKeys.has(key);
    if (isRunning === wasRunning) {
      return;
    }
    const workspaceId = sessionRef.workspaceId;
    if (isRunning) {
      this.runningSessionKeys.add(key);
      const count = (this.runningSessionCountByWorkspace.get(workspaceId) ?? 0) + 1;
      this.runningSessionCountByWorkspace.set(workspaceId, count);
      if (count === 1) {
        this.sessionFileWatcher.suppressWorkspaceId(workspaceId);
      }
    } else {
      this.runningSessionKeys.delete(key);
      const count = Math.max(0, (this.runningSessionCountByWorkspace.get(workspaceId) ?? 0) - 1);
      if (count === 0) {
        this.runningSessionCountByWorkspace.delete(workspaceId);
        this.sessionFileWatcher.releaseWorkspaceId(workspaceId);
      } else {
        this.runningSessionCountByWorkspace.set(workspaceId, count);
      }
    }
  }

  handleWindowActivation(): void {
    if (!this.markSelectedSessionViewedIfVisible()) {
      return;
    }

    this.schedulePersistUiState();
    this.emit();
  }

  private async emitSessionEvent(event: SessionDriverEvent, snapshot: DesktopAppState): Promise<void> {
    await this.broadcast.emitSessionEvent(event, snapshot);
  }

  async withError(error: unknown): Promise<DesktopAppState> {
    const message = error instanceof Error ? error.message : String(error);
    const sessionRef = this.selectedSessionRef();
    if (sessionRef) {
      this.sessionState.sessionErrorsBySession.set(sessionKey(sessionRef), message);
    }
    this.state = {
      ...this.state,
      lastError: message,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async withErrorHandling(fn: () => Promise<DesktopAppState>): Promise<DesktopAppState> {
    try {
      return await fn();
    } catch (error) {
      return this.withError(error);
    }
  }

  private applyFastSessionSelection(sessionRef: SessionRef): DesktopAppState {
    this.restoredSelectedSessionKeysAwaitingSelection.delete(sessionKey(sessionRef));
    this.state = {
      ...this.state,
      selectedWorkspaceId: sessionRef.workspaceId,
      selectedSessionId: sessionRef.sessionId,
      activeView: "threads",
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    this.markSessionViewed(sessionRef);
    this.schedulePersistUiState();
    return this.emit();
  }

  private async hydrateSelectedSessionAfterSelection(
    sessionRef: SessionRef,
    selectionEpoch: number,
    options: { readonly markViewed?: boolean } = {},
  ): Promise<void> {
    const runtimeMissing = !this.runtimeByWorkspace.has(sessionRef.workspaceId);
    logTuiPerf("main.store.hydrate.start", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    }, {
      selectionEpoch,
      runtimeMissing,
      markViewed: options.markViewed ?? true,
    });
    const [snapshot] = await Promise.all([
      this.ensureSessionRuntimeReady(sessionRef, { refreshSnapshot: true }),
      runtimeMissing ? this.ensureRuntimeLoaded(sessionRef.workspaceId) : Promise.resolve(),
    ]);
    logTuiPerf("main.store.hydrate.dependenciesDone", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    }, {
      selectionEpoch,
      hasSnapshot: Boolean(snapshot),
      runtimeMissing,
      stillCurrent: this.isCurrentSelectionEpoch(sessionRef, selectionEpoch),
    });

    if (!this.isCurrentSelectionEpoch(sessionRef, selectionEpoch)) {
      logTuiPerf("main.store.hydrate.abortedStaleAfterDependencies", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      }, {
        selectionEpoch,
      });
      return;
    }

    const runtimeByWorkspace = runtimeMissing ? await this.serializeRuntimeStateForCurrentWorkspaces() : undefined;
    if (!this.isCurrentSelectionEpoch(sessionRef, selectionEpoch)) {
      logTuiPerf("main.store.hydrate.abortedStaleAfterRuntimeSerialize", {
        workspaceId: sessionRef.workspaceId,
        sessionId: sessionRef.sessionId,
      }, {
        selectionEpoch,
      });
      return;
    }

    this.clearSessionError(sessionRef);
    this.state = this.syncSelectedSessionHydrationState(this.state, sessionRef, snapshot, runtimeByWorkspace);
    if (options.markViewed ?? true) {
      this.markSessionViewed(sessionRef);
    }
    this.schedulePersistUiState();
    this.emit();
    logTuiPerf("main.store.hydrate.done", {
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
    }, {
      selectionEpoch,
      emittedRevision: this.state.revision,
    });
  }

  private startSelectedSessionHydration(
    sessionRef: SessionRef | undefined,
    options: { readonly markViewed?: boolean } = {},
  ): void {
    if (!sessionRef) {
      return;
    }

    const selectionEpoch = ++this.selectionEpoch;
    void this.hydrateSelectedSessionAfterSelection(sessionRef, selectionEpoch, options).catch((error: unknown) => {
      void this.handleSelectedSessionHydrationError(sessionRef, selectionEpoch, error);
    });
  }

  private async handleSelectedSessionHydrationError(
    sessionRef: SessionRef,
    selectionEpoch: number,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.sessionState.sessionErrorsBySession.set(sessionKey(sessionRef), message);
    if (this.isCurrentSelectionEpoch(sessionRef, selectionEpoch)) {
      await this.withError(error);
      return;
    }

    this.schedulePersistUiState();
  }

  private isCurrentSelectionEpoch(sessionRef: SessionRef, selectionEpoch: number): boolean {
    return (
      selectionEpoch === this.selectionEpoch &&
      this.state.selectedWorkspaceId === sessionRef.workspaceId &&
      this.state.selectedSessionId === sessionRef.sessionId
    );
  }

  private markSelectedSessionViewedIfVisible(): boolean {
    if (this.state.activeView !== "threads" || !this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return false;
    }

    const sessionRef = {
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    } satisfies SessionRef;
    if (!isSessionVisibleInWindow(this.state, sessionRef, this.getWindow())) {
      return false;
    }
    if (this.restoredSelectedSessionKeysAwaitingSelection.has(sessionKey(sessionRef))) {
      return false;
    }

    return this.markSessionViewed(sessionRef);
  }

  private markSessionViewedIfActivelyViewed(sessionRef: SessionRef): boolean {
    const active = isSessionActivelyViewed(this.state, sessionRef, this.getWindow());
    if (!active) {
      return false;
    }

    return this.markSessionViewed(sessionRef);
  }

  private markSessionViewed(sessionRef: SessionRef, fallbackViewedAt = new Date().toISOString()): boolean {
    const key = sessionKey(sessionRef);
    const viewedAt = this.resolveViewedAt(sessionRef, fallbackViewedAt);
    const current = this.sessionState.lastViewedAtBySession.get(key);
    if (current && current >= viewedAt) {
      return false;
    }

    this.sessionState.lastViewedAtBySession.set(key, viewedAt);
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map((w) =>
        w.id === sessionRef.workspaceId
          ? {
              ...w,
              sessions: w.sessions.map((s) =>
                s.id === sessionRef.sessionId
                  ? {
                      ...s,
                      lastViewedAt: viewedAt,
                      hasUnseenUpdate: false,
                    }
                  : s,
              ),
            }
          : w,
      ),
      lastViewedAtBySession: mapToRecord(this.sessionState.lastViewedAtBySession),
    };
    return true;
  }

  private resolveViewedAt(sessionRef: SessionRef, fallbackViewedAt: string): string {
    const session = this.findSessionRecord(sessionRef);
    if (!session) {
      return fallbackViewedAt;
    }
    return session.updatedAt > fallbackViewedAt ? session.updatedAt : fallbackViewedAt;
  }

  private findSessionRecord(sessionRef: SessionRef) {
    return this.state.workspaces
      .find((workspace) => workspace.id === sessionRef.workspaceId)
      ?.sessions.find((session) => session.id === sessionRef.sessionId);
  }

  private clearSessionError(sessionRef: SessionRef): void {
    this.sessionState.sessionErrorsBySession.delete(sessionKey(sessionRef));
  }

  private resolveSelectedSessionError(
    selectedWorkspaceId: string,
    selectedSessionId: string,
    clearLastError?: boolean,
  ): string | undefined {
    if (!selectedWorkspaceId || !selectedSessionId) {
      return undefined;
    }

    const key = sessionKey({ workspaceId: selectedWorkspaceId, sessionId: selectedSessionId });
    if (clearLastError) {
      this.sessionState.sessionErrorsBySession.delete(key);
      return undefined;
    }

    return this.sessionState.sessionErrorsBySession.get(key);
  }

  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void {
    const key = sessionKey(sessionRef);
    if (config && Object.keys(config).length > 0) {
      this.sessionState.sessionConfigBySession.set(key, config);
    } else {
      this.sessionState.sessionConfigBySession.delete(key);
    }
  }

  private syncSelectedSessionHydrationState(
    state: DesktopAppState,
    sessionRef: SessionRef,
    snapshot?: SessionSnapshot,
    runtimeByWorkspace?: Record<string, RuntimeSnapshot>,
  ): DesktopAppState {
    const key = sessionKey(sessionRef);
    const lastViewedAt = this.sessionState.lastViewedAtBySession.get(key);
    const nextState = {
      ...state,
      ...(runtimeByWorkspace ? { runtimeByWorkspace } : {}),
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === sessionRef.workspaceId
          ? {
              ...workspace,
              sessions: workspace.sessions.map((session) => {
                if (session.id !== sessionRef.sessionId) {
                  return session;
                }

                return updateSessionRecord(session, {
                  snapshot:
                    snapshot || this.sessionState.sessionConfigBySession.has(key)
                      ? {
                          ...snapshot,
                          config: this.sessionState.sessionConfigBySession.get(key) ?? snapshot?.config,
                        }
                      : undefined,
                  runningSince: this.sessionState.runningSinceBySession.get(key),
                  lastViewedAt,
                });
              }),
            }
          : workspace,
      ),
      lastError: undefined,
      revision: state.revision + 1,
    };

    return this.syncDerivedSessionState(nextState, sessionRef);
  }
  setPendingAutoTitle(sessionRef: SessionRef, pending: import("./session-state-map").PendingAutoTitle): void {
    this.clearPendingAutoTitle(sessionRef);
    this.sessionState.pendingAutoTitleBySession.set(sessionKey(sessionRef), pending);
  }

  getPendingAutoTitle(sessionRef: SessionRef): import("./session-state-map").PendingAutoTitle | undefined {
    return this.sessionState.pendingAutoTitleBySession.get(sessionKey(sessionRef));
  }

  clearPendingAutoTitle(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const pendingAutoTitle = this.sessionState.pendingAutoTitleBySession.get(key);
    if (!pendingAutoTitle) {
      return;
    }
    this.sessionState.pendingAutoTitleBySession.delete(key);
    pendingAutoTitle.cancel();
  }
}

/* ── Module-private free functions ───────────────────────── */

function updateRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T | undefined,
): Readonly<Record<string, T>> {
  if (value === undefined) {
    if (!(key in record)) {
      return record;
    }

    const { [key]: _removed, ...rest } = record;
    return rest;
  }

  if (record[key] === value) {
    return record;
  }

  return {
    ...record,
    [key]: value,
  };
}


function normalizeOptionalWorkspaceId(workspaceId: string | undefined): string | undefined {
  return workspaceId?.trim() || undefined;
}

function toModelSettingsSnapshot(settings: RuntimeSettingsSnapshot | ModelSettingsSnapshot): ModelSettingsSnapshot {
  return {
    ...(settings.defaultProvider ? { defaultProvider: settings.defaultProvider } : {}),
    ...(settings.defaultModelId ? { defaultModelId: settings.defaultModelId } : {}),
    ...(settings.defaultThinkingLevel ? { defaultThinkingLevel: settings.defaultThinkingLevel } : {}),
    enabledModelPatterns: [...settings.enabledModelPatterns],
  };
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasStoredModelSettings(settings: ModelSettingsSnapshot | undefined): settings is ModelSettingsSnapshot {
  return Boolean(
    settings &&
      (settings.enabledModelPatterns.length > 0 ||
        settings.defaultProvider ||
        settings.defaultModelId ||
        settings.defaultThinkingLevel),
  );
}


function toPublicMcpServerConfig(server: PersistedMcpServerConfig): McpServerConfig {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    ...(server.apiKey ? { apiKey: server.apiKey } : {}),
    oauthEnabled: server.oauthEnabled,
    authorized: server.authorized,
    enabled: server.enabled,
    ...(server.authorizedAt ? { authorizedAt: server.authorizedAt } : {}),
    ...(server.lastAuthError ? { lastAuthError: server.lastAuthError } : {}),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}


function toPersistedMcpServerConfig(
  server: McpServerConfig,
  oauthTokens: McpServerOAuthTokens | undefined,
): PersistedMcpServerConfig {
  return {
    ...server,
    ...(oauthTokens ? { oauthTokens } : {}),
  };
}

function normalizeMcpServerInput(input: McpServerConfigInput): McpServerConfigInput {
  const name = input.name.trim();
  const url = input.url.trim();
  const apiKey = input.apiKey?.trim() ?? "";
  if (!name) {
    throw new Error("MCP server name is required.");
  }
  if (!isHttpMcpUrl(url)) {
    throw new Error("MCP server URL must use http:// or https://.");
  }
  const knownConfigError = getKnownMcpServerConfigurationError(url);
  if (knownConfigError) {
    throw new Error(knownConfigError);
  }
  return {
    name,
    url,
    ...(apiKey ? { apiKey } : {}),
    oauthEnabled: Boolean(input.oauthEnabled),
  };
}

function isHttpMcpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getKnownMcpServerConfigurationError(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "api.exa.ai" && parsed.pathname === "/search") {
      return "Exa MCP must use https://mcp.exa.ai/mcp. https://api.exa.ai/search is Exa Search API, not an MCP endpoint.";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function modelSettingsEqual(left: ModelSettingsSnapshot, right: ModelSettingsSnapshot): boolean {
  return (
    left.defaultProvider === right.defaultProvider &&
    left.defaultModelId === right.defaultModelId &&
    left.defaultThinkingLevel === right.defaultThinkingLevel &&
    left.enabledModelPatterns.length === right.enabledModelPatterns.length &&
    left.enabledModelPatterns.every((pattern, index) => pattern === right.enabledModelPatterns[index])
  );
}

function mergeEnabledModelPatterns(
  existingPatterns: readonly string[],
  providerPatterns: readonly string[],
): readonly string[] {
  const merged = [...existingPatterns];
  const seen = new Set(existingPatterns);
  for (const pattern of providerPatterns) {
    if (seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    merged.push(pattern);
  }
  return merged;
}

function formatCapabilityLabel(capability: string): string {
  switch (capability) {
    case "custom":
      return "custom UI";
    case "onTerminalInput":
      return "terminal input";
    case "setEditorComponent":
      return "custom editor UI";
    case "setFooter":
      return "footer UI";
    case "setHeader":
      return "header UI";
    default:
      return capability.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }
}

function resolveSelectedWorkspaceIdFromCatalog(
  preferredWorkspaceId: string,
  workspaces: readonly { workspaceId: string }[],
): string {
  if (preferredWorkspaceId && workspaces.some((w) => w.workspaceId === preferredWorkspaceId)) {
    return preferredWorkspaceId;
  }
  return workspaces[0]?.workspaceId ?? "";
}

function resolveSelectedSessionIdFromCatalog(
  workspaceId: string,
  preferredSessionId: string,
  sessions: readonly SessionCatalogEntry[],
): string {
  const workspaceSessions = sessions.filter(
    (session) => session.workspaceId === workspaceId,
  );
  if (!workspaceSessions.length) {
    return "";
  }
  if (
    preferredSessionId &&
    workspaceSessions.some((session) => session.sessionRef.sessionId === preferredSessionId)
  ) {
    return preferredSessionId;
  }
  return workspaceSessions[0]?.sessionRef.sessionId ?? "";
}
