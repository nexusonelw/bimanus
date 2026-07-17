import { contextBridge, ipcRenderer, webUtils } from "electron";
import { PRELOAD_DEV_RELOAD_MARKER } from "./dev-reload-preload-probe";
import {
  desktopIpc,
  type CloseCodingCliEvent,
  type CopySelectionContextMenuInput,
  type DesktopNotificationPermissionStatus,
  type PiDesktopCommand,
  type BackgroundPiTuiSessionSnapshot,
  type TerminalDataEvent,
  type TerminalErrorEvent,
  type TerminalExitEvent,
  type TerminalLaunchConfig,
  type TerminalPanelSnapshot,
  type TerminalSize,
  type CliAdapterInfo,
  type CliDetectionMap,
  type OpenCodingCliEvent,
} from "../src/ipc";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@bimanus/session-driver/types";
import type {
  HostUiResponse,
} from "@bimanus/session-driver";
import type { RuntimePackageRecord, RuntimePackageSearchRecord, RuntimeSettingsSnapshot } from "@bimanus/session-driver/runtime-types";
import type {
  AppView,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  McpServerConfigInput,
  NotificationPreferences,
  RemoveWorktreeInput,
  StartThreadInput,
  SystemPromptRecord,
  WorkspaceSessionTarget,
  CliDetectionResult,
} from "../src/desktop-state";

const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";

function resolveDevReloadMarkers() {
  if (!devReloadMarkersEnabled) {
    return undefined;
  }

  return {
    preload: PRELOAD_DEV_RELOAD_MARKER,
  };
}

const devReloadMarkers = resolveDevReloadMarkers();

if (devReloadMarkers) {
  contextBridge.exposeInMainWorld("__piDevReloadHost", devReloadMarkers);
}

function subscribeIpc<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

contextBridge.exposeInMainWorld("piApp", {
  platform: process.platform,
  versions: process.versions,
  ping: () => invokeIpc<string>(desktopIpc.ping),
  getState: () => invokeIpc<DesktopAppState>(desktopIpc.stateRequest),
  onStateChanged: (listener: (state: DesktopAppState) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: DesktopAppState) => {
      listener(state);
    };
    ipcRenderer.on(desktopIpc.stateChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.stateChanged, handle);
    };
  },
  onCommand: (listener: (command: PiDesktopCommand) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, command: PiDesktopCommand) => {
      listener(command);
    };
    ipcRenderer.on(desktopIpc.appCommand, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.appCommand, handle);
    };
  },
  onOpenCodingCli: (listener: (event: OpenCodingCliEvent) => void) =>
    subscribeIpc(desktopIpc.openCodingCli, listener),
  onCloseCodingCli: (handler: (event: CloseCodingCliEvent) => void) =>
    subscribeIpc(desktopIpc.closeCodingCli, handler),
  onWorkspacePicked: (listener: (workspaceId: string) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, workspaceId: string) => {
      listener(workspaceId);
    };
    ipcRenderer.on(desktopIpc.workspacePicked, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.workspacePicked, handle);
    };
  },
  showCopySelectionContextMenu: (input: CopySelectionContextMenuInput) =>
    invokeIpc(desktopIpc.showCopySelectionContextMenu, input) as Promise<boolean>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  addWorkspacePath: (workspacePath: string) =>
    invokeIpc(desktopIpc.addWorkspacePath, workspacePath) as Promise<DesktopAppState>,
  pickWorkspace: () => invokeIpc(desktopIpc.pickWorkspace) as Promise<DesktopAppState>,
  selectWorkspace: (workspaceId: string) =>
    invokeIpc(desktopIpc.selectWorkspace, workspaceId) as Promise<DesktopAppState>,
  renameWorkspace: (workspaceId: string, displayName: string) =>
    invokeIpc(desktopIpc.renameWorkspace, workspaceId, displayName) as Promise<DesktopAppState>,
  removeWorkspace: (workspaceId: string) =>
    invokeIpc(desktopIpc.removeWorkspace, workspaceId) as Promise<DesktopAppState>,
  reorderWorkspaces: (workspaceOrder: readonly string[]) =>
    invokeIpc(desktopIpc.reorderWorkspaces, workspaceOrder) as Promise<DesktopAppState>,
  openWorkspaceInFinder: (workspaceId: string) =>
    invokeIpc(desktopIpc.openWorkspaceInFinder, workspaceId) as Promise<void>,
  createWorktree: (input: CreateWorktreeInput) =>
    invokeIpc(desktopIpc.createWorktree, input) as Promise<DesktopAppState>,
  removeWorktree: (input: RemoveWorktreeInput) =>
    invokeIpc(desktopIpc.removeWorktree, input) as Promise<DesktopAppState>,
  openSkillInFinder: (workspaceId: string, filePath: string) =>
    invokeIpc(desktopIpc.openSkillInFinder, workspaceId, filePath) as Promise<void>,
  openExtensionInFinder: (workspaceId: string, filePath: string) =>
    invokeIpc(desktopIpc.openExtensionInFinder, workspaceId, filePath) as Promise<void>,
  syncCurrentWorkspace: () =>
    invokeIpc(desktopIpc.syncCurrentWorkspace) as Promise<DesktopAppState>,
  selectSession: (target: WorkspaceSessionTarget) =>
    invokeIpc(desktopIpc.selectSession, target) as Promise<DesktopAppState>,
  archiveSession: (target: WorkspaceSessionTarget) =>
    invokeIpc(desktopIpc.archiveSession, target) as Promise<DesktopAppState>,
  unarchiveSession: (target: WorkspaceSessionTarget) =>
    invokeIpc(desktopIpc.unarchiveSession, target) as Promise<DesktopAppState>,
  reloadSession: (target: WorkspaceSessionTarget) =>
    invokeIpc(desktopIpc.reloadSession, target) as Promise<DesktopAppState>,
  createSession: (input: CreateSessionInput) =>
    invokeIpc(desktopIpc.createSession, input) as Promise<DesktopAppState>,
  startThread: (input: StartThreadInput) =>
    invokeIpc(desktopIpc.startThread, input) as Promise<DesktopAppState>,
  cancelCurrentRun: () => invokeIpc<DesktopAppState>(desktopIpc.cancelCurrentRun),
  setActiveView: (view: AppView) =>
    invokeIpc(desktopIpc.setActiveView, view) as Promise<DesktopAppState>,
  setSidebarCollapsed: (collapsed: boolean) =>
    invokeIpc(desktopIpc.setSidebarCollapsed, collapsed) as Promise<DesktopAppState>,
  setSidebarWidth: (sidebarWidth: number) =>
    invokeIpc(desktopIpc.setSidebarWidth, sidebarWidth) as Promise<DesktopAppState>,
  refreshRuntime: (workspaceId?: string) =>
    invokeIpc(desktopIpc.refreshRuntime, workspaceId) as Promise<DesktopAppState>,
  setDefaultModel: (workspaceId: string | undefined, provider: string, modelId: string) =>
    invokeIpc(desktopIpc.setDefaultModel, workspaceId, provider, modelId) as Promise<DesktopAppState>,
  setDefaultThinkingLevel: (workspaceId: string | undefined, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
    invokeIpc(desktopIpc.setDefaultThinkingLevel, workspaceId, thinkingLevel) as Promise<DesktopAppState>,
  setSessionModel: (workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    invokeIpc(desktopIpc.setSessionModel, workspaceId, sessionId, provider, modelId) as Promise<DesktopAppState>,
  setSessionThinkingLevel: (workspaceId: string, sessionId: string, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
    invokeIpc(desktopIpc.setSessionThinkingLevel, workspaceId, sessionId, thinkingLevel) as Promise<DesktopAppState>,
  loginProvider: (workspaceId: string | undefined, providerId: string) =>
    invokeIpc(desktopIpc.loginProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  logoutProvider: (workspaceId: string | undefined, providerId: string) =>
    invokeIpc(desktopIpc.logoutProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  setProviderApiKey: (workspaceId: string | undefined, providerId: string, apiKey: string) =>
    invokeIpc(desktopIpc.setProviderApiKey, workspaceId, providerId, apiKey) as Promise<DesktopAppState>,
  addMcpServer: (input: McpServerConfigInput) =>
    invokeIpc(desktopIpc.addMcpServer, input) as Promise<DesktopAppState>,
  updateMcpServer: (serverId: string, input: McpServerConfigInput) =>
    invokeIpc(desktopIpc.updateMcpServer, serverId, input) as Promise<DesktopAppState>,
  removeMcpServer: (serverId: string) =>
    invokeIpc(desktopIpc.removeMcpServer, serverId) as Promise<DesktopAppState>,
  authorizeMcpServer: (serverId: string) =>
    invokeIpc(desktopIpc.authorizeMcpServer, serverId) as Promise<DesktopAppState>,
  setMcpServerEnabled: (serverId: string, enabled: boolean) =>
    invokeIpc(desktopIpc.setMcpServerEnabled, serverId, enabled) as Promise<DesktopAppState>,
  setCliEnabled: (cliType: string, enabled: boolean) =>
    invokeIpc(desktopIpc.setCliEnabled, cliType, enabled) as Promise<DesktopAppState>,
  setEnableSkillCommands: (workspaceId: string, enabled: boolean) =>
    invokeIpc(desktopIpc.setEnableSkillCommands, workspaceId, enabled) as Promise<DesktopAppState>,
  setScopedModelPatterns: (workspaceId: string | undefined, patterns: readonly string[]) =>
    invokeIpc(desktopIpc.setScopedModelPatterns, workspaceId, patterns) as Promise<DesktopAppState>,
  setSkillEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    invokeIpc(desktopIpc.setSkillEnabled, workspaceId, filePath, enabled) as Promise<DesktopAppState>,
  removeSkill: (workspaceId: string, filePath: string) =>
    invokeIpc(desktopIpc.removeSkill, workspaceId, filePath) as Promise<DesktopAppState>,
  setExtensionEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    invokeIpc(desktopIpc.setExtensionEnabled, workspaceId, filePath, enabled) as Promise<DesktopAppState>,
  removeExtension: (workspaceId: string, filePath: string) =>
    invokeIpc(desktopIpc.removeExtension, workspaceId, filePath) as Promise<DesktopAppState>,
  installPackage: (workspaceId: string, source: string) =>
    invokeIpc(desktopIpc.installPackage, workspaceId, source) as Promise<DesktopAppState>,
  updatePackage: (workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]) =>
    invokeIpc(desktopIpc.updatePackage, workspaceId, source, installScope) as Promise<DesktopAppState>,
  removePackage: (workspaceId: string, source: string, installScope?: RuntimePackageRecord["installScope"]) =>
    invokeIpc(desktopIpc.removePackage, workspaceId, source, installScope) as Promise<DesktopAppState>,
  setPackageEnabled: (workspaceId: string, source: string, enabled: boolean) =>
    invokeIpc(desktopIpc.setPackageEnabled, workspaceId, source, enabled) as Promise<DesktopAppState>,
  searchPackages: (query: string) =>
    invokeIpc(desktopIpc.searchPackages, query) as Promise<readonly RuntimePackageSearchRecord[]>,
  respondToHostUiRequest: (workspaceId: string, sessionId: string, response: HostUiResponse) =>
    invokeIpc(desktopIpc.respondToHostUiRequest, workspaceId, sessionId, response) as Promise<DesktopAppState>,
  setNotificationPreferences: (preferences: Partial<NotificationPreferences>) =>
    invokeIpc(desktopIpc.setNotificationPreferences, preferences) as Promise<DesktopAppState>,
  setIntegratedTerminalShell: (shellPath: string) =>
    invokeIpc(desktopIpc.setIntegratedTerminalShell, shellPath) as Promise<DesktopAppState>,
  setTuiTabLimit: (limit: number) =>
    invokeIpc(desktopIpc.setTuiTabLimit, limit) as Promise<DesktopAppState>,
  setRemoteUiPort: (port: number) =>
    invokeIpc(desktopIpc.setRemoteUiPort, port) as Promise<DesktopAppState>,
  setRemoteUiToken: (token: string) =>
    invokeIpc(desktopIpc.setRemoteUiToken, token) as Promise<DesktopAppState>,
  setEnableTransparency: (enabled: boolean) =>
    invokeIpc(desktopIpc.setEnableTransparency, enabled) as Promise<DesktopAppState>,
  setTuiBgColor: (color: string) =>
    invokeIpc(desktopIpc.setTuiBgColor, color) as Promise<DesktopAppState>,
  setSplitPanelBgColor: (color: string) =>
    invokeIpc(desktopIpc.setSplitPanelBgColor, color) as Promise<DesktopAppState>,
  setLocale: (locale: "auto" | "en" | "zh") =>
    invokeIpc(desktopIpc.setLocale, locale) as Promise<DesktopAppState>,
  ensureTerminalPanel: (
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig,
  ) =>
    invokeIpc(desktopIpc.terminalEnsurePanel, workspaceId, terminalScopeId, size, launchConfig) as Promise<TerminalPanelSnapshot>,
  findBackgroundPiTuiSession: (workspaceId: string, sessionId: string) =>
    invokeIpc(desktopIpc.terminalFindBackgroundPiTui, workspaceId, sessionId) as Promise<BackgroundPiTuiSessionSnapshot | null>,
  createTerminalSession: (
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig,
  ) =>
    invokeIpc(desktopIpc.terminalCreateSession, workspaceId, terminalScopeId, size, launchConfig) as Promise<TerminalPanelSnapshot>,
  setActiveTerminalSession: (workspaceId: string, terminalScopeId: string, terminalId: string) =>
    invokeIpc(desktopIpc.terminalSetActiveSession, workspaceId, terminalScopeId, terminalId) as Promise<TerminalPanelSnapshot>,
  writeTerminal: (terminalId: string, data: string) =>
    invokeIpc(desktopIpc.terminalWrite, terminalId, data) as Promise<void>,
  resizeTerminal: (terminalId: string, size: TerminalSize, force?: boolean) =>
    invokeIpc(desktopIpc.terminalResize, terminalId, size, force) as Promise<void>,
  restartTerminalSession: (terminalId: string, size?: Partial<TerminalSize>, launchConfig?: TerminalLaunchConfig) =>
    invokeIpc(desktopIpc.terminalRestartSession, terminalId, size, launchConfig) as Promise<TerminalPanelSnapshot>,
  closeTerminalSession: (terminalId: string) =>
    invokeIpc(desktopIpc.terminalCloseSession, terminalId) as Promise<TerminalPanelSnapshot | null>,
  setTerminalTitle: (terminalId: string, title: string) =>
    invokeIpc(desktopIpc.terminalSetTitle, terminalId, title) as Promise<void>,
  setTerminalFocused: (focused: boolean) => {
    ipcRenderer.send(desktopIpc.terminalSetFocused, focused);
    return Promise.resolve();
  },
  onTerminalData: (listener: (event: TerminalDataEvent) => void) =>
    subscribeIpc(desktopIpc.terminalData, listener),
  onTerminalExit: (listener: (event: TerminalExitEvent) => void) =>
    subscribeIpc(desktopIpc.terminalExit, listener),
  onTerminalError: (listener: (event: TerminalErrorEvent) => void) =>
    subscribeIpc(desktopIpc.terminalError, listener),
  getNotificationPermissionStatus: () =>
    invokeIpc(desktopIpc.getNotificationPermissionStatus) as Promise<DesktopNotificationPermissionStatus>,
  requestNotificationPermission: () =>
    invokeIpc(desktopIpc.requestNotificationPermission) as Promise<DesktopNotificationPermissionStatus>,
  openSystemNotificationSettings: () =>
    invokeIpc(desktopIpc.openSystemNotificationSettings) as Promise<void>,
  onNotificationPermissionStatusChanged: (callback: (status: DesktopNotificationPermissionStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopNotificationPermissionStatus) => callback(status);
    ipcRenderer.on(desktopIpc.notificationPermissionStatusChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.notificationPermissionStatusChanged, handler);
    };
  },
  readClipboardText: () => invokeIpc(desktopIpc.readClipboardText) as Promise<string>,
  getSessionTree: (target: WorkspaceSessionTarget) =>
    invokeIpc(desktopIpc.getSessionTree, target) as Promise<SessionTreeSnapshot>,
  navigateSessionTree: (target: WorkspaceSessionTarget, targetId: string, options?: NavigateSessionTreeOptions) =>
    invokeIpc(desktopIpc.navigateSessionTree, target, targetId, options) as Promise<{
      readonly state: DesktopAppState;
      readonly result: NavigateSessionTreeResult;
    }>,
  listWorkspaceFiles: (workspaceId: string) =>
    invokeIpc(desktopIpc.listWorkspaceFiles, workspaceId) as Promise<string[]>,
  getChangedFiles: (workspaceId: string) =>
    invokeIpc(desktopIpc.getChangedFiles, workspaceId) as Promise<{ path: string; status: "added" | "modified" | "deleted" | "untracked"; staged: boolean }[]>,
  getFileDiff: (workspaceId: string, filePath: string) =>
    invokeIpc(desktopIpc.getFileDiff, workspaceId, filePath) as Promise<string>,
  stageFile: (workspaceId: string, filePath: string) =>
    invokeIpc(desktopIpc.stageFile, workspaceId, filePath) as Promise<void>,
  toggleWindowMaximize: () => invokeIpc(desktopIpc.toggleWindowMaximize) as Promise<void>,
  openExternal: (url: string) => invokeIpc(desktopIpc.openExternal, url) as Promise<void>,
  getThemeMode: () => invokeIpc(desktopIpc.getThemeMode) as Promise<"system" | "light" | "dark">,
  getResolvedTheme: () => invokeIpc(desktopIpc.getResolvedTheme) as Promise<"light" | "dark">,
  setThemeMode: (mode: "system" | "light" | "dark") =>
    invokeIpc(desktopIpc.setThemeMode, mode) as Promise<string>,
  onThemeChanged: (callback: (theme: "light" | "dark") => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: "light" | "dark") => callback(theme);
    ipcRenderer.on(desktopIpc.themeChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.themeChanged, handler);
    };
  },

  /* ── System Prompts ──────────────────────────────────── */
  saveSystemPrompt: (name: string, content: string, promptId?: string) =>
    invokeIpc(desktopIpc.saveSystemPrompt, name, content, promptId) as Promise<DesktopAppState>,
  deleteSystemPrompt: (promptId: string) =>
    invokeIpc(desktopIpc.deleteSystemPrompt, promptId) as Promise<DesktopAppState>,
  setActiveSystemPrompt: (promptId: string | undefined) =>
    invokeIpc(desktopIpc.setActiveSystemPrompt, promptId) as Promise<DesktopAppState>,

  /* ── CLI 检测 ──────────────────────────────────── */
  detectAllCli: () =>
    invokeIpc(desktopIpc.cliDetectAll) as Promise<CliDetectionMap>,
  detectCli: (cliType: string) =>
    invokeIpc(desktopIpc.cliDetectOne, cliType) as Promise<CliDetectionResult>,
  getCliAdapterInfo: () =>
    invokeIpc(desktopIpc.cliGetAdapterInfo) as Promise<CliAdapterInfo[]>,
});
