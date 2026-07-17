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
  LocaleSetting,
  McpServerConfigInput,
  NotificationPreferences,
  RemoveWorktreeInput,
  StartThreadInput,
  SystemPromptRecord,
  WorkspaceSessionTarget,
} from "./desktop-state";

export type DesktopNotificationPermissionStatus =
  | "granted"
  | "denied"
  | "default"
  | "unsupported"
  | "unknown";

export const desktopIpc = {
  stateRequest: "pi-gui:state-request",
  stateChanged: "pi-gui:state-changed",
  appCommand: "pi-gui:app-command",
  openCodingCli: "pi-gui:open-coding-cli",
  closeCodingCli: "pi-gui:close-coding-cli",
  workspacePicked: "pi-gui:workspace-picked",
  showCopySelectionContextMenu: "pi-gui:show-copy-selection-context-menu",
  addWorkspacePath: "pi-gui:add-workspace-path",
  pickWorkspace: "pi-gui:pick-workspace",
  selectWorkspace: "pi-gui:select-workspace",
  renameWorkspace: "pi-gui:rename-workspace",
  removeWorkspace: "pi-gui:remove-workspace",
  reorderWorkspaces: "pi-gui:reorder-workspaces",
  openWorkspaceInFinder: "pi-gui:open-workspace-in-finder",
  createWorktree: "pi-gui:create-worktree",
  removeWorktree: "pi-gui:remove-worktree",
  openSkillInFinder: "pi-gui:open-skill-in-finder",
  openExtensionInFinder: "pi-gui:open-extension-in-finder",
  syncCurrentWorkspace: "pi-gui:sync-current-workspace",
  selectSession: "pi-gui:select-session",
  archiveSession: "pi-gui:archive-session",
  unarchiveSession: "pi-gui:unarchive-session",
  reloadSession: "pi-gui:reload-session",
  createSession: "pi-gui:create-session",
  startThread: "pi-gui:start-thread",
  cancelCurrentRun: "pi-gui:cancel-current-run",
  setActiveView: "pi-gui:set-active-view",
  setSidebarCollapsed: "pi-gui:set-sidebar-collapsed",
  setSidebarWidth: "pi-gui:set-sidebar-width",
  refreshRuntime: "pi-gui:refresh-runtime",
  setDefaultModel: "pi-gui:set-default-model",
  setDefaultThinkingLevel: "pi-gui:set-default-thinking-level",
  setSessionModel: "pi-gui:set-session-model",
  setSessionThinkingLevel: "pi-gui:set-session-thinking-level",
  loginProvider: "pi-gui:login-provider",
  logoutProvider: "pi-gui:logout-provider",
  setProviderApiKey: "pi-gui:set-provider-api-key",
  addMcpServer: "pi-gui:add-mcp-server",
  updateMcpServer: "pi-gui:update-mcp-server",
  removeMcpServer: "pi-gui:remove-mcp-server",
  authorizeMcpServer: "pi-gui:authorize-mcp-server",
  setMcpServerEnabled: "pi-gui:set-mcp-server-enabled",
  setCliEnabled: "pi-gui:set-cli-enabled",
  setEnableSkillCommands: "pi-gui:set-enable-skill-commands",
  setScopedModelPatterns: "pi-gui:set-scoped-model-patterns",
  setSkillEnabled: "pi-gui:set-skill-enabled",
  removeSkill: "pi-gui:remove-skill",
  setExtensionEnabled: "pi-gui:set-extension-enabled",
  removeExtension: "pi-gui:remove-extension",
  installPackage: "pi-gui:install-package",
  updatePackage: "pi-gui:update-package",
  removePackage: "pi-gui:remove-package",
  setPackageEnabled: "pi-gui:set-package-enabled",
  searchPackages: "pi-gui:search-packages",
  respondToHostUiRequest: "pi-gui:respond-to-host-ui-request",
  setNotificationPreferences: "pi-gui:set-notification-preferences",
  setIntegratedTerminalShell: "pi-gui:set-integrated-terminal-shell",
  setTuiTabLimit: "pi-gui:set-tui-tab-limit",
  setRemoteUiPort: "pi-gui:set-remote-ui-port",
  setRemoteUiToken: "pi-gui:set-remote-ui-token",
  setEnableTransparency: "pi-gui:set-enable-transparency",
  setTuiBgColor: "pi-gui:set-tui-bg-color",
  setSplitPanelBgColor: "pi-gui:set-split-panel-bg-color",
  setLocale: "pi-gui:set-locale",
  terminalEnsurePanel: "pi-gui:terminal-ensure-panel",
  terminalFindBackgroundPiTui: "pi-gui:terminal-find-background-pi-tui",
  terminalCreateSession: "pi-gui:terminal-create-session",
  terminalSetActiveSession: "pi-gui:terminal-set-active-session",
  terminalWrite: "pi-gui:terminal-write",
  terminalResize: "pi-gui:terminal-resize",
  terminalRestartSession: "pi-gui:terminal-restart-session",
  terminalCloseSession: "pi-gui:terminal-close-session",
  terminalSetTitle: "pi-gui:terminal-set-title",
  terminalSetFocused: "pi-gui:terminal-set-focused",
  terminalData: "pi-gui:terminal-data",
  terminalExit: "pi-gui:terminal-exit",
  terminalError: "pi-gui:terminal-error",
  getNotificationPermissionStatus: "pi-gui:get-notification-permission-status",
  requestNotificationPermission: "pi-gui:request-notification-permission",
  openSystemNotificationSettings: "pi-gui:open-system-notification-settings",
  notificationPermissionStatusChanged: "pi-gui:notification-permission-status-changed",
  readClipboardText: "pi-gui:read-clipboard-text",
  getSessionTree: "pi-gui:get-session-tree",
  navigateSessionTree: "pi-gui:navigate-session-tree",
  toggleWindowMaximize: "pi-gui:toggle-window-maximize",
  listWorkspaceFiles: "pi-gui:list-workspace-files",
  getChangedFiles: "pi-gui:get-changed-files",
  getFileDiff: "pi-gui:get-file-diff",
  stageFile: "pi-gui:stage-file",
  getThemeMode: "pi-gui:get-theme-mode",
  getResolvedTheme: "pi-gui:get-resolved-theme",
  setThemeMode: "pi-gui:set-theme-mode",
  themeChanged: "pi-gui:theme-changed",
  ping: "app:ping",
  openExternal: "app:open-external",
  saveSystemPrompt: "pi-gui:save-system-prompt",
  deleteSystemPrompt: "pi-gui:delete-system-prompt",
  setActiveSystemPrompt: "pi-gui:set-active-system-prompt",
  // ── CLI 检测 ──
  cliDetectAll: "pi-gui:cli-detect-all",
  cliDetectOne: "pi-gui:cli-detect-one",
  cliGetAdapterInfo: "pi-gui:cli-get-adapter-info",
} as const;

export const desktopCommands = {
  openSettings: "open-settings",
  openNewThread: "open-new-thread",
  toggleTerminal: "toggle-terminal",
  toggleSidebar: "toggle-sidebar",
} as const;

export function getDesktopShortcutLabel(platform: NodeJS.Platform, key: string): string {
  return `${platform === "darwin" ? "⌘" : "Ctrl+"}${key.toUpperCase()}`;
}

export type PiDesktopStateListener = (state: DesktopAppState) => void;

export interface CopySelectionContextMenuInput {
  readonly selectedText: string;
  readonly x?: number;
  readonly y?: number;
}
export type PiDesktopCommand = (typeof desktopCommands)[keyof typeof desktopCommands];

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type SplitPanelCliType =
  | "codex"
  | "claude"
  | "opencode"
  | "grok"
  | "copilot"
  | "antigravity"
  | "kiro"
  | "cursor"
  | "droid";

export type TerminalLaunchConfig =
  | {
      readonly mode: "shell";
    }
  | {
      readonly mode: "pi-tui";
      readonly sessionId?: string;
      readonly newSessionKey?: string;
      readonly newSessionId?: string;
      readonly debugTraceId?: string;
    }
  // ── 新增: CLI 模式 ──
  | {
      readonly mode: "codex";
      readonly prompt?: string;
      readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      readonly ephemeral?: boolean;
    }
  | {
      readonly mode: "claude";
      readonly prompt?: string;
      readonly maxTurns?: number;
      readonly bare?: boolean;
    }
  | {
      readonly mode: "opencode";
      readonly prompt?: string;
    }
  | {
      readonly mode: Exclude<SplitPanelCliType, "codex" | "claude" | "opencode">;
      readonly prompt?: string;
    };

export interface OpenCodingCliEvent {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly cliType: SplitPanelCliType;
  readonly tabId: string;
  readonly terminalId: string;
  readonly prompt: string;
}

export interface CloseCodingCliEvent {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cliType: SplitPanelCliType;
}

export type TerminalSessionStatus = "running" | "exited" | "error";

export interface TerminalSessionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly launchConfig: TerminalLaunchConfig;
  readonly title: string;
  readonly status: TerminalSessionStatus;
  readonly replay: string;
  readonly seq: number;
  readonly truncated: boolean;
  readonly exitCode?: number;
  readonly signal?: number;
  /** Port assigned to CLIs that start a local HTTP server (e.g., OpenCode). */
  readonly cliPort?: number;
}

export interface TerminalPanelSnapshot {
  readonly workspaceId: string;
  readonly rootKey: string;
  readonly activeSessionId: string;
  readonly sessions: readonly TerminalSessionSnapshot[];
}

export interface BackgroundPiTuiSessionSnapshot {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly status: TerminalSessionStatus;
}

export interface TerminalDataEvent {
  readonly terminalId: string;
  readonly seq: number;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly terminalId: string;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalErrorEvent {
  readonly terminalId: string;
  readonly message: string;
}

export interface DesktopShortcutInput {
  readonly modifier: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
}

export function getDesktopCommandFromShortcut(input: DesktopShortcutInput): PiDesktopCommand | undefined {
  if (!input.modifier) {
    return undefined;
  }

  const lowerKey = input.key.toLowerCase();
  const isComma = input.key === "," || input.code === "Comma";
  const isB = lowerKey === "b" || input.code === "KeyB";
  const isJ = lowerKey === "j" || input.code === "KeyJ";
  const isShiftO = input.shift && (lowerKey === "o" || input.code === "KeyO");

  if (!input.shift && isComma) {
    return desktopCommands.openSettings;
  }

  if (!input.shift && isJ) {
    return desktopCommands.toggleTerminal;
  }

  if (!input.shift && isB) {
    return desktopCommands.toggleSidebar;
  }

  if (isShiftO) {
    return desktopCommands.openNewThread;
  }

  return undefined;
}

export interface PiDesktopApi {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  onCommand(listener: (command: PiDesktopCommand) => void): () => void;
  onOpenCodingCli(listener: (event: OpenCodingCliEvent) => void): () => void;
  onCloseCodingCli?(handler: (event: CloseCodingCliEvent) => void): (() => void) | undefined;
  onWorkspacePicked(listener: (workspaceId: string) => void): () => void;
  showCopySelectionContextMenu(input: CopySelectionContextMenuInput): Promise<boolean>;
  getPathForFile(file: File): string;
  addWorkspacePath(path: string): Promise<DesktopAppState>;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  reorderWorkspaces(workspaceOrder: readonly string[]): Promise<DesktopAppState>;
  openWorkspaceInFinder(workspaceId: string): Promise<void>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  openSkillInFinder(workspaceId: string, filePath: string): Promise<void>;
  openExtensionInFinder(workspaceId: string, filePath: string): Promise<void>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  reloadSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  setActiveView(view: AppView): Promise<DesktopAppState>;
  setSidebarCollapsed(collapsed: boolean): Promise<DesktopAppState>;
  setSidebarWidth(sidebarWidth: number): Promise<DesktopAppState>;
  refreshRuntime(workspaceId?: string): Promise<DesktopAppState>;
  setDefaultModel(workspaceId: string | undefined, provider: string, modelId: string): Promise<DesktopAppState>;
  setDefaultThinkingLevel(
    workspaceId: string | undefined,
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState>;
  setSessionModel(
    workspaceId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<DesktopAppState>;
  setSessionThinkingLevel(
    workspaceId: string,
    sessionId: string,
    thinkingLevel: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState>;
  loginProvider(workspaceId: string | undefined, providerId: string): Promise<DesktopAppState>;
  logoutProvider(workspaceId: string | undefined, providerId: string): Promise<DesktopAppState>;
  setProviderApiKey(workspaceId: string | undefined, providerId: string, apiKey: string): Promise<DesktopAppState>;
  addMcpServer(input: McpServerConfigInput): Promise<DesktopAppState>;
  updateMcpServer(serverId: string, input: McpServerConfigInput): Promise<DesktopAppState>;
  removeMcpServer(serverId: string): Promise<DesktopAppState>;
  authorizeMcpServer(serverId: string): Promise<DesktopAppState>;
  setMcpServerEnabled(serverId: string, enabled: boolean): Promise<DesktopAppState>;
  setCliEnabled(cliType: string, enabled: boolean): Promise<DesktopAppState>;
  setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState>;
  setScopedModelPatterns(workspaceId: string | undefined, patterns: readonly string[]): Promise<DesktopAppState>;
  setSkillEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState>;
  removeSkill(workspaceId: string, filePath: string): Promise<DesktopAppState>;
  setExtensionEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState>;
  removeExtension(workspaceId: string, filePath: string): Promise<DesktopAppState>;
  installPackage(workspaceId: string, source: string): Promise<DesktopAppState>;
  updatePackage(workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]): Promise<DesktopAppState>;
  removePackage(workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]): Promise<DesktopAppState>;
  setPackageEnabled(workspaceId: string, source: string, enabled: boolean): Promise<DesktopAppState>;
  searchPackages(query: string): Promise<readonly RuntimePackageSearchRecord[]>;
  respondToHostUiRequest(
    workspaceId: string,
    sessionId: string,
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ): Promise<DesktopAppState>;
  setNotificationPreferences(preferences: Partial<NotificationPreferences>): Promise<DesktopAppState>;
  setIntegratedTerminalShell(shell: string): Promise<DesktopAppState>;
  setTuiTabLimit(limit: number): Promise<DesktopAppState>;
  setRemoteUiPort(port: number): Promise<DesktopAppState>;
  setRemoteUiToken(token: string): Promise<DesktopAppState>;
  setEnableTransparency(enabled: boolean): Promise<DesktopAppState>;
  setTuiBgColor(color: string): Promise<DesktopAppState>;
  setSplitPanelBgColor(color: string): Promise<DesktopAppState>;
  setLocale(locale: LocaleSetting): Promise<DesktopAppState>;
  ensureTerminalPanel(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig,
  ): Promise<TerminalPanelSnapshot>;
  findBackgroundPiTuiSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<BackgroundPiTuiSessionSnapshot | null>;
  createTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig,
  ): Promise<TerminalPanelSnapshot>;
  setActiveTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): Promise<TerminalPanelSnapshot>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, size: TerminalSize, force?: boolean): Promise<void>;
  restartTerminalSession(
    terminalId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig,
  ): Promise<TerminalPanelSnapshot>;
  closeTerminalSession(terminalId: string): Promise<TerminalPanelSnapshot | null>;
  setTerminalTitle(terminalId: string, title: string): Promise<void>;
  setTerminalFocused(focused: boolean): Promise<void>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
  onTerminalError(listener: (event: TerminalErrorEvent) => void): () => void;
  getNotificationPermissionStatus(): Promise<DesktopNotificationPermissionStatus>;
  requestNotificationPermission(): Promise<DesktopNotificationPermissionStatus>;
  openSystemNotificationSettings(): Promise<void>;
  onNotificationPermissionStatusChanged(
    callback: (status: DesktopNotificationPermissionStatus) => void,
  ): () => void;
  readClipboardText(): Promise<string>;
  getSessionTree(target: WorkspaceSessionTarget): Promise<SessionTreeSnapshot>;
  navigateSessionTree(
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ): Promise<{ readonly state: DesktopAppState; readonly result: NavigateSessionTreeResult }>;
  listWorkspaceFiles(workspaceId: string): Promise<string[]>;
  getChangedFiles(workspaceId: string): Promise<{ path: string; status: "added" | "modified" | "deleted" | "untracked"; staged: boolean }[]>;
  getFileDiff(workspaceId: string, filePath: string): Promise<string>;
  stageFile(workspaceId: string, filePath: string): Promise<void>;
  toggleWindowMaximize(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getThemeMode(): Promise<"system" | "light" | "dark">;
  getResolvedTheme(): Promise<"light" | "dark">;
  setThemeMode(mode: "system" | "light" | "dark"): Promise<string>;
  onThemeChanged(callback: (theme: "light" | "dark") => void): () => void;

  /* ── System Prompts ──────────────────────────────────── */
  saveSystemPrompt(name: string, content: string, promptId?: string): Promise<DesktopAppState>;
  deleteSystemPrompt(promptId: string): Promise<DesktopAppState>;
  setActiveSystemPrompt(promptId: string | undefined): Promise<DesktopAppState>;

  /* ── CLI 检测 ──────────────────────────────────── */
  detectAllCli(): Promise<CliDetectionMap>;
  detectCli(cliType: string): Promise<CliDetectionResult>;
  getCliAdapterInfo(): Promise<CliAdapterInfo[]>;
}

// ── CLI 检测相关类型 ──

export interface CliDetectionResult {
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly installSource: string | null;
  readonly error: string | null;
}

export type CliDetectionMap = Record<string, CliDetectionResult>;

export interface CliAdapterInfo {
  readonly cliType: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly supported: boolean;
}
