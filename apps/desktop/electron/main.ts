import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DesktopAppStore, type DesktopAppViewState } from "./app-store";
import { logTuiPerf, TUI_PERF_LOG_PREFIX } from "../src/tui-perf-log";
import { installCopySelectionContextMenu } from "./context-menu";
import { getChangedFiles, getFileDiff, stageFile } from "./app-store-diff";
import { listWorkspaceFiles } from "./app-store-files";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./notification-manager";
import {
  NotificationPermissionService,
} from "./notification-permission";
import { checkForUpdate, initUpdateChecker } from "./update-checker";
import { ThemeManager } from "./theme-manager";
import {
  TerminalService,
  stripTerminalControlForDiagnostics,
  terminalOwnerFromRemoteClient,
  terminalOwnerFromWebContents,
  type TerminalOwner,
  type TerminalPiTuiExitEvent,
  type TerminalRemoteEventName,
} from "./terminal-service";
import { McpOAuthManager } from "./mcp-manager";
import { DesktopMcpBridgeRuntime } from "./mcp-bridge-runtime";
import { RemoteUiServer, type RemoteAgentInvokeRequest, type RemoteCodingAgent, type RemoteUiInvokeRequest } from "./remote-ui-server";
import { RemoteSystemService } from "./remote-system-service";
import {
  configureTuiDiagnosticsLog,
  sanitizeEnv,
  writeTuiDiagnosticLog,
} from "./tui-diagnostics-log";
import { createMcpBridgeExtension } from "../../../packages/mcp-bridge-extension/src/index";
import { normalizeRemoteUiPort, type AppView, type DesktopAppState, type ThemeMode } from "../src/desktop-state";
import { cliNotInstalledRemoteError, isCliEnabled } from "../src/cli-enablement";
import { desktopIpc, getDesktopCommandFromShortcut, type CloseCodingCliEvent, type OpenCodingCliEvent, type SplitPanelCliType, type TerminalLaunchConfig } from "../src/ipc";
import type {
  CreateSessionInput,
  CreateWorktreeInput,
  McpServerConfigInput,
  RemoveWorktreeInput,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import type { SessionDriverEvent } from "@bimanus/session-driver";
import type { GenerateThreadTitleOptions, SessionTranscriptItem } from "@bimanus/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@bimanus/session-driver";
import { CliAdapterRegistry, CliType as AdapterCliType } from "@bimanus/cli-adapter";
import { CliDetector } from "./cli-detector";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const windowTestMode = resolveWindowTestMode();
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
const execFileAsync = promisify(execFile);
let store: DesktopAppStore;
const themeManager = new ThemeManager();
const remoteSystemService = new RemoteSystemService();
const mcpOAuthManager = new McpOAuthManager({
  openExternal: (url) => shell.openExternal(url),
});
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let remoteUiServer: RemoteUiServer | undefined;
let integratedTerminalShell = "";

interface WindowViewState {
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidth: number;
}

const appWindows = new Set<BrowserWindow>();
const windowViews = new Map<number, WindowViewState>();
const remoteViews = new Map<string, WindowViewState>();
const stopPublishingStateByWebContentsId = new Map<number, () => void>();
const stopTrackingWindowActivationByWebContentsId = new Map<number, () => void>();
let stopNotifications: (() => void) | undefined;
let stopUpdateChecker: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let stopPublishingRemoteState: (() => void) | undefined;
let retainedTerminalWorkspacePathSignature = "";
const terminalFocusedWebContentsIds = new Set<number>();
let quittingAfterStoreFlush = false;
let windowScopedActionQueue: Promise<void> = Promise.resolve();
let currentWindowScopedWebContentsId: number | undefined;
let currentRemoteScopedClientId: string | undefined;
let deferredActivationWebContentsId: number | undefined;
const desktopMcpBridgeRuntime = new DesktopMcpBridgeRuntime(() => store);

const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";
const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const CHECK_FOR_UPDATES_MENU_ITEM_ID = "app.check-for-updates";

function getTerminalService(): TerminalService {
  if (!terminalService) {
    terminalService = new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => integratedTerminalShell,
      getAgentDir: () => store.getAgentDir(),
      getMcpBridgeServers: () => store.getMcpBridgeServers(),
      getTuiTabLimit: () => store.state.tuiTabLimit,
      getPiTuiSessionFilePath: (workspaceId, sessionId) => store.getSessionFilePath({ workspaceId, sessionId }),
      getActiveSystemPrompt: () => store.getActiveSystemPrompt(),
      preparePiTuiLaunch: preparePiTuiLaunch,
      resolveExternalCliLaunchCommand: (cliType, prompt, cliPort) =>
        getCliDetector().resolveLaunchCommand(cliType, prompt, cliPort),
      isPackaged: app.isPackaged,
      publishRemoteTerminalEvent: publishRemoteTerminalEvent,
      onPiTuiSessionExit: handlePiTuiSessionExit,
    });
  }
  return terminalService;
}

// ── CLI 检测器 ──
let cliDetector: CliDetector | undefined;

function getCliDetector(): CliDetector {
  if (!cliDetector) {
    cliDetector = new CliDetector();
  }
  return cliDetector;
}

async function preparePiTuiLaunch(workspaceId: string): Promise<void> {
  try {
    await store.prepareRuntimeForExternalLaunch(workspaceId);
  } catch (error) {
    console.error("Unable to refresh runtime before pi TUI launch:", error instanceof Error ? error.message : error);
  }
}

function publishRemoteTerminalEvent(clientId: string, eventName: TerminalRemoteEventName, payload: unknown): void {
  remoteUiServer?.publish(eventName, payload, clientId);
}

async function handlePiTuiSessionExit(event: TerminalPiTuiExitEvent): Promise<void> {
  try {
    if (event.sessionId) {
      await store.reloadSessionFromDiskInPlace({ workspaceId: event.workspaceId, sessionId: event.sessionId });
      return;
    }
    await store.syncWorkspaceInPlace(event.workspaceId);
  } catch (error) {
    console.error("Unable to refresh pi TUI session after exit:", error instanceof Error ? error.message : error);
  }
}

function resolveTuiDiagnosticsLogPath(userDataDir: string): string {
  if (process.platform === "win32") {
    const localAppDataDir = process.env.LOCALAPPDATA?.trim();
    if (localAppDataDir) {
      return path.join(localAppDataDir, "Bimanus", "logs", "pi-tui-diagnostics.log");
    }
  }
  return path.join(userDataDir, "logs", "pi-tui-diagnostics.log");
}

function pickStartupDiagnosticEnv(): Record<string, string> {
  return sanitizeEnv(process.env);
}

// Resolve the bundled application icon. In dev the repo's `resources/icon.png`
// sits two levels up from the compiled `out/main/main.js`; in a packaged build
// it is copied to `process.resourcesPath` via `extraResources` in
// electron-builder.yml. On macOS packaged builds the window/dock icon already
// comes from `icon.icns` in the app bundle, so we only need the PNG for dev
// and for Linux/Windows window chrome.
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "..", "..", "resources", "icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);

function createWindow(): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = store ? store.state.enableTransparency : false;
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    transparent: enableTransparency,
    vibrancy: process.platform === "darwin" && enableTransparency ? "under-window" : undefined,
    titleBarStyle: "hiddenInset",
    backgroundColor: enableTransparency ? "#00000000" : "#f3f4f8",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Keep hidden test windows responsive so Playwright exercises the same UI flows.
      backgroundThrottling: !backgroundTestMode,
    },
  });

  window.once("ready-to-show", () => {
    if (!backgroundTestMode) {
      window.show();
    }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    const lowerKey = input.key.toLowerCase();
    const platformModifier = process.platform === "darwin" ? input.meta : input.control;
    const terminalFocused = terminalFocusedWebContentsIds.has(window.webContents.id);
    if (terminalFocused) {
      return;
    }
    if (platformModifier && !input.shift && lowerKey === "n") {
      event.preventDefault();
      createAppWindow(viewForWebContents(window.webContents.id));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window);
      return;
    }

    const command = getDesktopCommandFromShortcut({
      modifier: process.platform === "darwin" ? input.meta : input.control,
      shift: input.shift,
      key: input.key,
      code: input.code,
    });
    if (command) {
      event.preventDefault();
      window.webContents.send(desktopIpc.appCommand, command);
    }
  });
  window.webContents.on("console-message", (_event, _level, message) => {
    if (typeof message === "string" && message.includes(TUI_PERF_LOG_PREFIX)) {
      console.log(message);
    }
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string);
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    const indexPath = path.join(__dirname, "..", "renderer", "index.html");
    void window.loadURL(pathToFileURL(indexPath).toString());
  }

  return window;
}

function viewFromState(state: DesktopAppState): WindowViewState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth,
  };
}

function toOptionalWorkspaceId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveWindowView(sourceView?: DesktopAppViewState): WindowViewState {
  return viewFromState(store.projectStateForView({ ...viewFromState(store.state), ...sourceView }, store.state));
}

function viewForWebContents(webContentsId: number): WindowViewState {
  return windowViews.get(webContentsId) ?? viewFromState(store.state);
}

function rememberWindowView(webContentsId: number, state: DesktopAppState): void {
  windowViews.set(webContentsId, viewFromState(state));
}

function applyWindowViewToStore(webContentsId: number): void {
  store.state = store.projectStateForView(viewForWebContents(webContentsId), store.state);
}

function projectStateForWindow(
  webContentsId: number,
  state: DesktopAppState = store.state,
  view: WindowViewState = viewForWebContents(webContentsId),
  previousView: WindowViewState | undefined = windowViews.get(webContentsId),
): DesktopAppState {
  void webContentsId;
  return store.projectStateForView(view, state, previousView);
}

function publishStateToWindow(window: BrowserWindow, state: DesktopAppState = store.state): void {
  if (!canPublishToWindow(window)) {
    return;
  }
  const webContentsId = window.webContents.id;
  const view = webContentsId === currentWindowScopedWebContentsId ? viewFromState(state) : viewForWebContents(webContentsId);
  const projected = projectStateForWindow(webContentsId, state, view);
  rememberWindowView(webContentsId, projected);
  window.webContents.send(desktopIpc.stateChanged, projected);
}

function viewForRemoteClient(clientId: string): WindowViewState {
  return remoteViews.get(clientId) ?? viewFromState(store.state);
}

function rememberRemoteView(clientId: string, state: DesktopAppState): void {
  remoteViews.set(clientId, viewFromState(state));
}

function applyRemoteViewToStore(clientId: string): void {
  store.state = store.projectStateForView(viewForRemoteClient(clientId), store.state);
}

function projectStateForRemoteClient(
  clientId: string,
  state: DesktopAppState = store.state,
  view: WindowViewState = viewForRemoteClient(clientId),
  previousView: WindowViewState | undefined = remoteViews.get(clientId),
): DesktopAppState {
  return store.projectStateForView(view, state, previousView);
}

function publishStateToRemoteClients(state: DesktopAppState = store.state): void {
  for (const clientId of remoteViews.keys()) {
    publishStateToRemoteClient(clientId, state);
  }
}

function publishStateToRemoteClient(clientId: string, state: DesktopAppState = store.state): void {
  if (!remoteUiServer) {
    return;
  }
  const view = clientId === currentRemoteScopedClientId ? viewFromState(state) : viewForRemoteClient(clientId);
  const projected = projectStateForRemoteClient(clientId, state, view);
  rememberRemoteView(clientId, projected);
  remoteUiServer.publish("state-changed", projected, clientId);
}

function setActiveWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  mainWindow = window;
  notificationManager?.trackWindow(window);
  notificationPermissionService?.trackWindow(window);
}

function windowForWebContentsId(webContentsId: number): BrowserWindow | undefined {
  return [...appWindows].find((window) => !window.isDestroyed() && window.webContents.id === webContentsId);
}

function applyWindowActivation(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  setActiveWindow(window);
  applyWindowViewToStore(webContentsId);
  store.handleWindowActivation();
  rememberWindowView(webContentsId, store.state);
}

function applyDeferredWindowActivation(): boolean {
  const webContentsId = deferredActivationWebContentsId;
  deferredActivationWebContentsId = undefined;
  if (webContentsId === undefined) {
    return false;
  }
  const window = windowForWebContentsId(webContentsId);
  if (!window || !canPublishToWindow(window)) {
    return false;
  }
  applyWindowActivation(window);
  return true;
}

function getForegroundAppWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && windowViews.has(focusedWindow.webContents.id) && canPublishToWindow(focusedWindow)) {
    return focusedWindow;
  }
  if (mainWindow && canPublishToWindow(mainWindow)) {
    return mainWindow;
  }
  return [...appWindows].find((window) => canPublishToWindow(window)) ?? null;
}

function getForegroundAppView(): DesktopAppViewState | undefined {
  const window = getForegroundAppWindow();
  return window ? viewForWebContents(window.webContents.id) : undefined;
}

function restoreStoreToView(view: DesktopAppViewState | undefined): void {
  if (!view) {
    return;
  }
  store.state = store.projectStateForView(view, store.state);
}

function restoreStoreToViewAndEmit(view: DesktopAppViewState | undefined): void {
  restoreStoreToView(view);
  store.emit();
}

function restoreStoreToForegroundUnlessSender(senderWebContentsId: number | undefined): void {
  const foregroundWindow = getForegroundAppWindow();
  if (!foregroundWindow) {
    return;
  }
  if (senderWebContentsId !== undefined && foregroundWindow.webContents.id === senderWebContentsId) {
    return;
  }
  restoreStoreToViewAndEmit(viewForWebContents(foregroundWindow.webContents.id));
}

function isSessionVisibleInAnotherWindow(sessionRef: SessionRef): boolean {
  for (const window of appWindows) {
    if (!canPublishToWindow(window) || window.isMinimized() || !window.isVisible()) {
      continue;
    }
    const webContentsId = window.webContents.id;
    if (webContentsId === currentWindowScopedWebContentsId) {
      continue;
    }
    const view = windowViews.get(webContentsId);
    if (
      view?.activeView === "threads" &&
      view.selectedWorkspaceId === sessionRef.workspaceId &&
      view.selectedSessionId === sessionRef.sessionId
    ) {
      return true;
    }
  }
  return false;
}

function enqueueWindowScopedAction<T>(action: () => Promise<T>): Promise<T> {
  const run = windowScopedActionQueue.then(action, action);
  windowScopedActionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface WindowScopedActionOptions {
  readonly forceActiveWindow?: boolean;
}

async function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: WindowScopedActionOptions = {},
): Promise<DesktopAppState> {
  return enqueueWindowScopedAction(() => runWindowScopedForWindowNow(window, action, options));
}

async function runWindowScopedForWindowNow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: WindowScopedActionOptions = {},
): Promise<DesktopAppState> {
  const webContentsId = window && !window.isDestroyed() ? window.webContents.id : undefined;
  const foregroundWindow = getForegroundAppWindow();
  const senderIsForeground =
    Boolean(window && foregroundWindow && window.webContents.id === foregroundWindow.webContents.id);
  const windowIsFocused =
    Boolean(window && !window.isDestroyed() && window.isFocused()) ||
    senderIsForeground ||
    options.forceActiveWindow === true;
  if (window && webContentsId !== undefined) {
    if (windowIsFocused) {
      setActiveWindow(window);
    }
    applyWindowViewToStore(webContentsId);
  }

  const previousWindowScopedWebContentsId = currentWindowScopedWebContentsId;
  currentWindowScopedWebContentsId = webContentsId;
  try {
    const state = await action();
    if (!window || webContentsId === undefined) {
      return state;
    }

    const previousView = windowViews.get(webContentsId);
    const projected = projectStateForWindow(webContentsId, state, viewFromState(state), previousView);
    rememberWindowView(webContentsId, projected);
    publishStateToWindow(window, projected);
    return projected;
  } finally {
    currentWindowScopedWebContentsId = previousWindowScopedWebContentsId;
    if (!applyDeferredWindowActivation()) {
      restoreStoreToForegroundUnlessSender(webContentsId);
    }
  }
}

function runWindowScopedForEvent(
  event: IpcMainInvokeEvent,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return runWindowScopedForWindow(BrowserWindow.fromWebContents(event.sender), action);
}

function runPreemptiveWindowScopedForEvent(
  event: IpcMainInvokeEvent,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return runWindowScopedForWindowNow(BrowserWindow.fromWebContents(event.sender), action);
}

async function runUnscopedStateResultForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  const state = await action();
  if (!window || !canPublishToWindow(window)) {
    return state;
  }
  const webContentsId = window.webContents.id;
  const projected = projectStateForWindow(webContentsId, state);
  rememberWindowView(webContentsId, projected);
  return projected;
}

async function runWindowScopedStateResult<T extends { readonly state: DesktopAppState }>(
  window: BrowserWindow | null | undefined,
  action: () => Promise<T>,
  options: WindowScopedActionOptions = {},
): Promise<T> {
  return enqueueWindowScopedAction(async () => {
    const webContentsId = window && !window.isDestroyed() ? window.webContents.id : undefined;
    const foregroundWindow = getForegroundAppWindow();
    const senderIsForeground =
      Boolean(window && foregroundWindow && window.webContents.id === foregroundWindow.webContents.id);
    const windowIsFocused =
      Boolean(window && !window.isDestroyed() && window.isFocused()) ||
      senderIsForeground ||
      options.forceActiveWindow === true;
    if (window && webContentsId !== undefined) {
      if (windowIsFocused) {
        setActiveWindow(window);
      }
      applyWindowViewToStore(webContentsId);
    }

    const previousWindowScopedWebContentsId = currentWindowScopedWebContentsId;
    currentWindowScopedWebContentsId = webContentsId;
    try {
      const result = await action();
      if (!window || webContentsId === undefined) {
        return result;
      }

      const previousView = windowViews.get(webContentsId);
      const projected = projectStateForWindow(webContentsId, result.state, viewFromState(result.state), previousView);
      rememberWindowView(webContentsId, projected);
      publishStateToWindow(window, projected);
      return { ...result, state: projected };
    } finally {
      currentWindowScopedWebContentsId = previousWindowScopedWebContentsId;
      if (!applyDeferredWindowActivation()) {
        restoreStoreToForegroundUnlessSender(webContentsId);
      }
    }
  });
}

async function runRemoteScopedForClient(
  clientId: string,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return enqueueWindowScopedAction(() => runRemoteScopedForClientNow(clientId, action));
}

async function runRemoteScopedForClientNow(
  clientId: string,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  applyRemoteViewToStore(clientId);
  const previousRemoteScopedClientId = currentRemoteScopedClientId;
  currentRemoteScopedClientId = clientId;
  try {
    const state = await action();
    const previousView = remoteViews.get(clientId);
    const projected = projectStateForRemoteClient(clientId, state, viewFromState(state), previousView);
    rememberRemoteView(clientId, projected);
    remoteUiServer?.publish("state-changed", projected, clientId);
    return projected;
  } finally {
    currentRemoteScopedClientId = previousRemoteScopedClientId;
    restoreStoreToForegroundUnlessSender(undefined);
  }
}

async function runRemoteScopedStateResult<T extends { readonly state: DesktopAppState }>(
  clientId: string,
  action: () => Promise<T>,
): Promise<T> {
  return enqueueWindowScopedAction(async () => {
    applyRemoteViewToStore(clientId);
    const previousRemoteScopedClientId = currentRemoteScopedClientId;
    currentRemoteScopedClientId = clientId;
    try {
      const result = await action();
      const previousView = remoteViews.get(clientId);
      const projected = projectStateForRemoteClient(clientId, result.state, viewFromState(result.state), previousView);
      rememberRemoteView(clientId, projected);
      remoteUiServer?.publish("state-changed", projected, clientId);
      return { ...result, state: projected };
    } finally {
      currentRemoteScopedClientId = previousRemoteScopedClientId;
      restoreStoreToForegroundUnlessSender(undefined);
    }
  });
}

async function runUnscopedStateResultForRemoteClient(
  clientId: string,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  const state = await action();
  const projected = projectStateForRemoteClient(clientId, state);
  rememberRemoteView(clientId, projected);
  return projected;
}

function createAppWindow(sourceView?: DesktopAppViewState): BrowserWindow {
  const window = createWindow();
  const webContentsId = window.webContents.id;
  appWindows.add(window);
  windowViews.set(webContentsId, resolveWindowView(sourceView));
  setActiveWindow(window);
  themeManager.trackWindow(window);
  attachStatePublisher(window);
  attachViewedSessionTracking(window);

  window.once("closed", () => {
    appWindows.delete(window);
    windowViews.delete(webContentsId);
    terminalFocusedWebContentsIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store.cancelPendingDialogsWithoutVisibleWindow((sessionRef) => isSessionVisibleInAnotherWindow(sessionRef));
    if (mainWindow === window) {
      mainWindow = [...appWindows].find((candidate) => !candidate.isDestroyed()) ?? null;
      if (mainWindow) {
        setActiveWindow(mainWindow);
        applyWindowViewToStore(mainWindow.webContents.id);
      }
    }
    if (appWindows.size === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

function attachStatePublisher(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  stopPublishingStateByWebContentsId.get(webContentsId)?.();
  const stopPublishingState = store.subscribe((state) => {
    publishStateToWindow(window, state);
  });
  stopPublishingStateByWebContentsId.set(webContentsId, stopPublishingState);
  let disposed = false;
  const clearPublishing = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    stopPublishingStateByWebContentsId.get(webContentsId)?.();
    stopPublishingStateByWebContentsId.delete(webContentsId);
  };
  window.webContents.once("render-process-gone", clearPublishing);
  window.once("closed", clearPublishing);
}

function attachViewedSessionTracking(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  stopTrackingWindowActivationByWebContentsId.get(webContentsId)?.();

  const handleActivation = () => {
    if (currentWindowScopedWebContentsId !== undefined) {
      deferredActivationWebContentsId = webContentsId;
      return;
    }
    applyWindowActivation(window);
  };
  const clearTracking = () => {
    stopTrackingWindowActivationByWebContentsId.get(webContentsId)?.();
    stopTrackingWindowActivationByWebContentsId.delete(webContentsId);
  };

  window.on("focus", handleActivation);
  window.on("show", handleActivation);
  window.on("restore", handleActivation);
  window.once("closed", clearTracking);

  stopTrackingWindowActivationByWebContentsId.set(webContentsId, () => {
    window.off("focus", handleActivation);
    window.off("show", handleActivation);
    window.off("restore", handleActivation);
    window.off("closed", clearTracking);
  });
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed();
}

function resolveWindowTestMode(): "foreground" | "background" {
  return process.env.PI_APP_TEST_MODE?.trim().toLowerCase() === "background" ? "background" : "foreground";
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  if (parentWindow && canPublishToWindow(parentWindow)) {
    return parentWindow;
  }
  if (mainWindow && canPublishToWindow(mainWindow)) {
    return mainWindow;
  }
  return undefined;
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  if (window && canPublishToWindow(window)) {
    return store.getStateForView(viewForWebContents(window.webContents.id));
  }
  return store.getState();
}

async function pickWorkspacePathViaDialog(parentWindow?: BrowserWindow | null): Promise<string | undefined> {
  const window = resolveDialogWindow(parentWindow);
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "Open workspace folder",
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Open workspace folder",
      });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return result.filePaths[0] as string;
}

async function addPickedWorkspace(window: BrowserWindow | null | undefined, workspacePath: string): Promise<DesktopAppState> {
  const nextState = await store.addWorkspace(workspacePath);
  if (!nextState.selectedWorkspaceId) {
    return nextState;
  }
  const newThreadState =
    nextState.activeView === "new-thread" ? nextState : await store.setActiveView("new-thread");
  if (window) {
    window.webContents.send(desktopIpc.workspacePicked, nextState.selectedWorkspaceId);
  }
  return newThreadState;
}

async function pickWorkspaceViaDialog(parentWindow?: BrowserWindow | null): Promise<DesktopAppState> {
  const window = resolveDialogWindow(parentWindow);
  const workspacePath = await pickWorkspacePathViaDialog(window);
  if (!workspacePath) {
    return stateForWindow(window);
  }
  return runWindowScopedForWindow(window, () => addPickedWorkspace(window, workspacePath));
}

async function runManualUpdateCheck(): Promise<void> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const result = await checkForUpdate();

  if (result.status === "update-available") {
    return;
  }

  if (result.status === "up-to-date") {
    const options: MessageBoxOptions = {
      type: "info",
      title: "Bimanus",
      message: `You're up to date on version ${result.currentVersion}.`,
      buttons: ["OK"],
    };
    if (window) {
      await dialog.showMessageBox(window, options);
    } else {
      await dialog.showMessageBox(options);
    }
    return;
  }

  const options: MessageBoxOptions = {
    type: "warning",
    title: "Bimanus",
    message: "Could not check for updates right now.",
    detail: result.message,
    buttons: ["OK"],
  };
  if (window) {
    await dialog.showMessageBox(window, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

function remoteUiEnabled(): boolean {
  const configured = process.env.PI_APP_REMOTE_UI?.trim();
  if (configured) {
    return configured === "1";
  }
  return Boolean(process.env.PI_APP_REMOTE_UI_TOKEN?.trim() || store?.state.remoteUiToken?.trim());
}

function resolveRemoteUiRendererRoot(): string {
  const configured = process.env.PI_APP_REMOTE_UI_ASSETS_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(__dirname, "..", "renderer");
}

function resolveRemoteUiToken(): string {
  const token = process.env.PI_APP_REMOTE_UI_TOKEN?.trim();
  if (token) {
    return token;
  }
  const persistedToken = store?.state.remoteUiToken?.trim();
  if (persistedToken) {
    return persistedToken;
  }
  throw new Error("PI_APP_REMOTE_UI_TOKEN is required when PI_APP_REMOTE_UI=1.");
}

function resolveRemoteUiPort(): number {
  const configuredPort = process.env.PI_APP_REMOTE_UI_PORT?.trim();
  return normalizeRemoteUiPort(configuredPort || store.state.remoteUiPort);
}

function resolveDevRendererPort(): number {
  return Number(process.env.PI_APP_DEV_PORT?.trim() || "43173");
}

async function startRemoteUiServer(): Promise<void> {
  if (!remoteUiEnabled()) {
    store.setRemoteUiStatus({ state: "disabled" });
    return;
  }
  if (remoteUiServer) {
    return;
  }
  const host = process.env.PI_APP_REMOTE_UI_HOST?.trim() || "0.0.0.0";
  const port = resolveRemoteUiPort();
  let token: string;
  try {
    token = resolveRemoteUiToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    store.setRemoteUiStatus({ state: "error", host, port, error: message });
    return;
  }
  store.setRemoteUiStatus({ state: "starting", host, port });
  remoteUiServer = new RemoteUiServer({
    host,
    port,
    getToken: resolveRemoteUiToken,
    rendererRoot: resolveRemoteUiRendererRoot(),
    invoke: handleRemoteUiInvoke,
    invokeRemoteAgent: handleRemoteAgentInvoke,
    onClientConnected: (client) => {
      if (!remoteViews.has(client.id)) remoteViews.set(client.id, resolveWindowView());
      remoteSystemService.clientConnected(client.id);
    },
    onClientDisconnected: (client) => {
      remoteViews.delete(client.id);
      remoteSystemService.disposeClient(client.id);
    },
    onExecutionConnected: (client) => remoteSystemService.clientConnected(client.id),
    onExecutionDisconnected: (client) => remoteSystemService.disposeClient(client.id),
  });
  stopPublishingRemoteState = store.subscribe((state) => {
    publishStateToRemoteClients(state);
  });
  await remoteUiServer
    .start()
    .then(({ port: listeningPort, url }) => {
      console.log(`pi-gui remote UI listening on ${url}`);
      store.setRemoteUiStatus({ state: "running", host, port: listeningPort, url });
      if (host === "0.0.0.0") {
        console.log("pi-gui remote UI is bound to all interfaces. Replace localhost with this machine's LAN IP on other devices.");
      }
      if (isDev) {
        console.log(
          `pi-gui dev remote renderer entry: http://<this-machine-lan-ip>:${resolveDevRendererPort()}/?token=${encodeURIComponent(token)}`,
        );
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Unable to start pi-gui remote UI server:", message);
      remoteUiServer = undefined;
      stopPublishingRemoteState?.();
      stopPublishingRemoteState = undefined;
      store.setRemoteUiStatus({ state: "error", host, port, error: message });
    });
}

async function stopRemoteUiServer(): Promise<void> {
  stopPublishingRemoteState?.();
  stopPublishingRemoteState = undefined;
  remoteViews.clear();
  const server = remoteUiServer;
  remoteUiServer = undefined;
  await server?.close().catch(() => undefined);
  store.setRemoteUiStatus({ state: remoteUiEnabled() ? "stopped" : "disabled" });
}

async function restartRemoteUiServer(): Promise<void> {
  await stopRemoteUiServer();
  await startRemoteUiServer();
}

const REMOTE_AGENT_DEFAULT_TIMEOUT_MS = 0;
const REMOTE_AGENT_RESULT_POLL_MS = 750;
const REMOTE_AGENT_RESULT_STABLE_MS = 2_000;
const REMOTE_AGENT_REPLAY_STABLE_MS = 6_000;
const OPENCODE_EXPORT_TIMEOUT_MS = 10_000;
const OPENCODE_EXPORT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const OPENCODE_TUI_PORT = 4097;
const OPENCODE_HTTP_TIMEOUT_MS = 120_000;
const OPENCODE_HTTP_POLL_INTERVAL_MS = 500;

type RemoteAgentCliMode = SplitPanelCliType;

async function handleRemoteAgentInvoke(request: RemoteAgentInvokeRequest): Promise<unknown> {
  const workspacePath = path.resolve(request.workspacePath);
  const requestStartedAt = Date.now();
  const timeoutMs = normalizeRemoteAgentTimeout(request.timeoutMs);
  const codingAgent = request.codingAgent ?? "pi-coding-agent";
  const cliMode = remoteCodingAgentToCliMode(codingAgent);
  console.info("[pi-gui-remote-agent] invoke_start", {
    timestamp: new Date().toISOString(),
    workspacePath,
    newSession: request.newSession === true,
    sessionId: request.sessionId,
    codingAgent,
    promptLength: request.prompt.length,
    timeoutMs,
  });

  // Guard disabled / missing external CLIs before workspace setup or PTY launch.
  if (cliMode) {
    await assertRemoteCliAvailable(cliMode);
  }

  const workspaceStats = await stat(workspacePath).catch(() => undefined);
  if (!workspaceStats?.isDirectory()) {
    console.warn("[pi-gui-remote-agent] workspace_invalid", {
      timestamp: new Date().toISOString(),
      workspacePath,
    });
    throw new Error(`Remote agent workspace does not exist or is not a directory: ${workspacePath}`);
  }

  const requestedSessionId = request.sessionId?.trim();
  const shouldCreateSession = request.newSession === true || !requestedSessionId;
  const sessionId = shouldCreateSession
    ? `pi-gui-remote-${randomUUID().replace(/-/g, "").slice(0, 24)}`
    : requestedSessionId;
  console.info("[pi-gui-remote-agent] tui_resolved", {
    timestamp: new Date().toISOString(),
    cwd: workspacePath,
    clientId: request.clientId,
    sessionId,
    codingAgent,
    newSession: shouldCreateSession,
  });

  // Bug 1 fix: use foreground window's owner so local UI shares the same PTY root key.
  const foregroundWindow = getForegroundAppWindow();
  const terminalWindow = foregroundWindow ?? mainWindow;
  const terminalOwner = terminalWindow && canPublishToWindow(terminalWindow)
    ? terminalOwnerFromWebContents(terminalWindow.webContents)
    : terminalOwnerFromRemoteClient(request.clientId);
  let terminalId: string | undefined;
  let splitPanelTabId: string | undefined;
  let workspaceIdForCloseTab: string | undefined;
  let terminalClosedForAbort = false;
  const closeRemoteAgentTerminal = () => {
    if (!terminalId || terminalClosedForAbort) {
      return;
    }
    const closedTerminalId = terminalId;
    terminalClosedForAbort = true;
    try {
      getTerminalService().close(terminalOwner, closedTerminalId);
      console.info("[pi-gui-remote-agent] abort_terminal_closed", {
        timestamp: new Date().toISOString(),
        sessionId,
        terminalId: closedTerminalId,
      });
    } catch (error) {
      console.warn("[pi-gui-remote-agent] abort_terminal_close_failed", {
        timestamp: new Date().toISOString(),
        sessionId,
        terminalId: closedTerminalId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    }
  };
  // 任务结束后清理：kill PTY + 通知渲染进程关闭分屏 Tab（仅外部 Agent 场景）
  const cleanupRemoteAgent = () => {
    if (request.closeOnComplete === false) {
      return;
    }
    if (terminalId) {
      try {
        getTerminalService().close(terminalOwner, terminalId);
        console.info("[pi-gui-remote-agent] cleanup_terminal_closed", {
          timestamp: new Date().toISOString(),
          sessionId,
          terminalId,
          codingAgent,
        });
      } catch (error) {
        console.warn("[pi-gui-remote-agent] cleanup_terminal_close_failed", {
          timestamp: new Date().toISOString(),
          sessionId,
          terminalId,
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
        });
      }
    }
    if (cliMode && splitPanelTabId && terminalWindow && canPublishToWindow(terminalWindow) && workspaceIdForCloseTab) {
      const closeEvent: CloseCodingCliEvent = {
        workspaceId: workspaceIdForCloseTab,
        tabId: splitPanelTabId,
        cliType: cliMode,
      };
      terminalWindow.webContents.send(desktopIpc.closeCodingCli, closeEvent);
      console.info("[pi-gui-remote-agent] cleanup_close_tab_sent", {
        timestamp: new Date().toISOString(),
        sessionId,
        tabId: splitPanelTabId,
        cliType: cliMode,
      });
    }
  };
  const onAbort = () => {
    closeRemoteAgentTerminal();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfRemoteAgentAborted(request.signal);
    const state = await store.addWorkspace(workspacePath);
    const workspace = state.workspaces.find((entry) => path.resolve(entry.path) === workspacePath);
    if (!workspace) {
      throw new Error(`Remote agent workspace was not registered: ${workspacePath}`);
    }
    const baselineTranscript = cliMode
      ? []
      : await store.reloadSessionTranscriptFromDisk({
          workspaceId: workspace.id,
          sessionId,
        }).catch((): SessionTranscriptItem[] => []);
    workspaceIdForCloseTab = workspace.id;
    splitPanelTabId = cliMode ? `remote-coding-cli-${randomUUID().replace(/-/g, "").slice(0, 24)}` : undefined;
    const terminalScopeId = splitPanelTabId ? `split-panel:${splitPanelTabId}` : `pi-tui-tabs:${workspace.id}`;
    const launchConfig: TerminalLaunchConfig = cliMode
      ? {
          mode: cliMode,
          prompt: request.prompt.trimEnd(),
        }
      : shouldCreateSession
        ? {
            mode: "pi-tui",
            newSessionKey: `remote-agent:${sessionId}`,
            newSessionId: sessionId,
          }
        : {
            mode: "pi-tui",
            sessionId,
          };
    const panel = await getTerminalService().createSession(
      terminalOwner,
      workspace.id,
      terminalScopeId,
      { cols: 100, rows: 30 },
      launchConfig,
    );
    terminalId = panel.activeSessionId;
    const activeTerminal = panel.sessions.find((session) => session.id === terminalId);
    if (activeTerminal?.status === "error") {
      throw new Error(`Remote Pi terminal failed to launch: ${terminalReplayError(activeTerminal.replay)}`);
    }
    if (cliMode && splitPanelTabId && terminalWindow && canPublishToWindow(terminalWindow)) {
      const event: OpenCodingCliEvent = {
        workspaceId: workspace.id,
        workspacePath,
        cliType: cliMode,
        tabId: splitPanelTabId,
        terminalId: terminalId ?? "",
        prompt: request.prompt.trimEnd(),
      };
      terminalWindow.webContents.send(desktopIpc.openCodingCli, event);
    }
    throwIfRemoteAgentAborted(request.signal);

    let text = "";
    let transcriptLength = baselineTranscript.length;
    if (terminalId && request.prompt.trim()) {
      const waitResult = cliMode
        ? cliMode === "opencode"
          ? await waitForOpenCodeRemoteAgentResult({
              terminalOwner,
              workspacePath,
              terminalId,
              timeoutMs,
              requestStartedAt,
              signal: request.signal,
            })
          : await waitForRemoteAgentReplayResult({
              terminalOwner,
              terminalId,
              timeoutMs,
              requestStartedAt,
              signal: request.signal,
              baselineReplayLength: 0,
            })
        : await waitForPiRemoteAgentResult({
            terminalOwner,
            workspaceId: workspace.id,
            sessionId,
            terminalId,
            baselineLength: baselineTranscript.length,
            timeoutMs,
            requestStartedAt,
            signal: request.signal,
            prompt: request.prompt,
          });
      text = waitResult.text;
      transcriptLength = waitResult.transcriptLength;
    }
    const result = {
      mode: "tui",
      clientId: request.clientId,
      codingAgent,
      workspaceId: workspace.id,
      sessionId,
      text,
      terminalId,
      terminalScopeId,
      panel,
      transcriptLength,
      durationMs: Date.now() - requestStartedAt,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    };
    cleanupRemoteAgent();
    console.info("[pi-gui-remote-agent] tui_launch_success", {
      timestamp: new Date().toISOString(),
      sessionId,
      terminalId,
      textLength: text.length,
      durationMs: result.durationMs,
    });
    return result;
  } catch (error) {
    if (request.signal?.aborted || isRemoteAgentAbortError(error)) {
      closeRemoteAgentTerminal();
      console.warn("[pi-gui-remote-agent] tui_launch_aborted", {
        timestamp: new Date().toISOString(),
        sessionId,
        terminalId,
        durationMs: Date.now() - requestStartedAt,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    } else {
      cleanupRemoteAgent();
      console.error("[pi-gui-remote-agent] tui_launch_failed", {
        timestamp: new Date().toISOString(),
        sessionId,
        terminalId,
        durationMs: Date.now() - requestStartedAt,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    }
    throw error;
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
  }
}

function normalizeRemoteAgentTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return REMOTE_AGENT_DEFAULT_TIMEOUT_MS;
  }
  const timeout = Math.floor(value);
  if (timeout <= 0) {
    return 0;
  }
  return Math.max(1_000, timeout);
}

function remoteCodingAgentToCliMode(codingAgent: RemoteCodingAgent): RemoteAgentCliMode | undefined {
  switch (codingAgent) {
    case "codex":
      return "codex";
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "grok":
      return "grok";
    case "copilot":
      return "copilot";
    case "antigravity":
      return "antigravity";
    case "kiro":
      return "kiro";
    case "cursor":
      return "cursor";
    case "droid":
      return "droid";
    case "pi-coding-agent":
      return undefined;
  }
}

/**
 * Remote AI callers should fail fast with a uniform "not installed" message when
 * the target CLI is user-disabled or physically missing on this machine.
 */
async function assertRemoteCliAvailable(cliMode: RemoteAgentCliMode): Promise<void> {
  await store.getState();
  if (!isCliEnabled(store.state.cliEnablement, cliMode)) {
    throw new Error(cliNotInstalledRemoteError(cliMode));
  }

  const detection = await getCliDetector().detectOne(cliMode);
  if (!detection.installed) {
    throw new Error(cliNotInstalledRemoteError(cliMode));
  }
}

interface RemoteAgentWaitOptions {
  readonly terminalOwner: TerminalOwner;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly terminalId: string;
  readonly baselineLength: number;
  readonly timeoutMs: number;
  readonly requestStartedAt: number;
  readonly signal?: AbortSignal;
}

interface PiRemoteAgentWaitOptions extends RemoteAgentWaitOptions {
  readonly prompt: string;
}

interface RemoteAgentWaitResult {
  readonly text: string;
  readonly transcriptLength: number;
}

async function waitForPiRemoteAgentResult(options: PiRemoteAgentWaitOptions): Promise<RemoteAgentWaitResult> {
  // Bug 3 fix: wait for the pi TUI to produce its first output before writing,
  // so the prompt is not swallowed during the cold-start initialization period.
  await waitForTuiReady(options.terminalOwner, options.terminalId, options.signal);
  throwIfRemoteAgentAborted(options.signal);
  getTerminalService().write(options.terminalOwner, options.terminalId, `${options.prompt.trimEnd()}\r`);
  return waitForRemoteAgentResult(options);
}

async function waitForOpenCodeRemoteAgentResult(
  options: Pick<RemoteAgentWaitOptions, "terminalOwner" | "terminalId" | "timeoutMs" | "requestStartedAt" | "signal"> & {
    readonly workspacePath: string;
  },
): Promise<RemoteAgentWaitResult> {
  // 1. 等 TUI 就绪（确保 PTY 已经启动，Server 已经就绪）
  await waitForTuiReady(options.terminalOwner, options.terminalId, options.signal);
  throwIfRemoteAgentAborted(options.signal);

  // 2. 等待 HTTP Server 就绪（轮询 /global/health 端点）
  //    使用 session 上动态分配的端口（每个 OpenCode 会话独占一个端口）
  const sessionSnapshot = getTerminalService().getSessionSnapshot(options.terminalOwner, options.terminalId);
  const opencodePort = sessionSnapshot?.cliPort ?? OPENCODE_TUI_PORT;
  const baseUrl = `http://127.0.0.1:${opencodePort}`;
  const serverDeadline = Date.now() + 10_000; // 最多等 10 秒
  let serverReady = false;
  while (Date.now() < serverDeadline) {
    throwIfRemoteAgentAborted(options.signal);
    try {
      const healthRes = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2_000) });
      if (healthRes.ok) {
        serverReady = true;
        break;
      }
    } catch {
      // 服务还没就绪，继续等
    }
    await sleepWithAbort(500, options.signal);
  }
  if (!serverReady) {
    throw new Error("OpenCode TUI HTTP server did not become ready within 10 seconds.");
  }

  // 3. 从已启动的 PTY session 的 launchConfig 中获取 prompt
  const snapshot = getTerminalService().getSessionSnapshot(options.terminalOwner, options.terminalId);
  const prompt = snapshot?.launchConfig && 'prompt' in snapshot.launchConfig
    ? (snapshot.launchConfig as any).prompt
    : '';
  if (!prompt) {
    throw new Error("OpenCode remote agent prompt not found in terminal launch config.");
  }

  // 4. 通过 HTTP API 创建 session 并发送 prompt
  throwIfRemoteAgentAborted(options.signal);

  // 4a. 创建新 session
  const createRes = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `remote-agent-${Date.now().toString(36)}` }),
    signal: options.signal,
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create OpenCode session: ${createRes.status} ${await createRes.text().catch(() => '')}`);
  }
  const createResult = await createRes.json() as any;
  const sessionId: string = createResult?.id ?? createResult?.data?.id ?? '';
  if (!sessionId) {
    throw new Error("OpenCode session creation returned no session ID.");
  }

  // 4b. 发送 prompt，并通过终端状态轮询监控完成（避免 HTTP 长连接死等）
  //     OpenCode 的 HTTP /message 端点可能在 CLI 执行结束后仍不闭合响应流，
  //     因此不直接 await fetch，而是后台发起请求，转而轮询底层 PTY 状态：
  //     一旦 PTY 退出即中止 HTTP 等待，并通过 `opencode export` 兜底取回结果。
  throwIfRemoteAgentAborted(options.signal);
  const fetchAbort = new AbortController();
  const userAbortHandler = () => fetchAbort.abort();
  options.signal?.addEventListener("abort", userAbortHandler, { once: true });
  let promptResult: any | undefined;
  let promptFetchError: Error | undefined;

  const promptFetchPromise = fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: prompt }],
    }),
    signal: fetchAbort.signal,
  }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`OpenCode prompt failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    promptResult = await res.json() as any;
  }).catch((error) => {
    // 仅当非我们主动中止、或确实是用户中止时才记录为错误
    if (!fetchAbort.signal.aborted || options.signal?.aborted) {
      promptFetchError = error instanceof Error ? error : new Error(String(error));
    }
  });

  try {
    const deadline = options.timeoutMs > 0 ? options.requestStartedAt + options.timeoutMs : undefined;
    for (;;) {
      throwIfRemoteAgentAborted(options.signal);
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("OpenCode remote agent did not finish before timeout.");
      }

      // HTTP 响应已返回：优先走原有解析路径
      if (promptResult !== undefined) {
        const text = extractOpenCodeResponseText(promptResult);
        if (text) {
          return { text, transcriptLength: 0 };
        }
        // HTTP 返回但无文本，继续等待终端结束走 export 兜底
      }
      if (promptFetchError !== undefined) {
        throw promptFetchError;
      }

      // 检查底层 PTY 是否已退出：CLI 已结束但 HTTP 仍未返回时，熔断死等
      const terminal = getTerminalService().getSessionSnapshot(options.terminalOwner, options.terminalId);
      if (terminal && terminal.status !== "running") {
        fetchAbort.abort();
        await promptFetchPromise.catch(() => {});
        const fallbackText = await readLatestOpenCodeAssistantText(options.workspacePath, options.requestStartedAt);
        if (fallbackText) {
          return { text: fallbackText, transcriptLength: 0 };
        }
        if (promptResult !== undefined) {
          throw new Error("OpenCode completed, but no assistant response could be extracted from HTTP response.");
        }
        throw new Error(`OpenCode terminal ${terminal.status} before producing an assistant response.`);
      }

      const remaining = deadline === undefined ? REMOTE_AGENT_RESULT_POLL_MS : deadline - Date.now();
      await sleepWithAbort(Math.max(1, Math.min(REMOTE_AGENT_RESULT_POLL_MS, remaining)), options.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", userAbortHandler);
    fetchAbort.abort();
  }
}

/**
 * 从 OpenCode HTTP API 的 response 中提取 assistant 回复文本
 */
function extractOpenCodeResponseText(response: any): string | undefined {
  // 尝试从标准结构提取
  // 格式1: { info: { role: "assistant" }, parts: [{ type: "text", text: "..." }] }
  if (response?.parts && Array.isArray(response.parts)) {
    const textParts = response.parts
      .filter((part: any) => part.type === "text" && typeof part.text === "string" && part.text.trim())
      .map((part: any) => part.text.trim());
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  // 格式2: { data: { info: { role: "assistant" }, parts: [...] } }
  if (response?.data?.parts && Array.isArray(response.data.parts)) {
    const textParts = response.data.parts
      .filter((part: any) => part.type === "text" && typeof part.text === "string" && part.text.trim())
      .map((part: any) => part.text.trim());
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  // 格式3: { content: [...] }
  const content = response?.content ?? response?.data?.content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((item: any) => item.type === "text" && typeof item.text === "string" && item.text.trim())
      .map((item: any) => item.text.trim());
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  // 兜底：递归搜索
  return deepFindOpenCodeText(response);
}

function deepFindOpenCodeText(value: any): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = deepFindOpenCodeText(item);
      if (result) return result;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    // 优先搜索常见的文本字段
    for (const key of ["text", "content", "message", "markdown", "output"]) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return value[key].trim();
      }
    }
    // 递归搜索所有子对象
    for (const child of Object.values(value)) {
      const result = deepFindOpenCodeText(child);
      if (result) return result;
    }
  }
  return undefined;
}

async function waitForRemoteAgentReplayResult(
  options: Pick<RemoteAgentWaitOptions, "terminalOwner" | "terminalId" | "timeoutMs" | "requestStartedAt" | "signal"> & {
    readonly baselineReplayLength: number;
    readonly requireTurnEndMarker?: boolean;
    readonly stableMs?: number;
  },
): Promise<RemoteAgentWaitResult> {
  const deadline = options.timeoutMs > 0 ? options.requestStartedAt + options.timeoutMs : undefined;
  const stableMs = options.stableMs ?? REMOTE_AGENT_RESULT_STABLE_MS;
  const requireTurnEndMarker = options.requireTurnEndMarker !== false;
  let lastText = "";
  let stableSince = 0;

  for (;;) {
    throwIfRemoteAgentAborted(options.signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error("Remote coding CLI did not produce stable output before timeout.");
    }

    const terminal = getTerminalService().getSessionSnapshot(options.terminalOwner, options.terminalId);
    const replay = terminal?.replay ?? "";
    const text = stripTerminalControlForDiagnostics(replay.slice(options.baselineReplayLength)).trim();
    const now = Date.now();
    if (text && text !== lastText) {
      lastText = text;
      stableSince = now;
    }
    if (text && terminal?.status !== "running") {
      return { text, transcriptLength: 0 };
    }
    if (
      text &&
      now - stableSince >= stableMs &&
      (!requireTurnEndMarker || looksLikeCodingCliTurnEnded(text))
    ) {
      return { text, transcriptLength: 0 };
    }
    if (terminal && terminal.status !== "running" && !text) {
      throw new Error(`Remote coding CLI terminal ${terminal.status} before producing output.`);
    }

    const remaining = deadline === undefined ? REMOTE_AGENT_RESULT_POLL_MS : deadline - Date.now();
    await sleepWithAbort(Math.max(1, Math.min(REMOTE_AGENT_RESULT_POLL_MS, remaining)), options.signal);
  }
}

function looksLikeCodingCliTurnEnded(text: string): boolean {
  const tail = text.slice(-500).toLowerCase();
  return /\b(done|completed|finished)\b|press enter|ctrl\+c|esc to|tokens used/.test(tail);
}

async function readLatestOpenCodeAssistantText(workspacePath: string, requestStartedAt: number): Promise<string | undefined> {
  try {
    const opencodeCommand = await resolveOpenCodeCommand();
    const { stdout: listStdout } = await execFileAsync(
      opencodeCommand,
      ["session", "list", "--format", "json", "--max-count", "10"],
      {
        cwd: workspacePath,
        timeout: OPENCODE_EXPORT_TIMEOUT_MS,
        maxBuffer: OPENCODE_EXPORT_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
    );
    const sessionId = selectOpenCodeSessionId(parseJsonOutput(String(listStdout)), workspacePath, requestStartedAt);
    if (!sessionId) {
      return undefined;
    }
    const { stdout: exportStdout } = await execFileAsync(
      opencodeCommand,
      ["export", sessionId],
      {
        cwd: workspacePath,
        timeout: OPENCODE_EXPORT_TIMEOUT_MS,
        maxBuffer: OPENCODE_EXPORT_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
    );
    return extractLatestOpenCodeAssistantText(parseJsonOutput(String(exportStdout)));
  } catch (error) {
    console.warn("[pi-gui-remote-agent] opencode_export_failed", {
      timestamp: new Date().toISOString(),
      workspacePath,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    });
    return undefined;
  }
}

async function resolveOpenCodeCommand(): Promise<string> {
  const detection = await CliAdapterRegistry.getInstance().getAdapter(AdapterCliType.OpenCode).detect().catch(() => undefined);
  return detection?.binaryPath || "opencode";
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  return JSON.parse(trimmed);
}

function findOpenCodeSessionId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const sessionId = findOpenCodeSessionId(item);
      if (sessionId) {
        return sessionId;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["id", "sessionID", "sessionId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  for (const child of Object.values(value)) {
    const sessionId = findOpenCodeSessionId(child);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

function selectOpenCodeSessionId(value: unknown, workspacePath: string, requestStartedAt: number): string | undefined {
  const sessions = parseOpenCodeSessionList(value);
  const matching = sessions
    .filter((session) => !session.directory || path.resolve(session.directory) === workspacePath)
    .filter((session) => session.updated === undefined || session.updated >= requestStartedAt - 60_000)
    .sort((left, right) => (right.updated ?? 0) - (left.updated ?? 0));
  return matching[0]?.id ?? findOpenCodeSessionId(value);
}

interface OpenCodeSessionListEntry {
  readonly id: string;
  readonly directory?: string;
  readonly updated?: number;
}

function parseOpenCodeSessionList(value: unknown): OpenCodeSessionListEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): OpenCodeSessionListEntry[] => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      return [];
    }
    return [{
      id: item.id.trim(),
      directory: typeof item.directory === "string" && item.directory.trim() ? item.directory.trim() : undefined,
      updated: typeof item.updated === "number" && Number.isFinite(item.updated) ? item.updated : undefined,
    }];
  });
}

function extractLatestOpenCodeAssistantText(value: unknown): string | undefined {
  const blocks: string[] = [];
  collectOpenCodeAssistantBlocks(value, blocks);
  return blocks.at(-1)?.trim() || undefined;
}

function collectOpenCodeAssistantBlocks(value: unknown, blocks: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOpenCodeAssistantBlocks(item, blocks);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (isOpenCodeAssistantRecord(value)) {
    const parts: string[] = [];
    collectOpenCodeTextFields(value, parts);
    const text = dedupeAdjacentStrings(parts).join("\n").trim();
    if (text) {
      blocks.push(text);
    }
    return;
  }
  for (const child of Object.values(value)) {
    collectOpenCodeAssistantBlocks(child, blocks);
  }
}

function collectOpenCodeTextFields(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOpenCodeTextFields(item, parts);
    }
    return;
  }
  if (!isRecord(value) || isOpenCodeNonAnswerRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && isOpenCodeTextKey(key) && child.trim()) {
      parts.push(child.trim());
      continue;
    }
    collectOpenCodeTextFields(child, parts);
  }
}

function isOpenCodeAssistantRecord(value: Record<string, unknown>): boolean {
  if (["role", "author", "actor", "type"].some((key) => normalizeOpenCodeTag(value[key]) === "assistant")) {
    return true;
  }
  return isRecord(value.info) && normalizeOpenCodeTag(value.info.role) === "assistant";
}

function isOpenCodeNonAnswerRecord(value: Record<string, unknown>): boolean {
  const tag = normalizeOpenCodeTag(value.type) || normalizeOpenCodeTag(value.role);
  return Boolean(tag && (tag.includes("tool") || tag.includes("reasoning")));
}

function normalizeOpenCodeTag(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function isOpenCodeTextKey(key: string): boolean {
  return key === "text" || key === "content" || key === "message" || key === "markdown" || key === "output";
}

function dedupeAdjacentStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (result.at(-1) !== value) {
      result.push(value);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Bug 3 fix: poll the PTY replay until the pi TUI has produced its first output,
// indicating it is past the cold-start phase and ready to receive input.
async function waitForTuiReady(owner: TerminalOwner, terminalId: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    throwIfRemoteAgentAborted(signal);
    const snapshot = getTerminalService().getSessionSnapshot(owner, terminalId);
    if (!snapshot || snapshot.status !== "running") {
      return;
    }
    if (snapshot.replay.length > 0) {
      // Give the TUI a brief extra moment to finish rendering its input prompt.
      await sleepWithAbort(500, signal);
      return;
    }
    await sleepWithAbort(200, signal);
  }
}

async function waitForRemoteAgentResult(options: RemoteAgentWaitOptions): Promise<RemoteAgentWaitResult> {
  const deadline = options.timeoutMs > 0 ? options.requestStartedAt + options.timeoutMs : undefined;
  let lastMarker = "";
  let stableSince = 0;
  let lastReadError: unknown;
  // Bug 4 fix: track whether we've already triggered a state refresh so the
  // new session appears in the sidebar on the first successful transcript read.
  let sessionListRefreshed = false;

  for (;;) {
    throwIfRemoteAgentAborted(options.signal);
    if (deadline !== undefined && Date.now() >= deadline) {
      const detail = lastReadError instanceof Error ? ` Last transcript read error: ${lastReadError.message}` : "";
      throw new Error(`Remote Pi did not produce an assistant response before timeout.${detail}`);
    }

    let readyCandidate: RemoteAgentWaitResult | undefined;
    try {
      const transcript = await store.reloadSessionTranscriptFromDisk({
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
      });
      // Bug 4 fix: once the session exists on disk, refresh state so the sidebar
      // can show it without waiting for a process restart.
      if (!sessionListRefreshed && transcript.length > 0) {
        sessionListRefreshed = true;
        store.refreshState({
          selectedWorkspaceId: options.workspaceId,
          selectedSessionId: options.sessionId,
        }).catch((err: unknown) => {
          console.warn("[pi-gui-remote-agent] session list refresh failed", err);
        });
      }
      const candidate = latestAssistantAfterBaseline(transcript, options.baselineLength);
      if (candidate) {
        const marker = `${candidate.id}:${candidate.text}`;
        const now = Date.now();
        if (marker !== lastMarker) {
          lastMarker = marker;
          stableSince = now;
        }
        if (
          now - stableSince >= REMOTE_AGENT_RESULT_STABLE_MS &&
          !hasPendingToolAfter(transcript, candidate.index)
        ) {
          return { text: candidate.text, transcriptLength: transcript.length };
        }
        if (!hasPendingToolAfter(transcript, candidate.index)) {
          readyCandidate = { text: candidate.text, transcriptLength: transcript.length };
        }
      }
      lastReadError = undefined;
    } catch (error) {
      lastReadError = error;
    }
    // Bug 1 fix: use the passed terminalOwner (which matches the PTY's actual owner)
    // so getSessionSnapshot finds the session correctly.
    const terminal = getTerminalService().getSessionSnapshot(
      options.terminalOwner,
      options.terminalId,
    );
    if (terminal && terminal.status !== "running") {
      if (readyCandidate) {
        return readyCandidate;
      }
      throw new Error(`Remote Pi terminal ${terminal.status} before producing an assistant response: ${terminalReplayError(terminal.replay)}`);
    }

    const remaining = deadline === undefined ? REMOTE_AGENT_RESULT_POLL_MS : deadline - Date.now();
    await sleepWithAbort(Math.max(1, Math.min(REMOTE_AGENT_RESULT_POLL_MS, remaining)), options.signal);
  }
}

function createRemoteAgentAbortError(): Error {
  const error = new Error("Remote Pi request was aborted by the client.");
  error.name = "AbortError";
  return error;
}

function throwIfRemoteAgentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createRemoteAgentAbortError();
  }
}

function isRemoteAgentAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  throwIfRemoteAgentAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(createRemoteAgentAbortError());
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function latestAssistantAfterBaseline(
  transcript: readonly SessionTranscriptItem[],
  baselineLength: number,
): { readonly id: string; readonly text: string; readonly index: number } | undefined {
  const start = Math.max(0, Math.min(baselineLength, transcript.length));
  let searchStart = start;
  for (let index = start; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind === "message" && item.role === "user") {
      searchStart = index + 1;
    }
  }

  let candidate: { readonly id: string; readonly text: string; readonly index: number } | undefined;
  for (let index = searchStart; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind !== "message" || item.role !== "assistant") {
      continue;
    }
    const text = item.text.trim();
    if (text) {
      candidate = { id: item.id, text, index };
    }
  }
  return candidate;
}

// Returns true if, after the given assistant message index, there are tool entries
// but no subsequent assistant message has appeared yet — meaning the AI turn is still
// in progress (either a tool is running, or the AI hasn't yet responded to tool results).
function hasPendingToolAfter(transcript: readonly SessionTranscriptItem[], index: number): boolean {
  const tail = transcript.slice(index + 1);
  const hasAnyTool = tail.some((item) => item.kind === "tool");
  if (!hasAnyTool) {
    return false;
  }
  // If there's a newer assistant message after the tools, the AI has already
  // processed those results and we should use that later message as the candidate.
  // latestAssistantAfterBaseline already picks the last assistant message, so if
  // we're here, there is no later assistant message — the turn is still open.
  return true;
}

function terminalReplayError(replay: string): string {
  const plain = replay.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return plain.slice(-1_000) || "unknown terminal error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRemoteUiInvoke(request: RemoteUiInvokeRequest): Promise<unknown> {
  const { client, channel, args } = request;
  const terminalOwner = () => terminalOwnerFromRemoteClient(client.id);
  switch (channel) {
    case "remote-system/get-operating-system":
      return remoteSystemService.getOperatingSystem(client.id);
    case "remote-system/get-directory-tree":
    case "remote-system/get-import-files-metadata":
    case "remote-system/read-file":
    case "remote-system/read-import-file-chunk":
    case "remote-system/read-file-lines":
    case "remote-system/find-files":
    case "remote-system/grep-files":
    case "remote-system/write-file":
    case "remote-system/replace-in-file":
      return remoteSystemService.invokeFile(client.id, channel.slice("remote-system/".length), args[0]);
    case "remote-system/execute-shell":
      return remoteSystemService.executeShell(client.id, args[0]);
    case "remote-system/shell-status":
      return remoteSystemService.getShellStatus(client.id, args[0]);
    case "remote-system/kill-shell":
      return remoteSystemService.killShell(client.id, args[0]);
    case desktopIpc.ping:
      return devReloadMarkersEnabled ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}` : "pi desktop ready";
    case desktopIpc.getThemeMode:
      return themeManager.getMode();
    case desktopIpc.getResolvedTheme:
      return themeManager.getResolvedTheme();
    case desktopIpc.setThemeMode: {
      const mode = args[0] as ThemeMode;
      themeManager.setMode(mode);
      remoteUiServer?.publish("theme-changed", themeManager.getResolvedTheme());
      return mode;
    }
    case desktopIpc.openExternal: {
      const url = String(args[0] ?? "");
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`Refusing to open unsupported URL: ${url}`);
      }
      await shell.openExternal(url);
      return undefined;
    }
    case desktopIpc.stateRequest: {
      const state = projectStateForRemoteClient(client.id);
      rememberRemoteView(client.id, state);
      return state;
    }
    case desktopIpc.addWorkspacePath:
      return runRemoteScopedForClient(client.id, () => store.addWorkspace(String(args[0] ?? "")));
    case desktopIpc.pickWorkspace:
      return runRemoteScopedForClient(client.id, async () => {
        const workspacePath = await pickWorkspacePathViaDialog(mainWindow);
        if (!workspacePath) {
          return store.getStateForView(viewForRemoteClient(client.id));
        }
        const nextState = await addPickedWorkspace(undefined, workspacePath);
        if (nextState.selectedWorkspaceId) {
          remoteUiServer?.publish("workspace-picked", nextState.selectedWorkspaceId, client.id);
        }
        return nextState;
      });
    case desktopIpc.selectWorkspace:
      return runRemoteScopedForClient(client.id, () => store.selectWorkspace(String(args[0] ?? "")));
    case desktopIpc.renameWorkspace:
      return runRemoteScopedForClient(client.id, () => store.renameWorkspace(String(args[0] ?? ""), String(args[1] ?? "")));
    case desktopIpc.removeWorkspace:
      return runRemoteScopedForClient(client.id, () => store.removeWorkspace(String(args[0] ?? "")));
    case desktopIpc.reorderWorkspaces:
      return runRemoteScopedForClient(client.id, () => store.reorderWorkspaces(args[0] as readonly string[]));
    case desktopIpc.openWorkspaceInFinder: {
      const workspacePath = store.getWorkspacePath(String(args[0] ?? ""));
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${String(args[0] ?? "")}`);
      }
      await shell.openPath(workspacePath);
      return undefined;
    }
    case desktopIpc.createWorktree:
      return runRemoteScopedForClient(client.id, () => store.createWorktree(args[0] as CreateWorktreeInput));
    case desktopIpc.removeWorktree:
      return runRemoteScopedForClient(client.id, () => store.removeWorktree(args[0] as RemoveWorktreeInput));
    case desktopIpc.syncCurrentWorkspace:
      return runRemoteScopedForClient(client.id, () => store.syncCurrentWorkspace());
    case desktopIpc.selectSession:
      return runRemoteScopedForClient(client.id, () => store.selectSession(args[0] as WorkspaceSessionTarget));
    case desktopIpc.archiveSession:
      return runRemoteScopedForClient(client.id, () => store.archiveSession(args[0] as WorkspaceSessionTarget));
    case desktopIpc.unarchiveSession:
      return runRemoteScopedForClient(client.id, () => store.unarchiveSession(args[0] as WorkspaceSessionTarget));
    case desktopIpc.reloadSession:
      return runRemoteScopedForClient(client.id, () => store.reloadSession(args[0] as WorkspaceSessionTarget));
    case desktopIpc.setActiveView:
      return runRemoteScopedForClient(client.id, () => store.setActiveView(args[0] as AppView));
    case desktopIpc.setSidebarCollapsed:
      return runRemoteScopedForClient(client.id, () => store.setSidebarCollapsed(Boolean(args[0])));
    case desktopIpc.setSidebarWidth:
      return runRemoteScopedForClient(client.id, () => store.setSidebarWidth(Number(args[0])));
    case desktopIpc.refreshRuntime:
      return runRemoteScopedForClient(client.id, () => store.refreshRuntime(toOptionalWorkspaceId(args[0])));
    case desktopIpc.setSessionModel:
      return runRemoteScopedForClient(client.id, () =>
        store.setSessionModel({ workspaceId: String(args[0] ?? ""), sessionId: String(args[1] ?? "") }, String(args[2] ?? ""), String(args[3] ?? "")),
      );
    case desktopIpc.setDefaultModel:
      return runRemoteScopedForClient(client.id, () =>
        store.setDefaultModel(toOptionalWorkspaceId(args[0]), String(args[1] ?? ""), String(args[2] ?? "")),
      );
    case desktopIpc.setDefaultThinkingLevel:
      return runRemoteScopedForClient(client.id, () => store.setDefaultThinkingLevel(toOptionalWorkspaceId(args[0]), args[1] as never));
    case desktopIpc.setSessionThinkingLevel:
      return runRemoteScopedForClient(client.id, () =>
        store.setSessionThinkingLevel({ workspaceId: String(args[0] ?? ""), sessionId: String(args[1] ?? "") }, args[2] as never),
      );
    case desktopIpc.loginProvider:
      return runUnscopedStateResultForRemoteClient(client.id, () =>
        store.loginProvider(toOptionalWorkspaceId(args[0]), String(args[1] ?? ""), createRuntimeLoginCallbacks(mainWindow)),
      );
    case desktopIpc.logoutProvider:
      return runRemoteScopedForClient(client.id, () => store.logoutProvider(toOptionalWorkspaceId(args[0]), String(args[1] ?? "")));
    case desktopIpc.setProviderApiKey:
      return runRemoteScopedForClient(client.id, () =>
        store.setProviderApiKey(toOptionalWorkspaceId(args[0]), String(args[1] ?? ""), String(args[2] ?? "")),
      );
    case desktopIpc.addMcpServer:
      return runRemoteScopedForClient(client.id, () => store.addMcpServer(args[0] as McpServerConfigInput));
    case desktopIpc.updateMcpServer:
      return runRemoteScopedForClient(client.id, () =>
        store.updateMcpServer(String(args[0] ?? ""), args[1] as McpServerConfigInput),
      );
    case desktopIpc.removeMcpServer:
      return runRemoteScopedForClient(client.id, () => store.removeMcpServer(String(args[0] ?? "")));
    case desktopIpc.authorizeMcpServer:
      return runUnscopedStateResultForRemoteClient(client.id, () =>
        store.authorizeMcpServer(String(args[0] ?? ""), mcpOAuthManager),
      );
    case desktopIpc.setMcpServerEnabled:
      return runRemoteScopedForClient(client.id, () =>
        store.setMcpServerEnabled(String(args[0] ?? ""), Boolean(args[1])),
      );
    case desktopIpc.setCliEnabled:
      return runRemoteScopedForClient(client.id, () =>
        store.setCliEnabled(String(args[0] ?? ""), Boolean(args[1])),
      );
    case desktopIpc.setEnableSkillCommands:
      return runRemoteScopedForClient(client.id, () => store.setEnableSkillCommands(String(args[0] ?? ""), Boolean(args[1])));
    case desktopIpc.setScopedModelPatterns:
      return runRemoteScopedForClient(client.id, () => store.setScopedModelPatterns(toOptionalWorkspaceId(args[0]), args[1] as readonly string[]));
    case desktopIpc.setSkillEnabled:
      return runRemoteScopedForClient(client.id, () =>
        store.setSkillEnabled(String(args[0] ?? ""), String(args[1] ?? ""), Boolean(args[2])),
      );
    case desktopIpc.removeSkill:
      return runRemoteScopedForClient(client.id, () => store.removeSkill(String(args[0] ?? ""), String(args[1] ?? "")));
    case desktopIpc.setExtensionEnabled:
      return runRemoteScopedForClient(client.id, () =>
        store.setExtensionEnabled(String(args[0] ?? ""), String(args[1] ?? ""), Boolean(args[2])),
      );
    case desktopIpc.removeExtension:
      return runRemoteScopedForClient(client.id, () => store.removeExtension(String(args[0] ?? ""), String(args[1] ?? "")));
    case desktopIpc.installPackage:
      return runRemoteScopedForClient(client.id, () => store.installPackage(String(args[0] ?? ""), String(args[1] ?? "")));
    case desktopIpc.updatePackage:
      return runRemoteScopedForClient(client.id, () => store.updatePackage(String(args[0] ?? ""), String(args[1] ?? ""), args[2] as "user" | "project" | undefined));
    case desktopIpc.removePackage:
      return runRemoteScopedForClient(client.id, () => store.removePackage(String(args[0] ?? ""), String(args[1] ?? ""), args[2] as "user" | "project" | undefined));
    case desktopIpc.setPackageEnabled:
      return runRemoteScopedForClient(client.id, () =>
        store.setPackageEnabled(String(args[0] ?? ""), String(args[1] ?? ""), Boolean(args[2])),
      );
    case desktopIpc.searchPackages:
      return store.searchPackages(String(args[0] ?? ""));
    case desktopIpc.respondToHostUiRequest:
      return runRemoteScopedForClient(client.id, () =>
        store.respondToHostUiRequest({ workspaceId: String(args[0] ?? ""), sessionId: String(args[1] ?? "") }, args[2] as never),
      );
    case desktopIpc.setNotificationPreferences:
      return runRemoteScopedForClient(client.id, () => store.setNotificationPreferences(args[0] as never));
    case desktopIpc.setIntegratedTerminalShell:
      return runRemoteScopedForClient(client.id, () => store.setIntegratedTerminalShell(String(args[0] ?? "")));
    case desktopIpc.setTuiTabLimit:
      return runRemoteScopedForClient(client.id, () => store.setTuiTabLimit(Number(args[0])));
    case desktopIpc.setRemoteUiPort: {
      const nextState = await runRemoteScopedForClient(client.id, () => store.setRemoteUiPort(Number(args[0])));
      await restartRemoteUiServer();
      return nextState;
    }
    case desktopIpc.setRemoteUiToken: {
      const nextState = await runRemoteScopedForClient(client.id, () => store.setRemoteUiToken(String(args[0] ?? "")));
      await startRemoteUiServer();
      return nextState;
    }
    case desktopIpc.setEnableTransparency:
      return runRemoteScopedForClient(client.id, async () => {
        const nextState = await store.setEnableTransparency(Boolean(args[0]));
        if (mainWindow && !mainWindow.isDestroyed() && process.platform === "darwin") {
          mainWindow.setVibrancy(args[0] ? "under-window" : null);
        }
        return nextState;
      });
    case desktopIpc.setTuiBgColor:
      return runRemoteScopedForClient(client.id, () => store.setTuiBgColor(String(args[0] ?? "")));
    case desktopIpc.setSplitPanelBgColor:
      return runRemoteScopedForClient(client.id, () => store.setSplitPanelBgColor(String(args[0] ?? "")));
    case desktopIpc.setLocale:
      return runRemoteScopedForClient(client.id, () => store.setLocale(String(args[0] ?? "auto") as "auto" | "en" | "zh"));
    case desktopIpc.getNotificationPermissionStatus:
      return notificationPermissionService?.getCurrentStatus() ?? "unknown";
    case desktopIpc.requestNotificationPermission:
      return notificationPermissionService?.requestPermission() ?? "unknown";
    case desktopIpc.openSystemNotificationSettings:
      await notificationPermissionService?.openSystemSettings();
      return undefined;
    case desktopIpc.createSession:
      return runRemoteScopedForClient(client.id, () => store.createSession(args[0] as CreateSessionInput));
    case desktopIpc.startThread:
      return runRemoteScopedForClient(client.id, () => store.startThread(args[0] as StartThreadInput));
    case desktopIpc.openSkillInFinder: {
      const resolved = store.getSkillFilePath(String(args[0] ?? ""), String(args[1] ?? ""));
      if (!resolved) {
        throw new Error(`Unknown skill: ${String(args[1] ?? "")}`);
      }
      await shell.openPath(path.dirname(resolved));
      return undefined;
    }
    case desktopIpc.openExtensionInFinder: {
      const resolved = store.getExtensionFilePath(String(args[0] ?? ""), String(args[1] ?? ""));
      if (!resolved) {
        throw new Error(`Unknown extension: ${String(args[1] ?? "")}`);
      }
      await shell.openPath(path.dirname(resolved));
      return undefined;
    }
    case desktopIpc.cancelCurrentRun:
      return runRemoteScopedForClientNow(client.id, () => store.cancelCurrentRun());
    case desktopIpc.readClipboardText:
      return clipboard.readText();
    case desktopIpc.getSessionTree:
      return store.getSessionTree(args[0] as WorkspaceSessionTarget);
    case desktopIpc.navigateSessionTree:
      return runRemoteScopedStateResult(client.id, () =>
        store.navigateSessionTree(args[0] as WorkspaceSessionTarget, String(args[1] ?? ""), args[2] as never),
      );
    case desktopIpc.listWorkspaceFiles: {
      const workspacePath = store.getWorkspacePath(String(args[0] ?? ""));
      return workspacePath ? listWorkspaceFiles(workspacePath) : [];
    }
    case desktopIpc.getChangedFiles: {
      const workspacePath = store.getWorkspacePath(String(args[0] ?? ""));
      return workspacePath ? getChangedFiles(workspacePath) : [];
    }
    case desktopIpc.getFileDiff: {
      const workspacePath = store.getWorkspacePath(String(args[0] ?? ""));
      return workspacePath ? getFileDiff(workspacePath, String(args[1] ?? "")) : "";
    }
    case desktopIpc.stageFile: {
      const workspacePath = store.getWorkspacePath(String(args[0] ?? ""));
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${String(args[0] ?? "")}`);
      }
      await stageFile(workspacePath, String(args[1] ?? ""));
      return undefined;
    }
    case desktopIpc.terminalEnsurePanel:
      return getTerminalService().ensurePanel(
        terminalOwner(),
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        args[2] as never,
        args[3] as never,
      );
    case desktopIpc.terminalFindBackgroundPiTui:
      return getTerminalService().findBackgroundPiTuiSession(
        terminalOwner(),
        String(args[0] ?? ""),
        String(args[1] ?? ""),
      );
    case desktopIpc.terminalCreateSession:
      return getTerminalService().createSession(
        terminalOwner(),
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        args[2] as never,
        args[3] as never,
      );
    case desktopIpc.terminalSetActiveSession:
      return getTerminalService().setActiveSession(
        terminalOwner(),
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? ""),
      );
    case desktopIpc.terminalWrite:
      terminalService?.write(terminalOwner(), String(args[0] ?? ""), String(args[1] ?? ""));
      return undefined;
    case desktopIpc.terminalResize:
      terminalService?.resize(terminalOwner(), String(args[0] ?? ""), args[1] as never, Boolean(args[2]));
      return undefined;
    case desktopIpc.terminalRestartSession:
      return getTerminalService().restart(terminalOwner(), String(args[0] ?? ""), args[1] as never, args[2] as never);
    case desktopIpc.terminalCloseSession:
      return getTerminalService().close(terminalOwner(), String(args[0] ?? ""));
    case desktopIpc.terminalSetTitle:
      terminalService?.setTitle(terminalOwner(), String(args[0] ?? ""), String(args[1] ?? ""));
      return undefined;
    case desktopIpc.terminalSetFocused:
      return undefined;
    case desktopIpc.toggleWindowMaximize:
      return undefined;
    // ── CLI 检测 ──
    case desktopIpc.cliDetectAll:
      return getCliDetector().detectAll();
    case desktopIpc.cliDetectOne:
      return getCliDetector().detectOne(String(args[0] ?? ""));
    case desktopIpc.cliGetAdapterInfo:
      return getCliDetector().getAdapterInfo();
    default:
      throw new Error(`Unsupported remote pi-gui channel: ${channel}`);
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
          label: "Check for Updates…",
          click: () => {
            void runManualUpdateCheck();
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          id: NEW_WINDOW_MENU_ITEM_ID,
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click: () => {
            createAppWindow(getForegroundAppView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: "Open Folder…",
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("Bimanus");

const configuredUserDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
app.setPath("userData", configuredUserDataDir);
const tuiDiagnosticsLogPath = resolveTuiDiagnosticsLogPath(configuredUserDataDir);
configureTuiDiagnosticsLog(tuiDiagnosticsLogPath);
writeTuiDiagnosticLog("main.app.startup", {
  logPath: tuiDiagnosticsLogPath,
  appName: app.getName(),
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  cwd: process.cwd(),
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  configuredUserDataDir,
  userDataDir: app.getPath("userData"),
  env: pickStartupDiagnosticEnv(),
  versions: process.versions,
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", async () => {
  if (!store) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const window = createAppWindow(getForegroundAppView());
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  // On macOS, packaged builds already render the dock icon from `icon.icns`
  // in the app bundle. In dev we override the generic Electron dock icon with
  // the real PNG so the running app looks right end-to-end.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(appIcon);
  }

  let generateThreadTitleOverride:
    | ((workspace: WorkspaceRef, options: GenerateThreadTitleOptions) => Promise<string | null | undefined>)
    | undefined;
  let deferredThreadTitle:
    | {
        resolve: (title: string | null) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const driverOptions = {
    extensionFactories: [createMcpBridgeExtension(desktopMcpBridgeRuntime)],
    inlineExtensionMetadata: [
      {
        displayName: "MCP Bridge",
        description: "Expose configured MCP servers as pi tools",
      },
    ],
  };
  store = new DesktopAppStore({
    userDataDir: configuredUserDataDir,
    initialWorkspacePaths: resolveInitialWorkspacePaths(),
    getWindow: () => mainWindow,
    shouldKeepSessionDialogs: (sessionRef) => isSessionVisibleInAnotherWindow(sessionRef),
    driverOptions,
    generateThreadTitleOverride: async (workspace, options) => generateThreadTitleOverride?.(workspace, options),
  });
  await store.initialize();
  integratedTerminalShell = (await store.getState()).integratedTerminalShell;
  stopPruningTerminals = store.subscribe((state) => {
    integratedTerminalShell = state.integratedTerminalShell;
    const workspacePaths = state.workspaces.map((workspace) => workspace.path);
    const workspacePathSignature = workspacePaths.join("\0");
    if (workspacePathSignature !== retainedTerminalWorkspacePathSignature) {
      retainedTerminalWorkspacePathSignature = workspacePathSignature;
      terminalService?.retainWorkspacePaths(workspacePaths);
    }
  });
  installApplicationMenu();
  if (process.env.PI_APP_TEST_MODE) {
    Object.assign(globalThis, {
      __PI_APP_TEST_HOOKS: {
        emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
        setDeferredThreadTitleMode: () => {
          generateThreadTitleOverride = () =>
            new Promise<string | null>((resolve, reject) => {
              deferredThreadTitle = { resolve, reject };
            });
        },
        hasDeferredThreadTitle: () => Boolean(deferredThreadTitle),
        resolveDeferredThreadTitle: (title: string) => {
          if (!deferredThreadTitle) {
            throw new Error("Deferred thread-title request is unavailable");
          }
          const pending = deferredThreadTitle;
          deferredThreadTitle = undefined;
          pending.resolve(title);
        },
        rejectDeferredThreadTitle: () => {
          if (!deferredThreadTitle) {
            throw new Error("Deferred thread-title request is unavailable");
          }
          const pending = deferredThreadTitle;
          deferredThreadTitle = undefined;
          pending.reject(new Error("Deferred thread-title rejected by test"));
        },
      },
    });
  }
  notificationPermissionService = new NotificationPermissionService(() => mainWindow);
  notificationPermissionService.subscribe((status) => {
    for (const window of appWindows) {
      if (canPublishToWindow(window)) {
        window.webContents.send(desktopIpc.notificationPermissionStatusChanged, status);
      }
    }
    remoteUiServer?.publish("notification-permission-status-changed", status);
  });
  notificationManager = new NotificationManager(
    store,
    () => mainWindow,
    notificationPermissionService,
    async (sessionRef) => {
      const window = getForegroundAppWindow();
      await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), { forceActiveWindow: true });
    },
  );
  stopNotifications = notificationManager.start();
  if (!isDev) {
    stopUpdateChecker = initUpdateChecker();
  }
  void startRemoteUiServer();
  installCopySelectionContextMenu();

  ipcMain.handle(desktopIpc.ping, () =>
    devReloadMarkersEnabled ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}` : "pi desktop ready",
  );

  // ── CLI 检测 IPC handlers ──
  ipcMain.handle(desktopIpc.cliDetectAll, async () => {
    const detector = getCliDetector();
    return detector.detectAll();
  });

  ipcMain.handle(desktopIpc.cliDetectOne, async (_event, cliType: string) => {
    const detector = getCliDetector();
    return detector.detectOne(cliType);
  });

  ipcMain.handle(desktopIpc.cliGetAdapterInfo, async () => {
    const detector = getCliDetector();
    return detector.getAdapterInfo();
  });

  ipcMain.handle(desktopIpc.getThemeMode, () => themeManager.getMode());
  ipcMain.handle(desktopIpc.getResolvedTheme, () => themeManager.getResolvedTheme());
  ipcMain.handle(desktopIpc.setThemeMode, (_event, mode: ThemeMode) => {
    themeManager.setMode(mode);
    return mode;
  });
  ipcMain.handle(desktopIpc.openExternal, (_event, url: string) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Refusing to open unsupported URL: ${url}`);
    }
    return shell.openExternal(url);
  });
  ipcMain.handle(desktopIpc.stateRequest, (event) => store.getStateForView(viewForWebContents(event.sender.id)));
  ipcMain.handle(desktopIpc.addWorkspacePath, (event, workspacePath: string) =>
    runWindowScopedForEvent(event, () => store.addWorkspace(workspacePath)),
  );
  ipcMain.handle(desktopIpc.pickWorkspace, (event) =>
    pickWorkspaceViaDialog(BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle(desktopIpc.selectWorkspace, (event, workspaceId: string) =>
    runWindowScopedForEvent(event, () => store.selectWorkspace(workspaceId)),
  );
  ipcMain.handle(desktopIpc.renameWorkspace, (event, workspaceId: string, displayName: string) =>
    runWindowScopedForEvent(event, () => store.renameWorkspace(workspaceId, displayName)),
  );
  ipcMain.handle(desktopIpc.removeWorkspace, (event, workspaceId: string) =>
    runWindowScopedForEvent(event, () => store.removeWorkspace(workspaceId)),
  );
  ipcMain.handle(desktopIpc.reorderWorkspaces, (event, order: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.reorderWorkspaces(order)),
  );
  ipcMain.handle(desktopIpc.openWorkspaceInFinder, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await shell.openPath(workspacePath);
  });
  ipcMain.handle(desktopIpc.createWorktree, (event, input: CreateWorktreeInput) =>
    runWindowScopedForEvent(event, () => store.createWorktree(input)),
  );
  ipcMain.handle(desktopIpc.removeWorktree, (event, input: RemoveWorktreeInput) =>
    runWindowScopedForEvent(event, () => store.removeWorktree(input)),
  );
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, (event) =>
    runWindowScopedForEvent(event, () => store.syncCurrentWorkspace()),
  );
  ipcMain.handle(desktopIpc.selectSession, async (event, target: WorkspaceSessionTarget) => {
    logTuiPerf("main.ipc.selectSession.received", {
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
    }, {
      webContentsId: event.sender.id,
    });
    const state = await runWindowScopedForEvent(event, () => store.selectSession(target));
    logTuiPerf("main.ipc.selectSession.returned", {
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
    }, {
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedSessionId: state.selectedSessionId,
      revision: state.revision,
    });
    return state;
  });
  ipcMain.handle(desktopIpc.archiveSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.archiveSession(target)),
  );
  ipcMain.handle(desktopIpc.unarchiveSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.unarchiveSession(target)),
  );
  ipcMain.handle(desktopIpc.reloadSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.reloadSession(target)),
  );
  ipcMain.handle(desktopIpc.setActiveView, (event, activeView) =>
    runWindowScopedForEvent(event, () => store.setActiveView(activeView)),
  );
  ipcMain.handle(desktopIpc.setSidebarCollapsed, (event, collapsed: boolean) =>
    runWindowScopedForEvent(event, () => store.setSidebarCollapsed(collapsed)),
  );
  ipcMain.handle(desktopIpc.setSidebarWidth, (event, sidebarWidth: number) =>
    runWindowScopedForEvent(event, () => store.setSidebarWidth(sidebarWidth)),
  );
  ipcMain.handle(desktopIpc.refreshRuntime, (event, workspaceId?: string) =>
    runWindowScopedForEvent(event, () => store.refreshRuntime(toOptionalWorkspaceId(workspaceId))),
  );
  ipcMain.handle(desktopIpc.setSessionModel, (event, workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    runWindowScopedForEvent(event, () => store.setSessionModel({ workspaceId, sessionId }, provider, modelId)),
  );
  ipcMain.handle(desktopIpc.setDefaultModel, (event, workspaceId: string | undefined, provider: string, modelId: string) =>
    runWindowScopedForEvent(event, () => store.setDefaultModel(toOptionalWorkspaceId(workspaceId), provider, modelId)),
  );
  ipcMain.handle(
    desktopIpc.setDefaultThinkingLevel,
    (event, workspaceId: string | undefined, thinkingLevel) =>
      runWindowScopedForEvent(event, () => store.setDefaultThinkingLevel(toOptionalWorkspaceId(workspaceId), thinkingLevel)),
  );
  ipcMain.handle(
    desktopIpc.setSessionThinkingLevel,
    (event, workspaceId: string, sessionId: string, thinkingLevel) =>
      runWindowScopedForEvent(event, () => store.setSessionThinkingLevel({ workspaceId, sessionId }, thinkingLevel)),
  );
  ipcMain.handle(desktopIpc.loginProvider, (event, workspaceId: string | undefined, providerId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return runUnscopedStateResultForWindow(window, () =>
      store.loginProvider(toOptionalWorkspaceId(workspaceId), providerId, createRuntimeLoginCallbacks(window)),
    );
  });
  ipcMain.handle(desktopIpc.logoutProvider, (event, workspaceId: string | undefined, providerId: string) =>
    runWindowScopedForEvent(event, () => store.logoutProvider(toOptionalWorkspaceId(workspaceId), providerId)),
  );
  ipcMain.handle(desktopIpc.setProviderApiKey, (event, workspaceId: string | undefined, providerId: string, apiKey: string) =>
    runWindowScopedForEvent(event, () => store.setProviderApiKey(toOptionalWorkspaceId(workspaceId), providerId, apiKey)),
  );
  ipcMain.handle(desktopIpc.addMcpServer, (event, input: McpServerConfigInput) =>
    runWindowScopedForEvent(event, () => store.addMcpServer(input)),
  );
  ipcMain.handle(desktopIpc.updateMcpServer, (event, serverId: string, input: McpServerConfigInput) =>
    runWindowScopedForEvent(event, () => store.updateMcpServer(serverId, input)),
  );
  ipcMain.handle(desktopIpc.removeMcpServer, (event, serverId: string) =>
    runWindowScopedForEvent(event, () => store.removeMcpServer(serverId)),
  );
  ipcMain.handle(desktopIpc.authorizeMcpServer, (event, serverId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return runUnscopedStateResultForWindow(window, () =>
      store.authorizeMcpServer(serverId, mcpOAuthManager),
    );
  });
  ipcMain.handle(desktopIpc.setMcpServerEnabled, (event, serverId: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setMcpServerEnabled(serverId, enabled)),
  );
  ipcMain.handle(desktopIpc.setCliEnabled, (event, cliType: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setCliEnabled(cliType, enabled)),
  );

  /* ── System Prompts ──────────────────────────────────── */
  ipcMain.handle(desktopIpc.saveSystemPrompt, (event, name: string, content: string, promptId?: string) =>
    runWindowScopedForEvent(event, () => store.saveSystemPrompt(name, content, promptId)),
  );
  ipcMain.handle(desktopIpc.deleteSystemPrompt, (event, promptId: string) =>
    runWindowScopedForEvent(event, () => store.deleteSystemPrompt(promptId)),
  );
  ipcMain.handle(desktopIpc.setActiveSystemPrompt, (event, promptId: string | undefined) =>
    runWindowScopedForEvent(event, () => store.setActiveSystemPrompt(promptId)),
  );

  ipcMain.handle(desktopIpc.setEnableSkillCommands, (event, workspaceId: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setEnableSkillCommands(workspaceId, enabled)),
  );
  ipcMain.handle(desktopIpc.setScopedModelPatterns, (event, workspaceId: string | undefined, patterns: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.setScopedModelPatterns(toOptionalWorkspaceId(workspaceId), patterns)),
  );
  ipcMain.handle(desktopIpc.setSkillEnabled, (event, workspaceId: string, filePath: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setSkillEnabled(workspaceId, filePath, enabled)),
  );
  ipcMain.handle(desktopIpc.removeSkill, (event, workspaceId: string, filePath: string) =>
    runWindowScopedForEvent(event, () => store.removeSkill(workspaceId, filePath)),
  );
  ipcMain.handle(desktopIpc.setExtensionEnabled, (event, workspaceId: string, filePath: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setExtensionEnabled(workspaceId, filePath, enabled)),
  );
  ipcMain.handle(desktopIpc.removeExtension, (event, workspaceId: string, filePath: string) =>
    runWindowScopedForEvent(event, () => store.removeExtension(workspaceId, filePath)),
  );
  ipcMain.handle(desktopIpc.installPackage, (event, workspaceId: string, source: string) =>
    runWindowScopedForEvent(event, () => store.installPackage(workspaceId, source)),
  );
  ipcMain.handle(desktopIpc.updatePackage, (event, workspaceId: string, source: string, installScope?: "user" | "project") =>
    runWindowScopedForEvent(event, () => store.updatePackage(workspaceId, source, installScope)),
  );
  ipcMain.handle(desktopIpc.removePackage, (event, workspaceId: string, source: string, installScope?: "user" | "project") =>
    runWindowScopedForEvent(event, () => store.removePackage(workspaceId, source, installScope)),
  );
  ipcMain.handle(desktopIpc.setPackageEnabled, (event, workspaceId: string, source: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setPackageEnabled(workspaceId, source, enabled)),
  );
  ipcMain.handle(desktopIpc.searchPackages, (_event, query: string) => store.searchPackages(query));
  ipcMain.handle(desktopIpc.respondToHostUiRequest, (event, workspaceId: string, sessionId: string, response) =>
    runWindowScopedForEvent(event, () => store.respondToHostUiRequest({ workspaceId, sessionId }, response)),
  );
  ipcMain.handle(desktopIpc.setNotificationPreferences, (event, preferences) =>
    runWindowScopedForEvent(event, () => store.setNotificationPreferences(preferences)),
  );
  ipcMain.handle(desktopIpc.setIntegratedTerminalShell, (event, shellPath: string) =>
    runWindowScopedForEvent(event, () => store.setIntegratedTerminalShell(shellPath)),
  );
  ipcMain.handle(desktopIpc.setTuiTabLimit, (event, limit: number) =>
    runWindowScopedForEvent(event, () => store.setTuiTabLimit(limit)),
  );
  ipcMain.handle(desktopIpc.setRemoteUiPort, async (event, port: number) => {
    const nextState = await runWindowScopedForEvent(event, () => store.setRemoteUiPort(port));
    await restartRemoteUiServer();
    return nextState;
  });
  ipcMain.handle(desktopIpc.setRemoteUiToken, async (event, token: string) => {
    const nextState = await runWindowScopedForEvent(event, () => store.setRemoteUiToken(token));
    await startRemoteUiServer();
    return nextState;
  });
  ipcMain.handle(desktopIpc.setEnableTransparency, async (_event, enabled: boolean) => {
    const nextState = await store.setEnableTransparency(enabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (process.platform === "darwin") {
        mainWindow.setVibrancy(enabled ? "under-window" : null);
      }
    }
    return nextState;
  });
  ipcMain.handle(desktopIpc.setTuiBgColor, (event, color: string) =>
    runWindowScopedForEvent(event, () => store.setTuiBgColor(color)),
  );
  ipcMain.handle(desktopIpc.setSplitPanelBgColor, (event, color: string) =>
    runWindowScopedForEvent(event, () => store.setSplitPanelBgColor(color)),
  );
  ipcMain.handle(desktopIpc.setLocale, (event, locale: "auto" | "en" | "zh") =>
    runWindowScopedForEvent(event, () => store.setLocale(locale)),
  );
  ipcMain.handle(desktopIpc.terminalFindBackgroundPiTui, (event, workspaceId: string, sessionId: string) => {
    const backgroundSession = getTerminalService().findBackgroundPiTuiSession(
      terminalOwnerFromWebContents(event.sender),
      workspaceId,
      sessionId,
    );
    logTuiPerf("main.ipc.terminalFindBackgroundPiTui", {
      workspaceId,
      sessionId,
    }, {
      found: Boolean(backgroundSession),
      terminalId: backgroundSession?.terminalId,
      seq: backgroundSession?.seq,
      status: backgroundSession?.status,
    });
    return backgroundSession;
  });
  ipcMain.handle(desktopIpc.terminalEnsurePanel, async (event, workspaceId: string, terminalScopeId: string, size, launchConfig) => {
    logTuiPerf("main.ipc.terminalEnsurePanel.received", {
      workspaceId,
      sessionId: launchConfig?.mode === "pi-tui" ? launchConfig.sessionId : undefined,
      traceId: launchConfig?.mode === "pi-tui" ? launchConfig.debugTraceId : undefined,
    }, {
      terminalScopeId,
      size,
      launchConfig,
      webContentsId: event.sender.id,
    });
    const panel = await getTerminalService().ensurePanel(terminalOwnerFromWebContents(event.sender), workspaceId, terminalScopeId, size, launchConfig);
    logTuiPerf("main.ipc.terminalEnsurePanel.returned", {
      workspaceId,
      sessionId: launchConfig?.mode === "pi-tui" ? launchConfig.sessionId : undefined,
      traceId: launchConfig?.mode === "pi-tui" ? launchConfig.debugTraceId : undefined,
      terminalId: panel.activeSessionId,
    }, {
      terminalScopeId,
      sessionCount: panel.sessions.length,
      statuses: panel.sessions.map((session) => `${session.id}:${session.status}`),
    });
    return panel;
  });
  ipcMain.handle(desktopIpc.terminalCreateSession, (event, workspaceId: string, terminalScopeId: string, size, launchConfig) => {
    return getTerminalService().createSession(terminalOwnerFromWebContents(event.sender), workspaceId, terminalScopeId, size, launchConfig);
  });
  ipcMain.handle(desktopIpc.terminalSetActiveSession, (event, workspaceId: string, terminalScopeId: string, terminalId: string) => {
    return getTerminalService().setActiveSession(terminalOwnerFromWebContents(event.sender), workspaceId, terminalScopeId, terminalId);
  });
  ipcMain.handle(desktopIpc.terminalWrite, (event, terminalId: string, data: string) => {
    terminalService?.write(terminalOwnerFromWebContents(event.sender), terminalId, data);
  });
  ipcMain.handle(desktopIpc.terminalResize, (event, terminalId: string, size, force?: boolean) => {
    terminalService?.resize(terminalOwnerFromWebContents(event.sender), terminalId, size, force);
  });
  ipcMain.handle(desktopIpc.terminalRestartSession, async (event, terminalId: string, size, launchConfig) => {
    logTuiPerf("main.ipc.terminalRestart.received", {
      sessionId: launchConfig?.mode === "pi-tui" ? launchConfig.sessionId : undefined,
      traceId: launchConfig?.mode === "pi-tui" ? launchConfig.debugTraceId : undefined,
      terminalId,
    }, {
      size,
      launchConfig,
      webContentsId: event.sender.id,
    });
    const panel = await getTerminalService().restart(terminalOwnerFromWebContents(event.sender), terminalId, size, launchConfig);
    logTuiPerf("main.ipc.terminalRestart.returned", {
      sessionId: launchConfig?.mode === "pi-tui" ? launchConfig.sessionId : undefined,
      traceId: launchConfig?.mode === "pi-tui" ? launchConfig.debugTraceId : undefined,
      terminalId: panel.activeSessionId,
    }, {
      sessionCount: panel.sessions.length,
      statuses: panel.sessions.map((session) => `${session.id}:${session.status}`),
    });
    return panel;
  });
  ipcMain.handle(desktopIpc.terminalCloseSession, (event, terminalId: string) => {
    return getTerminalService().close(terminalOwnerFromWebContents(event.sender), terminalId);
  });
  ipcMain.handle(desktopIpc.terminalSetTitle, (event, terminalId: string, title: string) => {
    terminalService?.setTitle(terminalOwnerFromWebContents(event.sender), terminalId, title);
  });
  ipcMain.on(desktopIpc.terminalSetFocused, (event, focused: boolean) => {
    if (focused) {
      terminalFocusedWebContentsIds.add(event.sender.id);
    } else {
      terminalFocusedWebContentsIds.delete(event.sender.id);
    }
  });
  ipcMain.handle(desktopIpc.getNotificationPermissionStatus, () =>
    notificationPermissionService?.getCurrentStatus() ?? Promise.resolve("unknown"),
  );
  ipcMain.handle(desktopIpc.requestNotificationPermission, () =>
    notificationPermissionService?.requestPermission() ?? Promise.resolve("unknown"),
  );
  ipcMain.handle(desktopIpc.openSystemNotificationSettings, () =>
    notificationPermissionService?.openSystemSettings() ?? Promise.resolve(),
  );
  ipcMain.handle(desktopIpc.createSession, (event, input: CreateSessionInput) =>
    runWindowScopedForEvent(event, () => store.createSession(input)),
  );
  ipcMain.handle(desktopIpc.startThread, (event, input: StartThreadInput) =>
    runWindowScopedForEvent(event, () => store.startThread(input)),
  );
  ipcMain.handle(desktopIpc.openSkillInFinder, async (_event, workspaceId: string, filePath: string) => {
    const resolved = store.getSkillFilePath(workspaceId, filePath);
    if (!resolved) {
      throw new Error(`Unknown skill: ${filePath}`);
    }
    await shell.openPath(path.dirname(resolved));
  });
  ipcMain.handle(desktopIpc.openExtensionInFinder, async (_event, workspaceId: string, filePath: string) => {
    const resolved = store.getExtensionFilePath(workspaceId, filePath);
    if (!resolved) {
      throw new Error(`Unknown extension: ${filePath}`);
    }
    await shell.openPath(path.dirname(resolved));
  });
  ipcMain.handle(desktopIpc.cancelCurrentRun, (event) =>
    runPreemptiveWindowScopedForEvent(event, () => store.cancelCurrentRun()),
  );
  ipcMain.handle(desktopIpc.readClipboardText, () => clipboard.readText());
  ipcMain.handle(desktopIpc.getSessionTree, (_event, target: WorkspaceSessionTarget) =>
    store.getSessionTree(target),
  );
  ipcMain.handle(
    desktopIpc.navigateSessionTree,
    (event, target: WorkspaceSessionTarget, targetId: string, options) =>
      runWindowScopedStateResult(BrowserWindow.fromWebContents(event.sender), () =>
        store.navigateSessionTree(target, targetId, options),
      ),
  );
  ipcMain.handle(desktopIpc.listWorkspaceFiles, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return [];
    }
    return listWorkspaceFiles(workspacePath);
  });
  ipcMain.handle(desktopIpc.getChangedFiles, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return [];
    }
    return getChangedFiles(workspacePath);
  });
  ipcMain.handle(desktopIpc.getFileDiff, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return "";
    }
    return getFileDiff(workspacePath, filePath);
  });
  ipcMain.handle(desktopIpc.stageFile, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await stageFile(workspacePath, filePath);
  });
  ipcMain.handle(desktopIpc.toggleWindowMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
      return;
    }

    window.maximize();
  });

  createAppWindow();
  void notificationPermissionService.getCurrentStatus();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow();
      void notificationPermissionService?.getCurrentStatus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopNotifications?.();
    stopNotifications = undefined;
    notificationManager = undefined;
    notificationPermissionService?.dispose();
    notificationPermissionService = undefined;
    stopUpdateChecker?.();
    stopUpdateChecker = undefined;
    stopPruningTerminals?.();
    stopPruningTerminals = undefined;
    void stopRemoteUiServer();
    terminalService?.dispose();
    terminalService = undefined;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  remoteSystemService.dispose();
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  notificationPermissionService?.dispose();
  notificationPermissionService = undefined;
  stopUpdateChecker?.();
  stopUpdateChecker = undefined;
  stopPruningTerminals?.();
  stopPruningTerminals = undefined;
  void stopRemoteUiServer();
  terminalService?.dispose();
  terminalService = undefined;
  store?.dispose();
  if (quittingAfterStoreFlush || !store) {
    return;
  }

  event.preventDefault();
  quittingAfterStoreFlush = true;
  void store
    .flushPersistence()
    .catch(() => undefined)
    .finally(() => {
      app.quit();
    });
});

function resolveInitialWorkspacePaths(): readonly string[] {
  const raw = process.env.PI_APP_INITIAL_WORKSPACES;
  if (raw !== undefined) {
    return raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}


function createRuntimeLoginCallbacks(window?: BrowserWindow | null) {
  return {
    onAuth: async ({ url, instructions }: { readonly url: string; readonly instructions?: string }) => {
      await shell.openExternal(url);
      if (instructions) {
        await showLoginMessage(window, instructions);
      }
    },
    onDeviceCode: async ({
      userCode,
      verificationUri,
    }: {
      readonly userCode: string;
      readonly verificationUri: string;
    }) => {
      await shell.openExternal(verificationUri);
      await showLoginMessage(window, `Open this URL in your browser:\n${verificationUri}\n\nEnter code: ${userCode}`);
    },
    onPrompt: async ({
      message,
      placeholder,
      allowEmpty,
    }: {
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty?: boolean;
    }) => promptForText(window, message, placeholder, { allowEmpty }),
    onSelect: async ({
      message,
      options,
    }: {
      readonly message: string;
      readonly options: readonly { readonly id: string; readonly label: string }[];
    }) => {
      const choices = options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
      const value = await promptForText(window, `${message}\n\n${choices}`, "", { allowEmpty: true });
      const normalized = value.trim();
      if (!normalized) {
        return undefined;
      }
      const selectedIndex = Number.parseInt(normalized, 10) - 1;
      if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < options.length) {
        return options[selectedIndex]?.id;
      }
      return options.find((option) => option.id === normalized)?.id;
    },
  };
}

async function showLoginMessage(parentWindow: BrowserWindow | null | undefined, message: string): Promise<void> {
  const window = resolveDialogWindow(parentWindow);
  if (!window) {
    throw new Error("Main window is not available for login.");
  }
  window.show();
  window.focus();
  await dialog.showMessageBox(window, {
    buttons: ["OK"],
    message,
    noLink: true,
    title: "Provider login",
    type: "info",
  });
}

async function promptForText(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
  placeholder = "",
  options: { readonly allowEmpty?: boolean } = {},
): Promise<string> {
  const window = resolveDialogWindow(parentWindow);
  if (!window) {
    throw new Error("Main window is not available for login.");
  }
  window.show();
  window.focus();
  const result = await showTextPromptWindow(window, message, placeholder);
  if (typeof result !== "string" || (!options.allowEmpty && result.trim().length === 0)) {
    throw new Error("Login cancelled.");
  }
  return result.trim();
}

async function showTextPromptWindow(
  parentWindow: BrowserWindow,
  message: string,
  placeholder: string,
): Promise<string | undefined> {
  const promptWindow = new BrowserWindow({
    width: 440,
    height: 250,
    parent: parentWindow,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Provider login",
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const closed = new Promise<undefined>((resolve) => {
    promptWindow.once("closed", () => resolve(undefined));
  });

  await promptWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildTextPromptHtml(message, placeholder))}`,
  );
  promptWindow.show();
  promptWindow.focus();

  const submitted = promptWindow.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const form = document.querySelector("form");
      const input = document.querySelector("input");
      const cancel = document.querySelector("[data-cancel]");
      input?.focus();
      input?.select();
      form?.addEventListener("submit", (event) => {
        event.preventDefault();
        resolve(input?.value ?? "");
      });
      cancel?.addEventListener("click", () => resolve(undefined));
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          resolve(undefined);
        }
      });
    })`,
    true,
  ) as Promise<string | undefined>;

  const result = await Promise.race([submitted, closed]);
  if (!promptWindow.isDestroyed()) {
    promptWindow.close();
  }
  return result;
}

function buildTextPromptHtml(message: string, placeholder: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        background: Canvas;
        color: CanvasText;
      }
      form {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 100vh;
        padding: 22px;
      }
      label {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 12px;
        font-size: 13px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      input {
        border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
        border-radius: 6px;
        box-sizing: border-box;
        color: CanvasText;
        background: Canvas;
        font: inherit;
        min-height: 34px;
        outline: none;
        padding: 6px 9px;
        width: 100%;
      }
      input:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px color-mix(in srgb, #2563eb 18%, transparent);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      button {
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 6px;
        background: Canvas;
        color: CanvasText;
        font: inherit;
        min-width: 78px;
        padding: 6px 12px;
      }
      button[type="submit"] {
        background: #2563eb;
        border-color: #2563eb;
        color: white;
      }
    </style>
  </head>
  <body>
    <form>
      <label>
        <span>${escapeHtml(message)}</span>
        <input autocomplete="off" placeholder="${escapeHtml(placeholder)}" />
      </label>
      <div class="actions">
        <button data-cancel type="button">Cancel</button>
        <button type="submit">Continue</button>
      </div>
    </form>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
