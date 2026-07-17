import type { HostUiResponse } from "@bimanus/session-driver";
import type { RuntimePackageRecord, RuntimePackageSearchRecord, RuntimeSettingsSnapshot } from "@bimanus/session-driver/runtime-types";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@bimanus/session-driver/types";
import type {
  AppView,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  McpServerConfigInput,
  NotificationPreferences,
  RemoveWorktreeInput,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "./desktop-state";
import {
  desktopIpc,
  type CliAdapterInfo,
  type CliDetectionMap,
  type CliDetectionResult,
  type DesktopNotificationPermissionStatus,
  type PiDesktopApi,
  type PiDesktopCommand,
  type BackgroundPiTuiSessionSnapshot,
  type TerminalDataEvent,
  type TerminalErrorEvent,
  type TerminalExitEvent,
  type TerminalLaunchConfig,
  type TerminalPanelSnapshot,
  type TerminalSize,
} from "./ipc";
import { isElectronHost } from "./platform-env";
import { safeRandomUuid } from "./utils/uuid";

const tokenStorageKey = "pi-gui.remote-ui-token";
const clientIdStorageKey = "pi-gui.remote-ui-client-id";
const remoteConfiguredApiUrl = import.meta.env.VITE_PI_REMOTE_API_URL?.trim();

interface RemoteInvokeSuccess<T> {
  readonly ok: true;
  readonly result: T;
}

interface RemoteInvokeFailure {
  readonly ok: false;
  readonly error: string;
}

type RemoteInvokeResponse<T> = RemoteInvokeSuccess<T> | RemoteInvokeFailure;
type RemoteEventName =
  | "state-changed"
  | "command"
  | "workspace-picked"
  | "terminal-data"
  | "terminal-exit"
  | "terminal-error"
  | "notification-permission-status-changed"
  | "theme-changed";

class RemoteEventHub {
  private source: EventSource | undefined;
  private readonly attachedEvents = new Set<RemoteEventName>();
  private readonly listeners = new Map<RemoteEventName, Set<(payload: unknown) => void>>();

  constructor(
    private readonly eventsUrl: string,
    private readonly clientId: string,
    private readonly token: string,
  ) {}

  subscribe<T>(eventName: RemoteEventName, listener: (payload: T) => void): () => void {
    let listeners = this.listeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(eventName, listeners);
    }
    const wrapped = listener as (payload: unknown) => void;
    listeners.add(wrapped);
    this.ensureConnected();
    this.attachEvent(eventName);
    return () => {
      listeners?.delete(wrapped);
      if ([...this.listeners.values()].every((entry) => entry.size === 0)) {
        this.source?.close();
        this.source = undefined;
        this.attachedEvents.clear();
      }
    };
  }

  private ensureConnected(): void {
    if (this.source || !this.token) {
      return;
    }
    const url = new URL(this.eventsUrl);
    url.searchParams.set("clientId", this.clientId);
    url.searchParams.set("token", this.token);
    this.source = new EventSource(url.toString());
    this.attachedEvents.clear();
    for (const eventName of this.listeners.keys()) {
      this.attachEvent(eventName);
    }
  }

  private attachEvent(eventName: RemoteEventName): void {
    if (!this.source || this.attachedEvents.has(eventName)) {
      return;
    }
    this.attachedEvents.add(eventName);
    this.source.addEventListener(eventName, (event) => {
      const listeners = this.listeners.get(eventName);
      if (!listeners?.size) {
        return;
      }
      const payload = parseEventPayload((event as MessageEvent).data);
      for (const listener of listeners) {
        listener(payload);
      }
    });
  }
}

function parseEventPayload(data: string): unknown {
  if (!data) {
    return undefined;
  }
  return JSON.parse(data) as unknown;
}

function resolveClientId(): string {
  const stored = sessionStorage.getItem(clientIdStorageKey)?.trim();
  if (stored) {
    return stored;
  }
  const next = safeRandomUuid();
  sessionStorage.setItem(clientIdStorageKey, next);
  return next;
}

function resolveToken(): string {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken) {
    localStorage.setItem(tokenStorageKey, queryToken);
    url.searchParams.delete("token");
    window.history.replaceState(window.history.state, document.title, url.toString());
    return queryToken;
  }
  return localStorage.getItem(tokenStorageKey)?.trim() ?? "";
}

export class RemoteUiUnauthorizedError extends Error {
  constructor() {
    super("Remote UI password is incorrect.");
    this.name = "RemoteUiUnauthorizedError";
  }
}

export function authorizeRemoteUi(token: string): void {
  localStorage.setItem(tokenStorageKey, token.trim());
  window.location.reload();
}

export function logoutRemoteUi(): void {
  localStorage.removeItem(tokenStorageKey);
  window.location.reload();
}

function resolveApiBase(): string {
  const base = remoteConfiguredApiUrl || "/api";
  return new URL(base, window.location.href).toString().replace(/\/+$/, "");
}

function installRemoteClient(): void {
  if (window.piApp) {
    return;
  }
  if (isElectronHost()) {
    return;
  }
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") {
    return;
  }

  const apiBase = resolveApiBase();
  const clientId = resolveClientId();
  const token = resolveToken();
  const hub = new RemoteEventHub(`${apiBase}/events`, clientId, token);

  async function invoke<T>(channel: string, ...args: readonly unknown[]): Promise<T> {
    const response = await fetch(`${apiBase}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ channel, args, clientId }),
    });
    let payload: RemoteInvokeResponse<T> | undefined;
    try {
      payload = (await response.json()) as RemoteInvokeResponse<T>;
    } catch {
      // Surface the HTTP status below.
    }
    if (!response.ok || !payload?.ok) {
      if (response.status === 401) {
        localStorage.removeItem(tokenStorageKey);
        throw new RemoteUiUnauthorizedError();
      }
      const detail = payload && !payload.ok ? payload.error : `${response.status} ${response.statusText}`;
      throw new Error(`Remote pi-gui request failed: ${detail}`);
    }
    return payload.result;
  }

  const remoteApi: PiDesktopApi = {
    platform: "darwin" as NodeJS.Platform,
    versions: {} as NodeJS.ProcessVersions,
    ping: () => invoke<string>(desktopIpc.ping),
    getState: () => invoke<DesktopAppState>(desktopIpc.stateRequest),
    onStateChanged: (listener) => hub.subscribe<DesktopAppState>("state-changed", listener),
    onCommand: (listener: (command: PiDesktopCommand) => void) => hub.subscribe<PiDesktopCommand>("command", listener),
    onOpenCodingCli: () => () => {},
    onWorkspacePicked: (listener) => hub.subscribe<string>("workspace-picked", listener),
    getPathForFile: () => "",
    addWorkspacePath: (workspacePath: string) => invoke<DesktopAppState>(desktopIpc.addWorkspacePath, workspacePath),
    pickWorkspace: () => invoke<DesktopAppState>(desktopIpc.pickWorkspace),
    selectWorkspace: (workspaceId: string) => invoke<DesktopAppState>(desktopIpc.selectWorkspace, workspaceId),
    renameWorkspace: (workspaceId: string, displayName: string) =>
      invoke<DesktopAppState>(desktopIpc.renameWorkspace, workspaceId, displayName),
    removeWorkspace: (workspaceId: string) => invoke<DesktopAppState>(desktopIpc.removeWorkspace, workspaceId),
    reorderWorkspaces: (workspaceOrder: readonly string[]) =>
      invoke<DesktopAppState>(desktopIpc.reorderWorkspaces, workspaceOrder),
    openWorkspaceInFinder: (workspaceId: string) => invoke<void>(desktopIpc.openWorkspaceInFinder, workspaceId),
    createWorktree: (input: CreateWorktreeInput) => invoke<DesktopAppState>(desktopIpc.createWorktree, input),
    removeWorktree: (input: RemoveWorktreeInput) => invoke<DesktopAppState>(desktopIpc.removeWorktree, input),
    openSkillInFinder: (workspaceId: string, filePath: string) =>
      invoke<void>(desktopIpc.openSkillInFinder, workspaceId, filePath),
    openExtensionInFinder: (workspaceId: string, filePath: string) =>
      invoke<void>(desktopIpc.openExtensionInFinder, workspaceId, filePath),
    syncCurrentWorkspace: () => invoke<DesktopAppState>(desktopIpc.syncCurrentWorkspace),
    selectSession: (target: WorkspaceSessionTarget) => invoke<DesktopAppState>(desktopIpc.selectSession, target),
    archiveSession: (target: WorkspaceSessionTarget) => invoke<DesktopAppState>(desktopIpc.archiveSession, target),
    unarchiveSession: (target: WorkspaceSessionTarget) => invoke<DesktopAppState>(desktopIpc.unarchiveSession, target),
    reloadSession: (target: WorkspaceSessionTarget) => invoke<DesktopAppState>(desktopIpc.reloadSession, target),
    createSession: (input: CreateSessionInput) => invoke<DesktopAppState>(desktopIpc.createSession, input),
    startThread: (input: StartThreadInput) => invoke<DesktopAppState>(desktopIpc.startThread, input),
    cancelCurrentRun: () => invoke<DesktopAppState>(desktopIpc.cancelCurrentRun),
    setActiveView: (view: AppView) => invoke<DesktopAppState>(desktopIpc.setActiveView, view),
    setSidebarCollapsed: (collapsed: boolean) => invoke<DesktopAppState>(desktopIpc.setSidebarCollapsed, collapsed),
    setSidebarWidth: (sidebarWidth: number) => invoke<DesktopAppState>(desktopIpc.setSidebarWidth, sidebarWidth),
    refreshRuntime: (workspaceId?: string) => invoke<DesktopAppState>(desktopIpc.refreshRuntime, workspaceId),
    setDefaultModel: (workspaceId: string | undefined, provider: string, modelId: string) =>
      invoke<DesktopAppState>(desktopIpc.setDefaultModel, workspaceId, provider, modelId),
    setDefaultThinkingLevel: (workspaceId: string | undefined, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
      invoke<DesktopAppState>(desktopIpc.setDefaultThinkingLevel, workspaceId, thinkingLevel),
    setSessionModel: (workspaceId: string, sessionId: string, provider: string, modelId: string) =>
      invoke<DesktopAppState>(desktopIpc.setSessionModel, workspaceId, sessionId, provider, modelId),
    setSessionThinkingLevel: (
      workspaceId: string,
      sessionId: string,
      thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
    ) => invoke<DesktopAppState>(desktopIpc.setSessionThinkingLevel, workspaceId, sessionId, thinkingLevel),
    loginProvider: (workspaceId: string | undefined, providerId: string) =>
      invoke<DesktopAppState>(desktopIpc.loginProvider, workspaceId, providerId),
    logoutProvider: (workspaceId: string | undefined, providerId: string) =>
      invoke<DesktopAppState>(desktopIpc.logoutProvider, workspaceId, providerId),
    setProviderApiKey: (workspaceId: string | undefined, providerId: string, apiKey: string) =>
      invoke<DesktopAppState>(desktopIpc.setProviderApiKey, workspaceId, providerId, apiKey),
    addMcpServer: (input: McpServerConfigInput) =>
      invoke<DesktopAppState>(desktopIpc.addMcpServer, input),
    updateMcpServer: (serverId: string, input: McpServerConfigInput) =>
      invoke<DesktopAppState>(desktopIpc.updateMcpServer, serverId, input),
    removeMcpServer: (serverId: string) =>
      invoke<DesktopAppState>(desktopIpc.removeMcpServer, serverId),
    authorizeMcpServer: (serverId: string) =>
      invoke<DesktopAppState>(desktopIpc.authorizeMcpServer, serverId),
    setMcpServerEnabled: (serverId: string, enabled: boolean) =>
      invoke<DesktopAppState>(desktopIpc.setMcpServerEnabled, serverId, enabled),
    setCliEnabled: (cliType: string, enabled: boolean) =>
      invoke<DesktopAppState>(desktopIpc.setCliEnabled, cliType, enabled),
    setEnableSkillCommands: (workspaceId: string, enabled: boolean) =>
      invoke<DesktopAppState>(desktopIpc.setEnableSkillCommands, workspaceId, enabled),
    setScopedModelPatterns: (workspaceId: string | undefined, patterns: readonly string[]) =>
      invoke<DesktopAppState>(desktopIpc.setScopedModelPatterns, workspaceId, patterns),
    setSkillEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
      invoke<DesktopAppState>(desktopIpc.setSkillEnabled, workspaceId, filePath, enabled),
    removeSkill: (workspaceId: string, filePath: string) =>
      invoke<DesktopAppState>(desktopIpc.removeSkill, workspaceId, filePath),
    setExtensionEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
      invoke<DesktopAppState>(desktopIpc.setExtensionEnabled, workspaceId, filePath, enabled),
    removeExtension: (workspaceId: string, filePath: string) =>
      invoke<DesktopAppState>(desktopIpc.removeExtension, workspaceId, filePath),
    installPackage: (workspaceId: string, source: string) =>
      invoke<DesktopAppState>(desktopIpc.installPackage, workspaceId, source),
    updatePackage: (workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]) =>
      invoke<DesktopAppState>(desktopIpc.updatePackage, workspaceId, source, installScope),
    removePackage: (workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]) =>
      invoke<DesktopAppState>(desktopIpc.removePackage, workspaceId, source, installScope),
    setPackageEnabled: (workspaceId: string, source: string, enabled: boolean) =>
      invoke<DesktopAppState>(desktopIpc.setPackageEnabled, workspaceId, source, enabled),
    searchPackages: (query: string) =>
      invoke<readonly RuntimePackageSearchRecord[]>(desktopIpc.searchPackages, query),
    respondToHostUiRequest: (workspaceId: string, sessionId: string, response: HostUiResponse) =>
      invoke<DesktopAppState>(desktopIpc.respondToHostUiRequest, workspaceId, sessionId, response),
    setNotificationPreferences: (preferences: Partial<NotificationPreferences>) =>
      invoke<DesktopAppState>(desktopIpc.setNotificationPreferences, preferences),
    setIntegratedTerminalShell: (shellPath: string) =>
      invoke<DesktopAppState>(desktopIpc.setIntegratedTerminalShell, shellPath),
    setTuiTabLimit: (limit: number) => invoke<DesktopAppState>(desktopIpc.setTuiTabLimit, limit),
    setRemoteUiPort: (port: number) => invoke<DesktopAppState>(desktopIpc.setRemoteUiPort, port),
    setRemoteUiToken: (token: string) => invoke<DesktopAppState>(desktopIpc.setRemoteUiToken, token),
    setEnableTransparency: (enabled: boolean) => invoke<DesktopAppState>(desktopIpc.setEnableTransparency, enabled),
    setTuiBgColor: (color: string) => invoke<DesktopAppState>(desktopIpc.setTuiBgColor, color),
    setSplitPanelBgColor: (color: string) => invoke<DesktopAppState>(desktopIpc.setSplitPanelBgColor, color),
    setLocale: (locale: "auto" | "en" | "zh") => invoke<DesktopAppState>(desktopIpc.setLocale, locale),
    ensureTerminalPanel: (
      workspaceId: string,
      terminalScopeId: string,
      size?: Partial<TerminalSize>,
      launchConfig?: TerminalLaunchConfig,
    ) =>
      // Always send an explicit object: JSON.stringify turns undefined array slots into null,
      // which previously crashed main-process launchConfig.mode access.
      invoke<TerminalPanelSnapshot>(
        desktopIpc.terminalEnsurePanel,
        workspaceId,
        terminalScopeId,
        size ?? null,
        launchConfig ?? { mode: "shell" },
      ),
    findBackgroundPiTuiSession: (workspaceId: string, sessionId: string) =>
      invoke<BackgroundPiTuiSessionSnapshot | null>(desktopIpc.terminalFindBackgroundPiTui, workspaceId, sessionId),
    createTerminalSession: (
      workspaceId: string,
      terminalScopeId: string,
      size?: Partial<TerminalSize>,
      launchConfig?: TerminalLaunchConfig,
    ) =>
      invoke<TerminalPanelSnapshot>(
        desktopIpc.terminalCreateSession,
        workspaceId,
        terminalScopeId,
        size ?? null,
        launchConfig ?? { mode: "shell" },
      ),
    setActiveTerminalSession: (workspaceId: string, terminalScopeId: string, terminalId: string) =>
      invoke<TerminalPanelSnapshot>(desktopIpc.terminalSetActiveSession, workspaceId, terminalScopeId, terminalId),
    writeTerminal: (terminalId: string, data: string) => invoke<void>(desktopIpc.terminalWrite, terminalId, data),
    resizeTerminal: (terminalId: string, size: TerminalSize, force?: boolean) => invoke<void>(desktopIpc.terminalResize, terminalId, size, force),
    restartTerminalSession: (terminalId: string, size?: Partial<TerminalSize>, launchConfig?: TerminalLaunchConfig) =>
      invoke<TerminalPanelSnapshot>(
        desktopIpc.terminalRestartSession,
        terminalId,
        size ?? null,
        launchConfig ?? null,
      ),
    closeTerminalSession: (terminalId: string) => invoke<TerminalPanelSnapshot | null>(desktopIpc.terminalCloseSession, terminalId),
    setTerminalTitle: (terminalId: string, title: string) => invoke<void>(desktopIpc.terminalSetTitle, terminalId, title),
    setTerminalFocused: (focused: boolean) => invoke<void>(desktopIpc.terminalSetFocused, focused),
    onTerminalData: (listener) => hub.subscribe<TerminalDataEvent>("terminal-data", listener),
    onTerminalExit: (listener) => hub.subscribe<TerminalExitEvent>("terminal-exit", listener),
    onTerminalError: (listener) => hub.subscribe<TerminalErrorEvent>("terminal-error", listener),
    getNotificationPermissionStatus: () =>
      invoke<DesktopNotificationPermissionStatus>(desktopIpc.getNotificationPermissionStatus),
    requestNotificationPermission: () =>
      invoke<DesktopNotificationPermissionStatus>(desktopIpc.requestNotificationPermission),
    openSystemNotificationSettings: () => invoke<void>(desktopIpc.openSystemNotificationSettings),
    onNotificationPermissionStatusChanged: (callback) =>
      hub.subscribe<DesktopNotificationPermissionStatus>("notification-permission-status-changed", callback),
    readClipboardText: () => invoke<string>(desktopIpc.readClipboardText),
    getSessionTree: (target: WorkspaceSessionTarget) => invoke<SessionTreeSnapshot>(desktopIpc.getSessionTree, target),
    navigateSessionTree: (target: WorkspaceSessionTarget, targetId: string, options?: NavigateSessionTreeOptions) =>
      invoke<{ readonly state: DesktopAppState; readonly result: NavigateSessionTreeResult }>(
        desktopIpc.navigateSessionTree,
        target,
        targetId,
        options,
      ),
    listWorkspaceFiles: (workspaceId: string) => invoke<string[]>(desktopIpc.listWorkspaceFiles, workspaceId),
    getChangedFiles: (workspaceId: string) =>
      invoke<{ path: string; status: "added" | "modified" | "deleted" | "untracked"; staged: boolean }[]>(
        desktopIpc.getChangedFiles,
        workspaceId,
      ),
    getFileDiff: (workspaceId: string, filePath: string) => invoke<string>(desktopIpc.getFileDiff, workspaceId, filePath),
    stageFile: (workspaceId: string, filePath: string) => invoke<void>(desktopIpc.stageFile, workspaceId, filePath),
    toggleWindowMaximize: () => Promise.resolve(),
    // In browser (remote-UI) mode the native Electron copy menu is not
    // available. The call should never be reached because platform-env guards
    // prevent preventDefault from firing, but we provide a no-op stub here to
    // satisfy the PiDesktopApi interface and avoid runtime "not a function"
    // errors if the guard is somehow bypassed.
    showCopySelectionContextMenu: () => Promise.resolve(false),
    openExternal: (url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    },
    getThemeMode: () => invoke<"system" | "light" | "dark">(desktopIpc.getThemeMode),
    getResolvedTheme: () => invoke<"light" | "dark">(desktopIpc.getResolvedTheme),
    setThemeMode: (mode: "system" | "light" | "dark") => invoke<string>(desktopIpc.setThemeMode, mode),
    onThemeChanged: (callback) => hub.subscribe<"light" | "dark">("theme-changed", callback),

    /* ── System Prompts ──────────────────────────────────── */
    saveSystemPrompt: (name: string, content: string, promptId?: string) =>
      invoke<DesktopAppState>(desktopIpc.saveSystemPrompt, name, content, promptId),
    deleteSystemPrompt: (promptId: string) =>
      invoke<DesktopAppState>(desktopIpc.deleteSystemPrompt, promptId),
    setActiveSystemPrompt: (promptId: string | undefined) =>
      invoke<DesktopAppState>(desktopIpc.setActiveSystemPrompt, promptId),

    /* ── CLI 检测 ──────────────────────────────────── */
    // 远程/Web 模式下没有本地文件系统与 CLI 可执行文件的直接访问权限，
    // 仍然通过后端 invoke 转发到主进程实现的 cli-detector，保持与 Electron 模式一致的行为。
    detectAllCli: () => invoke<CliDetectionMap>(desktopIpc.cliDetectAll),
    detectCli: (cliType: string) => invoke<CliDetectionResult>(desktopIpc.cliDetectOne, cliType),
    getCliAdapterInfo: () => invoke<CliAdapterInfo[]>(desktopIpc.cliGetAdapterInfo),
  };

  window.piApp = remoteApi;
}

installRemoteClient();
