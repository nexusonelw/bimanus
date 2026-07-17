import type { WebContents } from "electron";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import type {
  BackgroundPiTuiSessionSnapshot,
  TerminalPanelSnapshot,
  TerminalLaunchConfig,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalSize,
  SplitPanelCliType,
} from "../src/ipc";
import { normalizeTuiTabLimit } from "../src/desktop-state";
import { desktopIpc } from "../src/ipc";
import { logTuiPerf } from "../src/tui-perf-log";
import type { ExternalCliLaunchCommand } from "./cli-detector";
import {
  describeDirectory,
  describeFilesystemPath,
  getTuiDiagnosticsLogPath,
  sanitizeEnv,
  sanitizeError,
  truncateForLog,
  writeTuiDiagnosticLog,
} from "./tui-diagnostics-log";

type NodePty = typeof import("node-pty");
type IPty = import("node-pty").IPty;
type IDisposable = import("node-pty").IDisposable;

const require = createRequire(__filename);
let nodePty: NodePty | undefined;
let cachedPiCliCommand: { readonly cacheKey: string; readonly command: TerminalLaunchCommand } | undefined;
let cachedMcpBridgeExtensionPath: string | undefined;
let nodePtySpawnHelperExecutableCheckKey = "";

const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };
const MAX_WRITE_LENGTH = 128 * 1024;
const MAX_TERMINAL_SESSIONS_PER_ROOT = 20;
// Cap concurrently running pi-tui processes so multi-tab TUI mode cannot grow
// unbounded. Both the per-root tab queue and the cross-root background cap
// behave as fixed-size FIFO queues: the oldest (first-created) session is
// evicted when the cap is hit, regardless of whether the request originated
// locally or from a remote-authorized caller.
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const MCP_BRIDGE_SERVERS_ENV = "PI_GUI_MCP_BRIDGE_SERVERS_JSON";
const PI_GUI_PI_CLI_PATH_ENV = "PI_GUI_PI_CLI_PATH";
const PI_GUI_NODE_PATH_ENV = "PI_GUI_NODE_PATH";
const PI_GUI_NPM_CLI_PATH_ENV = "PI_GUI_NPM_CLI_PATH";
const PI_GUI_RIPGREP_PATH_ENV = "PI_GUI_RIPGREP_PATH";
const PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK_ENV = "PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK";

export type TerminalRemoteEventName = "terminal-data" | "terminal-exit" | "terminal-error";

export interface TerminalOwner {
  readonly id: string;
  readonly webContents?: WebContents;
  readonly remoteClientId?: string;
}

export interface TerminalLaunchCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly usesElectronRunAsNode?: boolean;
  /** Port assigned to CLIs that start a local HTTP server (e.g., OpenCode). */
  readonly cliPort?: number;
}

export interface TerminalPiTuiExitEvent {
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly terminalId: string;
  readonly exitCode?: number;
  readonly signal?: number;
}

export function terminalOwnerFromWebContents(webContents: WebContents): TerminalOwner {
  return { id: `web:${webContents.id}`, webContents };
}

export function terminalOwnerFromRemoteClient(clientId: string): TerminalOwner {
  return { id: `remote:${clientId}`, remoteClientId: clientId };
}

interface TerminalRoot {
  readonly rootKey: string;
  readonly ownerId: string;
  readonly workspaceRootKey: string;
  readonly workspaceId: string;
  readonly terminalScopeId: string;
  readonly cwd: string;
  activeSessionId: string | undefined;
  readonly sessionIds: string[];
}

interface TerminalSession {
  readonly id: string;
  workspaceId: string;
  terminalScopeId: string;
  rootKey: string;
  readonly cwd: string;
  readonly owner: TerminalOwner;
  readonly ownerId: string;
  launchConfig: TerminalLaunchConfig;
  shell: string;
  args: readonly string[];
  usesElectronRunAsNode: boolean;
  title: string;
  status: TerminalSessionStatus;
  replay: string;
  seq: number;
  truncated: boolean;
  exitCode: number | undefined;
  signal: number | undefined;
  size: TerminalSize;
  pty: IPty | undefined;
  dataSubscription: IDisposable | undefined;
  exitSubscription: IDisposable | undefined;
  dataChunkCount: number;
  /** @internal replay buffer as chunks (deferred join) */
  replayChunks: string[];
  /** @internal cached joined replay buffer, undefined when dirty */
  replayBuffer: string | undefined;
  /** @internal queued data chunks for throttled IPC send */
  pendingDataChunks: string[];
  /** @internal true when a setImmediate flush is already scheduled */
  dataFlushScheduled: boolean;
  lastActiveAt: number;
  /** Port assigned to CLIs that start a local HTTP server (e.g., OpenCode). */
  cliPort: number | undefined;
}

interface TerminalMcpBridgeServerConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TerminalServiceOptions {
  readonly getWorkspacePath: (workspaceId: string) => string | undefined;
  readonly getIntegratedTerminalShell: () => string | undefined;
  readonly getAgentDir: () => string | undefined;
  readonly getMcpBridgeServers: () => Promise<readonly TerminalMcpBridgeServerConfig[]>;
  readonly getTuiTabLimit: () => number;
  readonly getPiTuiSessionFilePath?: (workspaceId: string, sessionId: string) => Promise<string | undefined>;
  readonly getActiveSystemPrompt?: () => string | undefined;
  readonly preparePiTuiLaunch?: (workspaceId: string) => Promise<void>;
  readonly resolveExternalCliLaunchCommand: (
    cliType: SplitPanelCliType,
    prompt: string,
    cliPort?: number,
  ) => ExternalCliLaunchCommand;
  readonly isPackaged: boolean;
  readonly publishRemoteTerminalEvent?: (
    clientId: string,
    eventName: TerminalRemoteEventName,
    payload: unknown,
  ) => void;
  readonly onPiTuiSessionExit?: (event: TerminalPiTuiExitEvent) => void | Promise<void>;
}

export class TerminalService {
  private readonly rootsByKey = new Map<string, TerminalRoot>();
  private readonly sessionsById = new Map<string, TerminalSession>();
  private readonly pendingSessionsByLaunchKey = new Map<string, Promise<TerminalSession>>();
  private nextSessionNumber = 1;

  constructor(private readonly options: TerminalServiceOptions) {}

  findBackgroundPiTuiSession(
    owner: TerminalOwner,
    workspaceId: string,
    piSessionId: string,
  ): BackgroundPiTuiSessionSnapshot | null {
    const normalizedSessionId = piSessionId.trim();
    if (!normalizedSessionId) {
      return null;
    }

    const terminalScopeId = `pi-tui-tabs:${workspaceId}`;
    const launchConfig: TerminalLaunchConfig = { mode: "pi-tui", sessionId: normalizedSessionId };
    const root = this.ensureRoot(owner, workspaceId, terminalScopeId, launchConfig);
    const session = this.findReusableSession(root, launchConfig);
    if (!session) {
      return null;
    }

    return {
      terminalId: session.id,
      workspaceId: session.workspaceId,
      sessionId: normalizedSessionId,
      seq: session.seq,
      status: session.status,
    };
  }

  async ensurePanel(
    owner: TerminalOwner,
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig | null,
  ): Promise<TerminalPanelSnapshot> {
    // Remote JSON transport coerces missing args to null; normalize before any .mode access.
    const resolvedLaunchConfig = normalizeTerminalLaunchConfig(launchConfig);
    const root = this.ensureRoot(owner, workspaceId, terminalScopeId, resolvedLaunchConfig);
    const reusableSession = this.findReusableSession(root, resolvedLaunchConfig);
    if (reusableSession) {
      this.activateSession(root, reusableSession, size);
      return this.snapshotRoot(root);
    }

    if (resolvedLaunchConfig.mode === "pi-tui" || !root.activeSessionId || root.sessionIds.length === 0) {
      const session = await this.ensureSessionForLaunchConfig(owner, root, size, resolvedLaunchConfig);
      this.activateSession(root, session, size);
    } else {
      // For non-pi-tui modes, rebuild the session if the current active one
      // has exited or errored — otherwise the panel shows a dead terminal with
      // no way to recover without manually closing the tab.
      const activeSession = root.activeSessionId
        ? this.sessionsById.get(root.activeSessionId)
        : undefined;
      if (activeSession && (activeSession.status === "exited" || activeSession.status === "error")) {
        this.disposeDeadSession(root, activeSession.id);
        const session = await this.ensureSessionForLaunchConfig(owner, root, size, resolvedLaunchConfig);
        this.activateSession(root, session, size);
      }
    }
    return this.snapshotRoot(root);
  }

  async createSession(
    owner: TerminalOwner,
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig | null,
  ): Promise<TerminalPanelSnapshot> {
    const resolvedLaunchConfig = normalizeTerminalLaunchConfig(launchConfig);
    const root = this.ensureRoot(owner, workspaceId, terminalScopeId, resolvedLaunchConfig);
    const reusableSession = this.findReusableSession(root, resolvedLaunchConfig);
    if (reusableSession) {
      this.activateSession(root, reusableSession, size);
      return this.snapshotRoot(root);
    }
    this.ensureCapacityForNewSession(root, resolvedLaunchConfig);
    const session = resolvedLaunchConfig.mode === "pi-tui"
      ? await this.ensureSessionForLaunchConfig(owner, root, size, resolvedLaunchConfig)
      : await this.createSessionForRoot(owner, root, size, resolvedLaunchConfig);
    if (!root.sessionIds.includes(session.id)) {
      root.sessionIds.push(session.id);
    }
    this.activateSession(root, session, size);
    return this.snapshotRoot(root);
  }

  setActiveSession(
    owner: TerminalOwner,
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): TerminalPanelSnapshot {
    const session = this.requireOwnedSession(owner, terminalId);
    if (session.workspaceId !== workspaceId || session.terminalScopeId !== terminalScopeId) {
      throw new Error(`Terminal session ${terminalId} does not belong to this thread`);
    }
    const root = this.requireRoot(session.rootKey);
    if (!root.sessionIds.includes(terminalId)) {
      throw new Error(`Unknown terminal session: ${terminalId}`);
    }
    root.activeSessionId = terminalId;
    return this.snapshotRoot(root);
  }

  write(owner: TerminalOwner, terminalId: string, data: string): void {
    const session = this.requireOwnedSession(owner, terminalId);
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_WRITE_LENGTH) {
      return;
    }
    session.pty?.write(data);
  }

  getSessionSnapshot(owner: TerminalOwner, terminalId: string): TerminalSessionSnapshot | undefined {
    const session = this.sessionsById.get(terminalId);
    if (!session || session.ownerId !== owner.id) {
      return undefined;
    }
    return this.snapshotSession(session);
  }

  resize(owner: TerminalOwner, terminalId: string, size: TerminalSize, force = false): void {
    const session = this.requireOwnedSession(owner, terminalId);
    const normalizedSize = normalizeSize(size);
    if (!force && normalizedSize.cols === session.size.cols && normalizedSize.rows === session.size.rows) {
      return;
    }
    session.size = normalizedSize;
    session.pty?.resize(normalizedSize.cols, normalizedSize.rows);
  }

  async restart(
    owner: TerminalOwner,
    terminalId: string,
    size?: Partial<TerminalSize>,
    launchConfig?: TerminalLaunchConfig | null,
  ): Promise<TerminalPanelSnapshot> {
    const session = this.requireOwnedSession(owner, terminalId);
    this.disposePty(session);
    session.launchConfig = launchConfig != null ? normalizeTerminalLaunchConfig(launchConfig) : session.launchConfig;
    const command = await this.resolveLaunchCommand(session.workspaceId, session.terminalScopeId, session.launchConfig);
    session.shell = command.file;
    session.args = command.args;
    session.usesElectronRunAsNode = Boolean(command.usesElectronRunAsNode);
    session.cliPort = command.cliPort;
    session.title = this.defaultTitle(session);
    session.status = "running";
    session.replay = "";
    session.seq = 0;
    session.truncated = false;
    session.exitCode = undefined;
    session.signal = undefined;
    session.size = normalizeSize(size ?? session.size);
    session.dataChunkCount = 0;
    session.replayChunks = [];
    session.replayBuffer = undefined;
    session.pendingDataChunks = [];
    session.dataFlushScheduled = false;
    await this.spawnPty(session);
    return this.snapshotRoot(this.requireRoot(session.rootKey));
  }

  close(owner: TerminalOwner, terminalId: string): TerminalPanelSnapshot | null {
    const session = this.requireOwnedSession(owner, terminalId);
    const root = this.requireRoot(session.rootKey);
    this.disposeSession(session);
    this.sessionsById.delete(session.id);

    const index = root.sessionIds.indexOf(session.id);
    if (index >= 0) {
      root.sessionIds.splice(index, 1);
    }

    if (root.sessionIds.length === 0) {
      this.rootsByKey.delete(root.rootKey);
      return null;
    }

    if (root.activeSessionId === session.id) {
      const nextIndex = Math.min(index, root.sessionIds.length - 1);
      root.activeSessionId = root.sessionIds[nextIndex];
    }
    return this.snapshotRoot(root);
  }

  setTitle(owner: TerminalOwner, terminalId: string, title: string): void {
    const session = this.requireOwnedSession(owner, terminalId);
    const normalizedTitle = title.trim();
    session.title = normalizedTitle.length > 0 ? normalizedTitle.slice(0, 80) : this.defaultTitle(session);
  }

  retainWorkspacePaths(workspacePaths: readonly string[]): void {
    const retained = new Set(workspacePaths.map((workspacePath) => normalizeRootKey(workspacePath)));
    for (const [rootKey, root] of this.rootsByKey) {
      if (retained.has(root.workspaceRootKey)) {
        continue;
      }

      const retainedSessionIds: string[] = [];
      for (const sessionId of root.sessionIds) {
        const session = this.sessionsById.get(sessionId);
        if (!session) {
          continue;
        }
        if (session.launchConfig.mode === "pi-tui" && session.status === "running" && session.pty) {
          retainedSessionIds.push(session.id);
          continue;
        }
        this.disposeSession(session);
        this.sessionsById.delete(session.id);
      }

      if (retainedSessionIds.length > 0) {
        root.sessionIds.splice(0, root.sessionIds.length, ...retainedSessionIds);
        if (!root.activeSessionId || !retainedSessionIds.includes(root.activeSessionId)) {
          root.activeSessionId = retainedSessionIds[0];
        }
      } else {
        this.rootsByKey.delete(rootKey);
      }
    }
  }

  disposeWebContents(webContentsId: number): void {
    this.disposeOwner(`web:${webContentsId}`);
  }

  disposeRemoteClient(clientId: string): void {
    this.disposeOwner(`remote:${clientId}`);
  }

  private disposeOwner(ownerId: string): void {
    const rootKeysToDelete = new Set<string>();
    for (const [sessionId, session] of this.sessionsById) {
      if (session.ownerId !== ownerId) {
        continue;
      }
      this.disposeSession(session);
      this.sessionsById.delete(sessionId);
      rootKeysToDelete.add(session.rootKey);
    }
    for (const rootKey of rootKeysToDelete) {
      this.rootsByKey.delete(rootKey);
    }
  }

  dispose(): void {
    for (const session of this.sessionsById.values()) {
      this.disposeSession(session);
    }
    this.sessionsById.clear();
    this.rootsByKey.clear();
    this.pendingSessionsByLaunchKey.clear();
  }

  private ensureRoot(
    owner: TerminalOwner,
    workspaceId: string,
    terminalScopeId: string,
    launchConfig: TerminalLaunchConfig = { mode: "shell" },
  ): TerminalRoot {
    const normalizedScopeId = terminalScopeId.trim();
    if (!normalizedScopeId) {
      throw new Error("Terminal scope is required");
    }
    const workspacePath = this.options.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    ensureDirectory(workspacePath);
    const workspaceRootKey = normalizeRootKey(workspacePath);
    const rootKey = terminalRootKey(owner.id, workspaceRootKey, normalizedScopeId, launchConfig);
    const existingRoot = this.rootsByKey.get(rootKey);
    if (existingRoot) {
      return existingRoot;
    }
    const root: TerminalRoot = {
      rootKey,
      ownerId: owner.id,
      workspaceRootKey,
      workspaceId,
      terminalScopeId: normalizedScopeId,
      cwd: workspaceRootKey,
      activeSessionId: undefined,
      sessionIds: [],
    };
    this.rootsByKey.set(rootKey, root);
    return root;
  }

  private async ensureSessionForLaunchConfig(
    owner: TerminalOwner,
    root: TerminalRoot,
    size?: Partial<TerminalSize>,
    launchConfig: TerminalLaunchConfig = { mode: "shell" },
  ): Promise<TerminalSession> {
    const reusableSession = this.findReusableSession(root, launchConfig);
    if (reusableSession) {
      return reusableSession;
    }

    const pendingKey = this.pendingLaunchKey(root, launchConfig);
    let pendingSession = this.pendingSessionsByLaunchKey.get(pendingKey);
    if (!pendingSession) {
      this.ensureCapacityForNewSession(root, launchConfig);
      pendingSession = this.createSessionForRoot(owner, root, size, launchConfig);
      this.pendingSessionsByLaunchKey.set(pendingKey, pendingSession);
    }

    try {
      const session = await pendingSession;
      if (!root.sessionIds.includes(session.id)) {
        root.sessionIds.push(session.id);
      }
      return session;
    } finally {
      if (this.pendingSessionsByLaunchKey.get(pendingKey) === pendingSession) {
        this.pendingSessionsByLaunchKey.delete(pendingKey);
      }
    }
  }

  private activateSession(root: TerminalRoot, session: TerminalSession, size?: Partial<TerminalSize>): void {
    root.activeSessionId = session.id;
    session.lastActiveAt = Date.now();
    if (!size || !session.pty) {
      return;
    }
    const normalizedSize = normalizeSize(size);
    if (normalizedSize.cols === session.size.cols && normalizedSize.rows === session.size.rows) {
      return;
    }
    session.size = normalizedSize;
    session.pty.resize(normalizedSize.cols, normalizedSize.rows);
  }

  private findReusableSession(root: TerminalRoot, launchConfig: TerminalLaunchConfig): TerminalSession | undefined {
    if (launchConfig.mode !== "pi-tui") {
      return undefined;
    }

    const attachedSession = root.sessionIds
      .map((sessionId) => this.sessionsById.get(sessionId))
      .find((session): session is TerminalSession => isReusablePiTuiSession(session, root, launchConfig));
    if (attachedSession) {
      this.updateReusablePiTuiLaunchConfig(attachedSession, launchConfig);
      return attachedSession;
    }

    const detachedSession = [...this.sessionsById.values()].find((session) =>
      isReusablePiTuiSession(session, root, launchConfig),
    );
    if (!detachedSession) {
      return undefined;
    }

    logSessionTuiPerf("main.terminal.pi-tui.reattachExisting", detachedSession, {
      fromRootKey: detachedSession.rootKey,
      toRootKey: root.rootKey,
      requestedWorkspaceId: root.workspaceId,
      requestedTerminalScopeId: root.terminalScopeId,
    });
    this.attachSessionToRoot(root, detachedSession);
    this.updateReusablePiTuiLaunchConfig(detachedSession, launchConfig);
    return detachedSession;
  }

  private updateReusablePiTuiLaunchConfig(session: TerminalSession, launchConfig: TerminalLaunchConfig): void {
    if (session.launchConfig.mode !== "pi-tui" || launchConfig.mode !== "pi-tui") {
      return;
    }
    if (!session.launchConfig.sessionId && launchConfig.sessionId?.trim()) {
      session.launchConfig = {
        ...launchConfig,
        newSessionId: session.launchConfig.newSessionId,
        newSessionKey: session.launchConfig.newSessionKey,
        debugTraceId: launchConfig.debugTraceId ?? session.launchConfig.debugTraceId,
      };
    }
  }

  private attachSessionToRoot(root: TerminalRoot, session: TerminalSession): void {
    const previousRoot = this.rootsByKey.get(session.rootKey);
    if (previousRoot && previousRoot !== root) {
      this.removeSessionFromRoot(previousRoot, session.id);
    }

    if (!root.sessionIds.includes(session.id)) {
      root.sessionIds.push(session.id);
    }
    session.workspaceId = root.workspaceId;
    session.terminalScopeId = root.terminalScopeId;
    session.rootKey = root.rootKey;
  }

  private removeSessionFromRoot(root: TerminalRoot, terminalId: string, deleteEmptyRoot = true): void {
    const index = root.sessionIds.indexOf(terminalId);
    if (index < 0) {
      return;
    }

    root.sessionIds.splice(index, 1);
    if (root.activeSessionId === terminalId) {
      const nextIndex = Math.min(index, root.sessionIds.length - 1);
      root.activeSessionId = nextIndex >= 0 ? root.sessionIds[nextIndex] : undefined;
    }
    if (deleteEmptyRoot && root.sessionIds.length === 0) {
      this.rootsByKey.delete(root.rootKey);
    }
  }

  /**
   * Dispose a session that has exited or errored, removing it from the root
   * and the global sessions map. Used by ensurePanel to rebuild dead sessions
   * for non-pi-tui CLI modes (opencode, codex, claude).
   */
  private disposeDeadSession(root: TerminalRoot, sessionId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    this.disposeSession(session);
    this.sessionsById.delete(sessionId);
    const index = root.sessionIds.indexOf(sessionId);
    if (index >= 0) {
      root.sessionIds.splice(index, 1);
    }
    if (root.activeSessionId === sessionId) {
      root.activeSessionId = undefined;
    }
    if (root.sessionIds.length === 0) {
      this.rootsByKey.delete(root.rootKey);
    }
  }

  private pendingLaunchKey(root: TerminalRoot, launchConfig: TerminalLaunchConfig): string {
    if (launchConfig.mode === "pi-tui") {
      return `${root.ownerId}\0pi-tui\0${root.workspaceId}\0${piTuiLaunchTargetKey(root.terminalScopeId, launchConfig)}`;
    }
    return `${root.rootKey}\0${launchTargetKey(launchConfig)}`;
  }

  private maxSessionsForRoot(launchConfig: TerminalLaunchConfig): number {
    return launchConfig.mode === "pi-tui"
      ? normalizeTuiTabLimit(this.options.getTuiTabLimit())
      : MAX_TERMINAL_SESSIONS_PER_ROOT;
  }

  private ensureCapacityForNewSession(root: TerminalRoot, launchConfig: TerminalLaunchConfig): void {
    const maxSessions = this.maxSessionsForRoot(launchConfig);
    this.pruneMissingSessionsFromRoot(root);
    if (root.sessionIds.length < maxSessions) {
      return;
    }

    if (launchConfig.mode !== "pi-tui") {
      throw new Error(`A workspace can have up to ${maxSessions} terminal tabs.`);
    }

    while (root.sessionIds.length >= maxSessions) {
      const oldestSession = this.findOldestSessionInRoot(root);
      if (!oldestSession) {
        return;
      }
      this.disposeEvictedPiTuiSession(oldestSession, "main.terminal.pi-tui.evictRootFifo", {
        maxSessions,
      }, {
        deleteEmptyRoot: false,
      });
    }
  }

  private findOldestSessionInRoot(root: TerminalRoot): TerminalSession | undefined {
    for (const sessionId of root.sessionIds) {
      const session = this.sessionsById.get(sessionId);
      if (session) {
        return session;
      }
    }
    return undefined;
  }

  private pruneMissingSessionsFromRoot(root: TerminalRoot): void {
    for (let index = root.sessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = root.sessionIds[index];
      if (sessionId && !this.sessionsById.has(sessionId)) {
        root.sessionIds.splice(index, 1);
      }
    }
    if (root.activeSessionId && !root.sessionIds.includes(root.activeSessionId)) {
      root.activeSessionId = root.sessionIds[0];
    }
  }

  private async createSessionForRoot(
    owner: TerminalOwner,
    root: TerminalRoot,
    size?: Partial<TerminalSize>,
    launchConfig: TerminalLaunchConfig = { mode: "shell" },
  ): Promise<TerminalSession> {
    logLaunchConfigTuiPerf("main.terminal.createSessionForRoot.start", root.workspaceId, launchConfig, undefined, {
      rootKey: root.rootKey,
      terminalScopeId: root.terminalScopeId,
      size: normalizeSize(size),
    });
    if (launchConfig.mode === "pi-tui") {
      this.evictBackgroundPiTuiSessionsIfNeeded(root.rootKey);
    }
    const command = await this.resolveLaunchCommand(root.workspaceId, root.terminalScopeId, launchConfig);
    const session: TerminalSession = {
      id: `terminal-${Date.now().toString(36)}-${this.nextSessionNumber++}`,
      workspaceId: root.workspaceId,
      terminalScopeId: root.terminalScopeId,
      rootKey: root.rootKey,
      cwd: root.cwd,
      owner,
      ownerId: owner.id,
      launchConfig,
      shell: command.file,
      args: command.args,
      usesElectronRunAsNode: Boolean(command.usesElectronRunAsNode),
      title: "",
      status: "running",
      replay: "",
      seq: 0,
      truncated: false,
      exitCode: undefined,
      signal: undefined,
      size: normalizeSize(size),
      pty: undefined,
      dataSubscription: undefined,
      exitSubscription: undefined,
      dataChunkCount: 0,
      replayChunks: [],
      replayBuffer: undefined,
      pendingDataChunks: [],
      dataFlushScheduled: false,
      lastActiveAt: Date.now(),
      cliPort: command.cliPort,
    };
    session.title = this.defaultTitle(session);
    this.sessionsById.set(session.id, session);
    logSessionTuiPerf("main.terminal.createSessionForRoot.sessionCreated", session, {
      shell: session.shell,
      args: sanitizeCliArgsForDiagnostics(session.args),
      size: session.size,
    });
    await this.spawnPty(session);
    return session;
  }

  private async spawnPty(session: TerminalSession): Promise<void> {
    try {
      logSessionTuiPerf("main.terminal.spawn.start", session, {
        shell: session.shell,
        args: sanitizeCliArgsForDiagnostics(session.args),
        cwd: session.cwd,
        size: session.size,
      });
      ensureNodePtySpawnHelperExecutable(this.options.isPackaged);
      if (session.launchConfig.mode === "pi-tui") {
        logSessionTuiPerf("main.terminal.spawn.preparePiTuiLaunch.start", session);
        await this.options.preparePiTuiLaunch?.(session.workspaceId);
        logSessionTuiPerf("main.terminal.spawn.preparePiTuiLaunch.done", session);
      }
      if (session.launchConfig.mode === "pi-tui") {
        logSessionTuiPerf("main.terminal.spawn.getMcpBridgeServers.start", session);
      }
      const mcpBridgeServers = session.launchConfig.mode === "pi-tui" ? await this.options.getMcpBridgeServers() : [];
      if (session.launchConfig.mode === "pi-tui") {
        logSessionTuiPerf("main.terminal.spawn.getMcpBridgeServers.done", session, {
          serverCount: mcpBridgeServers.length,
          enabledCount: mcpBridgeServers.filter((server) => server.enabled).length,
          authorizedCount: mcpBridgeServers.filter((server) => server.authorized).length,
        });
      }
      const terminalEnv = buildTerminalEnv(
        session.launchConfig,
        this.options.getAgentDir(),
        mcpBridgeServers,
        session.usesElectronRunAsNode,
      );
      logSessionTuiPerf("main.terminal.spawn.nodePty.spawn.start", session);
      writeTuiDiagnosticLog("main.terminal.spawn.nodePty.spawn.diagnostics", {
        context: terminalSessionDiagnosticContext(session),
        diagnosticsLogPath: getTuiDiagnosticsLogPath() ?? "",
        command: {
          file: session.shell,
          args: sanitizeCliArgsForDiagnostics(session.args),
          usesElectronRunAsNode: session.usesElectronRunAsNode,
          shellPathInfo: describeFilesystemPath(session.shell),
          shellDirectory: describeDirectory(path.dirname(session.shell)),
          cwdInfo: describeFilesystemPath(session.cwd),
        },
        nodePty: describeNodePtyRuntime(),
        mcpBridgeServers: mcpBridgeServers.map((server) => ({
          id: server.id,
          name: server.name,
          url: sanitizeDiagnosticUrl(server.url),
          enabled: server.enabled,
          authorized: server.authorized,
          headerKeys: server.headers ? Object.keys(server.headers).sort() : [],
        })),
        ptyOptions: {
          name: "xterm-256color",
          cols: session.size.cols,
          rows: session.size.rows,
          cwd: session.cwd,
          env: sanitizeEnv(terminalEnv),
        },
      });
      session.pty = loadNodePty().spawn(session.shell, [...session.args], {
        name: "xterm-256color",
        cols: session.size.cols,
        rows: session.size.rows,
        cwd: session.cwd,
        env: terminalEnv,
      });
      logSessionTuiPerf("main.terminal.spawn.nodePty.spawn.done", session, {
        pid: session.pty.pid,
      });
    } catch (error) {
      session.status = "error";
      const message = error instanceof Error ? error.message : String(error);
      logSessionTuiPerf("main.terminal.spawn.error", session, {
        message,
        error: sanitizeError(error),
        diagnosticsLogPath: getTuiDiagnosticsLogPath() ?? "",
      });
      const messageWithLogPath = appendDiagnosticsLogPath(message);
      this.appendReplay(session, `${messageWithLogPath}\r\n`);
      this.sendToOwner(session, desktopIpc.terminalError, { terminalId: session.id, message: messageWithLogPath });
      return;
    }

    session.dataSubscription = session.pty.onData((data) => {
      session.seq += 1;
      session.dataChunkCount += 1;
      if (shouldLogTerminalDataChunk(session.dataChunkCount)) {
        logSessionTuiPerf("main.terminal.data", session, {
          chunkIndex: session.dataChunkCount,
          bytes: data.length,
          hasSgrBlink: hasSgrBlink(data),
          hasCursorMotion: hasCursorMotion(data),
          preview: data.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").slice(0, 120),
          raw: truncateForLog(data, 4_096),
        });
      }
      this.appendReplay(session, data);
      // Throttled IPC send — batch chunks on setImmediate to reduce event loop pressure
      session.pendingDataChunks.push(data);
      if (!session.dataFlushScheduled) {
        session.dataFlushScheduled = true;
        setImmediate(() => {
          session.dataFlushScheduled = false;
          if (session.pendingDataChunks.length > 0) {
            const batch = session.pendingDataChunks.join('');
            session.pendingDataChunks.length = 0;
            this.sendToOwner(session, desktopIpc.terminalData, {
              terminalId: session.id,
              seq: session.seq,
              data: batch,
            });
          }
        });
      }
    });
    session.exitSubscription = session.pty.onExit(({ exitCode, signal }) => {
      // Flush any pending data before exit to avoid data loss
      if (session.pendingDataChunks.length > 0) {
        const batch = session.pendingDataChunks.join('');
        session.pendingDataChunks.length = 0;
        this.sendToOwner(session, desktopIpc.terminalData, {
          terminalId: session.id,
          seq: session.seq,
          data: batch,
        });
      }
      session.dataFlushScheduled = false;
      session.status = "exited";
      session.exitCode = exitCode;
      session.signal = signal;
      logSessionTuiPerf("main.terminal.exit", session, {
        exitCode,
        signal,
        dataChunkCount: session.dataChunkCount,
        replayLength: this.getReplayBuffer(session).length,
        replayTailRaw: truncateForLog(this.getReplayBuffer(session).slice(-32_000), 32_000),
        replayTailPlain: truncateForLog(stripTerminalControlForDiagnostics(this.getReplayBuffer(session).slice(-32_000)), 32_000),
      });
      this.sendToOwner(session, desktopIpc.terminalExit, {
        terminalId: session.id,
        exitCode,
        signal,
      });
      void this.notifyPiTuiSessionExit(session).catch((error) => {
        console.error("Unable to refresh pi TUI session after terminal exit:", error instanceof Error ? error.message : error);
      });
    });
  }

  private appendReplay(session: TerminalSession, data: string): void {
    session.replayChunks.push(data);
    session.replayBuffer = undefined; // mark dirty, will be joined on read
  }

  /** Get the full replay buffer, joining chunks lazily. */
  private getReplayBuffer(session: TerminalSession): string {
    if (session.replayBuffer !== undefined) return session.replayBuffer;
    if (session.replayChunks.length > 0) {
      session.replayBuffer = session.replayChunks.join('');
      session.replayChunks.length = 0; // free chunk memory after join
    }
    return session.replayBuffer || '';
  }

  private sendToOwner(session: TerminalSession, channel: string, payload: unknown): void {
    const webContents = session.owner.webContents;
    if (webContents && !webContents.isDestroyed()) {
      webContents.send(channel, payload);
    }
    const remoteClientId = session.owner.remoteClientId;
    const remoteEventName = remoteTerminalEventName(channel);
    if (remoteClientId && remoteEventName) {
      this.options.publishRemoteTerminalEvent?.(remoteClientId, remoteEventName, payload);
    }
  }

  private requireOwnedSession(owner: TerminalOwner, terminalId: string): TerminalSession {
    const session = this.sessionsById.get(terminalId);
    if (!session || session.ownerId !== owner.id) {
      throw new Error(`Unknown terminal session: ${terminalId}`);
    }
    return session;
  }

  private async notifyPiTuiSessionExit(session: TerminalSession): Promise<void> {
    if (session.launchConfig.mode !== "pi-tui") {
      return;
    }
    await this.options.onPiTuiSessionExit?.({
      workspaceId: session.workspaceId,
      ...(session.launchConfig.sessionId?.trim() ? { sessionId: session.launchConfig.sessionId.trim() } : {}),
      terminalId: session.id,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
    });
  }

  private requireRoot(rootKey: string): TerminalRoot {
    const root = this.rootsByKey.get(rootKey);
    if (!root) {
      throw new Error(`Unknown terminal root: ${rootKey}`);
    }
    return root;
  }

  private snapshotRoot(root: TerminalRoot): TerminalPanelSnapshot {
    const sessions = root.sessionIds
      .map((sessionId) => this.sessionsById.get(sessionId))
      .filter((session): session is TerminalSession => Boolean(session));
    const activeSessionId = root.activeSessionId && sessions.some((session) => session.id === root.activeSessionId)
      ? root.activeSessionId
      : sessions[0]?.id ?? "";
    return {
      workspaceId: root.workspaceId,
      rootKey: root.rootKey,
      activeSessionId,
      sessions: sessions.map((session) => this.snapshotSession(session)),
    };
  }

  private snapshotSession(session: TerminalSession): TerminalSessionSnapshot {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      cwd: session.cwd,
      shell: session.shell,
      launchConfig: session.launchConfig,
      title: session.title,
      status: session.status,
      replay: this.getReplayBuffer(session),
      seq: session.seq,
      truncated: session.truncated,
      exitCode: session.exitCode,
      signal: session.signal,
      cliPort: session.cliPort,
    };
  }

  private disposeSession(session: TerminalSession): void {
    this.disposePty(session);
  }

  private disposePty(session: TerminalSession): void {
    const pty = session.pty;
    session.dataSubscription?.dispose();
    session.exitSubscription?.dispose();
    session.dataSubscription = undefined;
    session.exitSubscription = undefined;
    if (pty && process.platform !== "win32") {
      killUnixProcessGroup(pty.pid);
    }
    try {
      pty?.kill();
    } catch {
      // Best-effort cleanup when the child process has already exited.
    }
    session.pty = undefined;
  }

  /**
   * pi-tui sessions now keep running in the background after the renderer
   * hides/unmounts their panel (see TUI takeover in App.tsx), each in its
   * own per-session root. Before spawning a new background `pi` process,
   * make sure we don't exceed the configured TUI tab limit by killing the
   * first-created one that belongs to a different root.
   */
  private evictBackgroundPiTuiSessionsIfNeeded(excludeRootKey: string): void {
    let runningCount = 0;
    for (const session of this.sessionsById.values()) {
      if (session.launchConfig.mode === "pi-tui" && session.status === "running" && session.rootKey !== excludeRootKey) {
        runningCount += 1;
      }
    }
    const maxBackgroundTuiSessions = normalizeTuiTabLimit(this.options.getTuiTabLimit());
    while (runningCount >= maxBackgroundTuiSessions) {
      const oldest = this.findOldestBackgroundPiTuiSession(excludeRootKey);
      if (!oldest) {
        return;
      }
      this.disposeEvictedPiTuiSession(oldest, "main.terminal.pi-tui.evictBackgroundFifo", {
        maxBackgroundTuiSessions,
      });
      runningCount -= 1;
    }
  }

  private findOldestBackgroundPiTuiSession(excludeRootKey: string): TerminalSession | undefined {
    for (const session of this.sessionsById.values()) {
      if (session.launchConfig.mode !== "pi-tui" || session.status !== "running" || session.rootKey === excludeRootKey) {
        continue;
      }
      return session;
    }
    return undefined;
  }

  private disposeEvictedPiTuiSession(
    session: TerminalSession,
    eventName: string,
    details: Record<string, unknown>,
    options: { readonly deleteEmptyRoot?: boolean } = {},
  ): void {
    logSessionTuiPerf(eventName, session, {
      ...details,
      lastActiveAt: session.lastActiveAt,
    });
    this.disposeSession(session);
    session.status = "exited";
    this.sessionsById.delete(session.id);
    const root = this.rootsByKey.get(session.rootKey);
    if (root) {
      this.removeSessionFromRoot(root, session.id, options.deleteEmptyRoot ?? true);
    }
    this.sendToOwner(session, desktopIpc.terminalExit, { terminalId: session.id });
    void this.notifyPiTuiSessionExit(session).catch((error) => {
      console.error("Unable to refresh pi TUI session after evicting terminal:", error instanceof Error ? error.message : error);
    });
  }

  private defaultTitle(session: TerminalSession): string {
    if (session.launchConfig.mode === "pi-tui") {
      return "pi TUI";
    }
    return `Terminal ${session.id.split("-").at(-1) ?? ""}`.trim();
  }

  private async resolveLaunchCommand(
    workspaceId: string,
    terminalScopeId: string,
    launchConfig: TerminalLaunchConfig,
  ): Promise<TerminalLaunchCommand> {
    if (launchConfig.mode === "pi-tui") {
      logLaunchConfigTuiPerf("main.terminal.resolveLaunchCommand.start", workspaceId, launchConfig);
      const command = resolvePiCliCommand();
      const args = [...command.args];
      const sessionId = launchConfig.sessionId?.trim();
      if (sessionId) {
        logLaunchConfigTuiPerf("main.terminal.resolveLaunchCommand.sessionPath.start", workspaceId, launchConfig);
        const sessionFilePath = await this.options.getPiTuiSessionFilePath?.(workspaceId, sessionId);
        logLaunchConfigTuiPerf("main.terminal.resolveLaunchCommand.sessionPath.done", workspaceId, launchConfig, undefined, {
          found: Boolean(sessionFilePath),
          sessionArg: sessionFilePath ?? sessionId,
          sessionArgInfo: describeFilesystemPath(sessionFilePath ?? sessionId),
        });
        args.push("--session", sessionFilePath ?? sessionId);
      } else {
        const newSessionKey = getPiTuiNewSessionKey(terminalScopeId, launchConfig);
        const newSessionId = launchConfig.newSessionId?.trim() || createPiTuiNewSessionId(workspaceId, newSessionKey);
        args.push("--session-id", newSessionId);
        logLaunchConfigTuiPerf("main.terminal.resolveLaunchCommand.newSessionId", workspaceId, launchConfig, undefined, {
          sessionArg: newSessionId,
          newSessionKey,
          terminalScopeId,
        });
      }
      const mcpBridgePath = resolveMcpBridgeExtensionPath();
      if (mcpBridgePath && (command.usesElectronRunAsNode || !isAsarPath(mcpBridgePath))) {
        args.push("--extension", mcpBridgePath);
      }
      const activeSystemPrompt = this.options.getActiveSystemPrompt?.();
      if (activeSystemPrompt) {
        args.push("--append-system-prompt", activeSystemPrompt);
      }
      logLaunchConfigTuiPerf("main.terminal.resolveLaunchCommand.done", workspaceId, launchConfig, undefined, {
        file: command.file,
        args: sanitizeCliArgsForDiagnostics(args),
        usesElectronRunAsNode: Boolean(command.usesElectronRunAsNode),
        mcpBridgePath: mcpBridgePath ?? "",
        fileInfo: describeFilesystemPath(command.file),
        mcpBridgePathInfo: describeFilesystemPath(mcpBridgePath),
      });
      return {
        ...command,
        args,
      };
    }

    // ── 新增: CLI 模式处理 ──
    if (isExternalCliLaunchConfig(launchConfig)) {
      return this.resolveCliLaunchCommand(launchConfig);
    }

    return {
      file: this.resolveShell(),
      args: [],
    };
  }

  /**
   * 解析 CLI 模式启动命令
   * 可执行文件检测、缓存与适配器参数均由 CliDetector 负责
   */
  private async resolveCliLaunchCommand(
    launchConfig: TerminalLaunchConfig & { mode: SplitPanelCliType },
  ): Promise<TerminalLaunchCommand> {
    const cliPort = launchConfig.mode === "opencode" ? await findFreePort() : undefined;
    return this.options.resolveExternalCliLaunchCommand(
      launchConfig.mode,
      launchConfig.prompt ?? "",
      cliPort,
    );
  }

  private resolveShell(): string {
    const configuredShell = this.options.getIntegratedTerminalShell()?.trim();
    const shellPath = configuredShell || process.env.SHELL || defaultShellForPlatform();
    if (process.platform !== "win32" && !path.isAbsolute(shellPath)) {
      throw new Error(`Integrated terminal shell must be an absolute path: ${shellPath}`);
    }
    ensureExecutable(shellPath);
    return shellPath;
  }
}

export function resolvePiCliCommand(): TerminalLaunchCommand {
  const cacheKey = [
    process.env[PI_GUI_PI_CLI_PATH_ENV]?.trim() ?? "",
    process.env[PI_GUI_NODE_PATH_ENV]?.trim() ?? "",
    process.env[PI_GUI_NPM_CLI_PATH_ENV]?.trim() ?? "",
    process.env[PI_GUI_RIPGREP_PATH_ENV]?.trim() ?? "",
    process.env[PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK_ENV]?.trim() ?? "",
    process.execPath,
    process.cwd(),
    __dirname,
    process.resourcesPath ?? "",
  ].join("\0");
  if (cachedPiCliCommand?.cacheKey === cacheKey) {
    return cachedPiCliCommand.command;
  }
  const command = resolvePiCliCommandUncached();
  cachedPiCliCommand = { cacheKey, command };
  return command;
}

function resolvePiCliCommandUncached(): TerminalLaunchCommand {
  writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.start", {
    process: collectProcessDiagnostics(),
    env: sanitizeEnv({
      PATH: process.env.PATH,
      Path: process.env.Path,
      ComSpec: process.env.ComSpec,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      APPDATA: process.env.APPDATA,
      USERPROFILE: process.env.USERPROFILE,
      [PI_GUI_PI_CLI_PATH_ENV]: process.env[PI_GUI_PI_CLI_PATH_ENV],
      [PI_GUI_NODE_PATH_ENV]: process.env[PI_GUI_NODE_PATH_ENV],
      [PI_GUI_NPM_CLI_PATH_ENV]: process.env[PI_GUI_NPM_CLI_PATH_ENV],
      [PI_GUI_RIPGREP_PATH_ENV]: process.env[PI_GUI_RIPGREP_PATH_ENV],
      [PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK_ENV]: process.env[PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK_ENV],
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_APP_USER_DATA_DIR: process.env.PI_APP_USER_DATA_DIR,
    }),
    candidates: collectPiCliResolutionCandidates(),
  });

  const configuredCliPath = process.env[PI_GUI_PI_CLI_PATH_ENV]?.trim();
  if (configuredCliPath) {
    if (configuredCliPath.endsWith(".js")) {
      const nodePath = resolveNodeExecutable();
      if (!nodePath) {
        writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.configuredJsCli.noNode", {
          configuredCliPath,
          configuredCliPathInfo: describeFilesystemPath(configuredCliPath),
        });
        throw new Error(`${PI_GUI_PI_CLI_PATH_ENV} points to a JavaScript CLI but no node executable was found.`);
      }
      ensureReadable(configuredCliPath);
      writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.selected", {
        source: PI_GUI_PI_CLI_PATH_ENV,
        file: nodePath,
        args: [configuredCliPath],
        fileInfo: describeFilesystemPath(nodePath),
        cliInfo: describeFilesystemPath(configuredCliPath),
      });
      return { file: nodePath, args: [configuredCliPath] };
    }
    ensureExecutable(configuredCliPath);
    writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.selected", {
      source: PI_GUI_PI_CLI_PATH_ENV,
      file: configuredCliPath,
      args: [],
      fileInfo: describeFilesystemPath(configuredCliPath),
    });
    return { file: configuredCliPath, args: [] };
  }

  const bundledCliPath = resolvePiCliPathIfAvailable();
  const nodePath = resolveNodeExecutable();

  if (bundledCliPath && nodePath && !isAsarPath(bundledCliPath)) {
    writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.selected", {
      source: "bundled-cli-with-node",
      file: nodePath,
      args: [bundledCliPath],
      fileInfo: describeFilesystemPath(nodePath),
      cliInfo: describeFilesystemPath(bundledCliPath),
    });
    return { file: nodePath, args: [bundledCliPath] };
  }

  const piExecutable = findExecutableOnPath("pi");
  if (piExecutable) {
    writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.selected", {
      source: "path-pi",
      file: piExecutable,
      args: [],
      fileInfo: describeFilesystemPath(piExecutable),
    });
    return { file: piExecutable, args: [] };
  }

  const allowElectronFallback =
    "electron" in process.versions &&
    (process.platform !== "win32" || process.env[PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK_ENV]?.trim() === "1");
  if (bundledCliPath && allowElectronFallback) {
    writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.selected", {
      source: "electron-run-as-node-fallback",
      file: process.execPath,
      args: [bundledCliPath],
      fileInfo: describeFilesystemPath(process.execPath),
      cliInfo: describeFilesystemPath(bundledCliPath),
    });
    return { file: process.execPath, args: [bundledCliPath], usesElectronRunAsNode: true };
  }

  writeTuiDiagnosticLog("main.terminal.resolvePiCliCommand.failed", {
    bundledCliPath,
    bundledCliPathInfo: describeFilesystemPath(bundledCliPath),
    nodePath,
    nodePathInfo: describeFilesystemPath(nodePath),
    allowElectronFallback,
    candidates: collectPiCliResolutionCandidates(),
  });
  throw new Error(
    `pi TUI requires a console node or pi executable. Set ${PI_GUI_NODE_PATH_ENV} to node, set ${PI_GUI_PI_CLI_PATH_ENV} to the pi CLI, or install node/pi on PATH. Electron-as-Node fallback is automatic outside Windows and available on Windows only when ${PI_GUI_ALLOW_ELECTRON_NODE_FALLBACK_ENV}=1 because Windows GUI executables do not provide a usable PTY console.`,
  );
}

function resolvePiCliPathIfAvailable(): string | undefined {
  const candidates = getPiCliPathCandidates();
  const selected = candidates.find((candidate) => existsSync(candidate));
  writeTuiDiagnosticLog("main.terminal.resolvePiCliPathIfAvailable", {
    selected,
    candidates: candidates.map((candidate) => describeFilesystemPath(candidate)),
  });
  return selected;
}

function resolveMcpBridgeExtensionPath(): string | undefined {
  if (cachedMcpBridgeExtensionPath && existsSync(cachedMcpBridgeExtensionPath)) {
    return cachedMcpBridgeExtensionPath;
  }
  const candidates = getMcpBridgeExtensionPathCandidates();
  cachedMcpBridgeExtensionPath = candidates.find((candidate) => existsSync(candidate));
  writeTuiDiagnosticLog("main.terminal.resolveMcpBridgeExtensionPath", {
    selected: cachedMcpBridgeExtensionPath,
    candidates: candidates.map((candidate) => describeFilesystemPath(candidate)),
  });
  return cachedMcpBridgeExtensionPath;
}

function getPiCliPathCandidates(): string[] {
  return uniqueDefinedStrings([
    findUpwardNodeModuleFile(process.cwd(), PI_CODING_AGENT_PACKAGE, "dist", "cli.js"),
    path.join(
      process.resourcesPath ?? "",
      "app.asar.unpacked",
      "node_modules",
      ...PI_CODING_AGENT_PACKAGE.split("/"),
      "dist",
      "cli.js",
    ),
    findUpwardNodeModuleFile(__dirname, PI_CODING_AGENT_PACKAGE, "dist", "cli.js"),
    path.join(process.resourcesPath ?? "", "app.asar", "node_modules", ...PI_CODING_AGENT_PACKAGE.split("/"), "dist", "cli.js"),
  ]);
}

function getMcpBridgeExtensionPathCandidates(): string[] {
  return uniqueDefinedStrings([
    findUpwardFile(process.cwd(), "packages", "mcp-bridge-extension", "dist", "index.js"),
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "out", "mcp-bridge-extension", "dist", "index.js"),
    findUpwardFile(__dirname, "packages", "mcp-bridge-extension", "dist", "index.js"),
    path.join(__dirname, "..", "mcp-bridge-extension", "dist", "index.js"),
    path.join(process.resourcesPath ?? "", "app.asar", "out", "mcp-bridge-extension", "dist", "index.js"),
  ]);
}

function collectPiCliResolutionCandidates(): Record<string, unknown> {
  return {
    piCliCandidates: getPiCliPathCandidates().map((candidate) => describeFilesystemPath(candidate)),
    mcpBridgeCandidates: getMcpBridgeExtensionPathCandidates().map((candidate) => describeFilesystemPath(candidate)),
    bundledNodeCandidates: getBundledNodeExecutableCandidates().map((candidate) => describeFilesystemPath(candidate)),
    bundledNpmCliCandidates: getBundledNpmCliPathCandidates().map((candidate) => describeFilesystemPath(candidate)),
    bundledRipgrepCandidates: getBundledRipgrepExecutableCandidates().map((candidate) => describeFilesystemPath(candidate)),
    nodePathCandidates: findExecutableCandidatesOnPath("node").map((candidate) => describeFilesystemPath(candidate)),
    piPathCandidates: findExecutableCandidatesOnPath("pi").map((candidate) => describeFilesystemPath(candidate)),
    pathLookup: describePathLookupEnvironment(),
  };
}

function collectProcessDiagnostics(): Record<string, unknown> {
  return {
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
    execPath: process.execPath,
    execPathInfo: describeFilesystemPath(process.execPath),
    resourcesPath: process.resourcesPath,
    resourcesPathInfo: describeFilesystemPath(process.resourcesPath),
    dirname: __dirname,
    dirnameInfo: describeFilesystemPath(__dirname),
    versions: process.versions,
  };
}

function findUpwardNodeModuleFile(startDirectory: string, packageName: string, ...segments: readonly string[]): string | undefined {
  return findUpwardFile(startDirectory, "node_modules", ...packageName.split("/"), ...segments);
}

function findUpwardFile(startDirectory: string, ...segments: readonly string[]): string | undefined {
  let currentDirectory = path.resolve(startDirectory);
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(currentDirectory, ...segments);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
  return undefined;
}

function uniqueDefinedStrings(values: readonly (string | undefined)[]): string[] {
  const uniqueValues: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    uniqueValues.push(value);
    seen.add(value);
  }
  return uniqueValues;
}


function terminalRootKey(
  ownerId: string,
  workspaceRootKey: string,
  terminalScopeId: string,
  launchConfig: TerminalLaunchConfig,
): string {
  if (launchConfig.mode === "pi-tui") {
    // The pi-tui scope already encodes the logical workspace/session target.
    // Do not include the currently selected workspace path in the root key,
    // otherwise a cross-project render race can create a second root and leave
    // the still-running PTY attached to the old root.
    return `${ownerId}\0pi-tui\0${terminalScopeId}`;
  }
  return `${ownerId}\0${workspaceRootKey}\0${terminalScopeId}`;
}

function isReusablePiTuiSession(
  session: TerminalSession | undefined,
  root: TerminalRoot,
  launchConfig: TerminalLaunchConfig,
): session is TerminalSession {
  return Boolean(
    session &&
      session.ownerId === root.ownerId &&
      session.workspaceId === root.workspaceId &&
      (session.status === "running" || session.status === "exited") &&
      session.launchConfig.mode === "pi-tui" &&
      samePiTuiLaunchTarget(session, root, launchConfig),
  );
}

function samePiTuiLaunchTarget(
  session: TerminalSession,
  root: TerminalRoot,
  launchConfig: TerminalLaunchConfig,
): boolean {
  if (session.launchConfig.mode !== "pi-tui" || launchConfig.mode !== "pi-tui") {
    return false;
  }
  const existingSessionId = session.launchConfig.sessionId?.trim() ?? "";
  const requestedSessionId = launchConfig.sessionId?.trim() ?? "";
  const existingNewSessionId = session.launchConfig.newSessionId?.trim() ?? "";
  const requestedNewSessionId = launchConfig.newSessionId?.trim() ?? "";
  if (existingSessionId || requestedSessionId) {
    return (
      existingSessionId === requestedSessionId ||
      Boolean(requestedSessionId && existingNewSessionId && existingNewSessionId === requestedSessionId) ||
      Boolean(existingSessionId && requestedNewSessionId && existingSessionId === requestedNewSessionId)
    );
  }
  return getPiTuiNewSessionKey(session.terminalScopeId, session.launchConfig) === getPiTuiNewSessionKey(root.terminalScopeId, launchConfig);
}

function launchTargetKey(launchConfig: TerminalLaunchConfig): string {
  if (launchConfig.mode === "pi-tui") {
    return `pi-tui:${launchConfig.sessionId ?? ""}`;
  }
  return launchConfig.mode;
}

function piTuiLaunchTargetKey(terminalScopeId: string, launchConfig: TerminalLaunchConfig): string {
  if (launchConfig.mode !== "pi-tui") {
    return launchConfig.mode;
  }
  const sessionId = launchConfig.sessionId?.trim();
  const newSessionId = launchConfig.newSessionId?.trim();
  return sessionId ? `pi-tui:${sessionId}` : `pi-tui-new:${newSessionId || getPiTuiNewSessionKey(terminalScopeId, launchConfig)}`;
}

function getPiTuiNewSessionKey(terminalScopeId: string, launchConfig: TerminalLaunchConfig): string {
  if (launchConfig.mode !== "pi-tui") {
    return terminalScopeId;
  }
  return launchConfig.newSessionKey?.trim() || terminalScopeId;
}

function createPiTuiNewSessionId(workspaceId: string, sessionKey: string): string {
  const digest = createHash("sha256").update(workspaceId).update("\0").update(sessionKey).digest("hex").slice(0, 24);
  return `pi-gui-${digest}`;
}

function logLaunchConfigTuiPerf(
  phase: string,
  workspaceId: string,
  launchConfig: TerminalLaunchConfig,
  terminalId?: string,
  details: Record<string, unknown> = {},
): void {
  if (launchConfig.mode !== "pi-tui") {
    return;
  }
  const context = {
    workspaceId,
    sessionId: launchConfig.sessionId,
    terminalId,
    traceId: launchConfig.debugTraceId,
  };
  logTuiPerf(phase, context, details);
  writeTuiDiagnosticLog(phase, {
    context,
    details,
  });
}

function logSessionTuiPerf(
  phase: string,
  session: TerminalSession,
  details: Record<string, unknown> = {},
): void {
  if (session.launchConfig.mode !== "pi-tui") {
    return;
  }
  const context = {
    workspaceId: session.workspaceId,
    sessionId: session.launchConfig.sessionId,
    terminalId: session.id,
    traceId: session.launchConfig.debugTraceId,
  };
  const mergedDetails = {
    terminalScopeId: session.terminalScopeId,
    ...details,
  };
  logTuiPerf(phase, context, mergedDetails);
  writeTuiDiagnosticLog(phase, {
    context,
    details: mergedDetails,
  });
}

function terminalSessionDiagnosticContext(session: TerminalSession): Record<string, unknown> {
  const launchConfig = session.launchConfig;
  return {
    workspaceId: session.workspaceId,
    sessionId: launchConfig.mode === "pi-tui" ? launchConfig.sessionId : undefined,
    newSessionId: launchConfig.mode === "pi-tui" ? launchConfig.newSessionId : undefined,
    terminalId: session.id,
    traceId: launchConfig.mode === "pi-tui" ? launchConfig.debugTraceId : undefined,
    terminalScopeId: session.terminalScopeId,
    rootKey: session.rootKey,
    ownerId: session.ownerId,
  };
}

function describeNodePtyRuntime(): Record<string, unknown> {
  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    const packageDir = path.dirname(packageJsonPath);
    return {
      packageJsonPath,
      packageJsonPathInfo: describeFilesystemPath(packageJsonPath),
      packageDirectory: describeDirectory(packageDir),
      buildDirectory: describeDirectory(path.join(packageDir, "build")),
      prebuildsDirectory: describeDirectory(path.join(packageDir, "prebuilds")),
      thirdPartyDirectory: describeDirectory(path.join(packageDir, "third_party")),
    };
  } catch (error) {
    return {
      error: sanitizeError(error),
    };
  }
}

function appendDiagnosticsLogPath(message: string): string {
  const logPath = getTuiDiagnosticsLogPath();
  if (!logPath) {
    return message;
  }
  return `${message}\nTUI diagnostics log: ${logPath}`;
}

export function stripTerminalControlForDiagnostics(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function sanitizeCliArgsForDiagnostics(args: readonly string[]): string[] {
  const sanitized: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      sanitized.push(redactCliArgValue(arg));
      redactNext = false;
      continue;
    }
    sanitized.push(arg);
    if (arg === "--append-system-prompt" || arg === "--system-prompt" || arg === "--api-key") {
      redactNext = true;
    }
  }
  return sanitized;
}

function redactCliArgValue(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `<redacted length=${value.length} sha256=${hash}>`;
}

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = "<redacted>";
    }
    if (url.password) {
      url.password = "<redacted>";
    }
    if (url.search) {
      url.search = "?<redacted>";
    }
    if (url.hash) {
      url.hash = "#<redacted>";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function shouldLogTerminalDataChunk(chunkIndex: number): boolean {
  return chunkIndex <= 8 || chunkIndex === 10 || chunkIndex === 15 || chunkIndex === 20 || chunkIndex % 25 === 0;
}

function hasSgrBlink(data: string): boolean {
  for (const match of data.matchAll(/\x1B\[([0-9;:]*)m/g)) {
    const params = (match[1] || "0").split(/[;:]/);
    if (params.includes("5") || params.includes("6")) {
      return true;
    }
  }
  return false;
}

function hasCursorMotion(data: string): boolean {
  return /[\b\r]|\x1B\[[0-?]*[ -/]*[A-HJKST]/.test(data);
}

function normalizeSize(size?: Partial<TerminalSize>): TerminalSize {
  return {
    cols: clampInteger(size?.cols, DEFAULT_TERMINAL_SIZE.cols, 10, 500),
    rows: clampInteger(size?.rows, DEFAULT_TERMINAL_SIZE.rows, 4, 200),
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function normalizeRootKey(workspacePath: string): string {
  try {
    return realpathSync.native(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

function ensureDirectory(directoryPath: string): void {
  const stats = statSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${directoryPath}`);
  }
}

function ensureExecutable(commandPath: string): void {
  if (process.platform === "win32" && !path.isAbsolute(commandPath)) {
    return;
  }
  accessSync(commandPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
}

function ensureReadable(filePath: string): void {
  accessSync(filePath, constants.R_OK);
}

function resolveNodeExecutable(): string | undefined {
  const configuredNodePath = process.env[PI_GUI_NODE_PATH_ENV]?.trim();
  if (configuredNodePath) {
    ensureExecutable(configuredNodePath);
    writeTuiDiagnosticLog("main.terminal.resolveNodeExecutable.selected", {
      source: PI_GUI_NODE_PATH_ENV,
      nodePath: configuredNodePath,
      nodePathInfo: describeFilesystemPath(configuredNodePath),
    });
    return configuredNodePath;
  }
  const bundledNodePath = resolveBundledNodeExecutable();
  if (bundledNodePath) {
    writeTuiDiagnosticLog("main.terminal.resolveNodeExecutable.selected", {
      source: "bundled-node-runtime",
      nodePath: bundledNodePath,
      nodePathInfo: describeFilesystemPath(bundledNodePath),
    });
    return bundledNodePath;
  }
  if (!("electron" in process.versions)) {
    try {
      ensureExecutable(process.execPath);
      writeTuiDiagnosticLog("main.terminal.resolveNodeExecutable.selected", {
        source: "process.execPath",
        nodePath: process.execPath,
        nodePathInfo: describeFilesystemPath(process.execPath),
      });
      return process.execPath;
    } catch {
      // Continue to PATH lookup.
    }
  }
  const pathNode = findExecutableOnPath("node");
  writeTuiDiagnosticLog("main.terminal.resolveNodeExecutable.pathLookup", {
    selected: pathNode,
    selectedInfo: describeFilesystemPath(pathNode),
    candidates: findExecutableCandidatesOnPath("node").map((candidate) => describeFilesystemPath(candidate)),
  });
  return pathNode;
}

function resolveBundledNodeExecutable(): string | undefined {
  const candidates = getBundledNodeExecutableCandidates();
  writeTuiDiagnosticLog("main.terminal.resolveBundledNodeExecutable.candidates", {
    candidates: candidates.map((candidate) => describeFilesystemPath(candidate)),
  });
  for (const candidate of candidates) {
    try {
      ensureExecutable(candidate);
      return candidate;
    } catch {
      // Try the next packaged runtime candidate.
    }
  }
  return undefined;
}

function getBundledNodeExecutableCandidates(): string[] {
  const resourcesPath = process.resourcesPath ?? "";
  if (process.platform === "darwin") {
    return [path.join(resourcesPath, "node-runtime", "node")];
  }
  return [];
}

function resolveBundledNpmCliPath(): string | undefined {
  const configuredNpmCliPath = process.env[PI_GUI_NPM_CLI_PATH_ENV]?.trim();
  const candidates = uniqueDefinedStrings([configuredNpmCliPath, ...getBundledNpmCliPathCandidates()]);
  const selected = candidates.find((candidate) => existsSync(candidate));
  writeTuiDiagnosticLog("main.terminal.resolveBundledNpmCliPath", {
    selected,
    selectedInfo: describeFilesystemPath(selected),
    candidates: candidates.map((candidate) => describeFilesystemPath(candidate)),
  });
  return selected;
}

function getBundledNpmCliPathCandidates(): string[] {
  if (process.platform !== "darwin") {
    return [];
  }
  const runtimeDir = path.join(process.resourcesPath ?? "", "node-runtime");
  // Prefer lib/node_modules (survives electron-builder extraResources filtering).
  return [
    path.join(runtimeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

function resolveBundledRipgrepExecutable(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const configuredRipgrepPath = process.env[PI_GUI_RIPGREP_PATH_ENV]?.trim();
  const candidates = uniqueDefinedStrings([
    configuredRipgrepPath,
    resolveRipgrepPathFromPackage(),
    ...getBundledRipgrepExecutableCandidates(),
  ]);
  const selected = candidates.find((candidate) => existsSync(candidate));
  writeTuiDiagnosticLog("main.terminal.resolveBundledRipgrepExecutable", {
    selected,
    selectedInfo: describeFilesystemPath(selected),
    candidates: candidates.map((candidate) => describeFilesystemPath(candidate)),
  });
  return selected;
}

function getBundledRipgrepExecutableCandidates(): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  return findRipgrepExecutablesInDirectories([
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "node_modules", "@vscode", "ripgrep", "bin"),
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "node_modules", "@vscode"),
  ]);
}

function resolveRipgrepPathFromPackage(): string | undefined {
  try {
    const ripgrep = require("@vscode/ripgrep") as { readonly rgPath?: unknown };
    if (typeof ripgrep.rgPath !== "string" || !ripgrep.rgPath.trim()) {
      return undefined;
    }
    return preferUnpackedAsarPath(ripgrep.rgPath.trim());
  } catch {
    return undefined;
  }
}

function preferUnpackedAsarPath(filePath: string): string {
  if (!isAsarPath(filePath)) {
    return filePath;
  }
  const unpackedPath = filePath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return existsSync(unpackedPath) ? unpackedPath : filePath;
}

function findRipgrepExecutablesInDirectories(directories: readonly string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    findRipgrepExecutablesInDirectory(directory, 0, results, seen);
  }
  return results;
}

function findRipgrepExecutablesInDirectory(
  directory: string,
  depth: number,
  results: string[],
  seen: Set<string>,
): void {
  if (depth > 4 || !existsSync(directory)) {
    return;
  }
  let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === "rg.exe") {
      const key = entryPath.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push(entryPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      findRipgrepExecutablesInDirectory(entryPath, depth + 1, results, seen);
    }
  }
}

function getBundledNodeModuleBinCandidates(): string[] {
  return [path.join(process.resourcesPath ?? "", "app.asar.unpacked", "node_modules", ".bin")];
}

function findExecutableOnPath(binaryName: string): string | undefined {
  for (const candidate of findExecutableCandidatesOnPath(binaryName)) {
    if (isUsablePathExecutableCandidate(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findExecutableCandidatesOnPath(binaryName: string): string[] {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const candidates: string[] = [];
  for (const entry of pathEntriesFromEnvironment()) {
    for (const extension of extensions) {
      candidates.push(path.join(entry, `${binaryName}${extension}`));
    }
  }
  return candidates;
}

function pathEntriesFromEnvironment(): string[] {
  const entries = rawPathValuesFromEnvironment().flatMap(({ value }) =>
    value.split(path.delimiter).map((entry) => sanitizePathEntry(entry)).filter(Boolean),
  );
  if (process.platform !== "win32") {
    entries.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
    if (process.env.HOME) {
      entries.push(path.join(process.env.HOME, ".local", "bin"), path.join(process.env.HOME, ".bun", "bin"));
    }
  }
  // macOS packaged builds still include a node runtime.
  const bundledNodePath = resolveBundledNodeExecutable();
  if (bundledNodePath) {
    entries.unshift(path.dirname(bundledNodePath));
  }
  return uniqueDefinedStrings(entries);
}

function rawPathValuesFromEnvironment(): Array<{ readonly key: string; readonly value: string }> {
  const values: Array<{ readonly key: string; readonly value: string }> = [];
  if (typeof process.env.PATH === "string") {
    values.push({ key: "PATH", value: process.env.PATH });
  }
  if (typeof process.env.Path === "string" && process.env.Path !== process.env.PATH) {
    values.push({ key: "Path", value: process.env.Path });
  }
  return values;
}

function sanitizePathEntry(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }
  const unquoted = stripSurroundingQuotes(trimmed);
  if (process.platform === "win32" && unquoted.includes('"')) {
    return undefined;
  }
  return unquoted;
}

function describePathLookupEnvironment(): Record<string, unknown> {
  const rawVariables = rawPathValuesFromEnvironment();
  return {
    rawVariables: rawVariables.map(({ key, value }) => ({
      key,
      length: value.length,
      entryCount: value.split(path.delimiter).length,
    })),
    usableEntries: pathEntriesFromEnvironment().map((entry) => ({
      entry,
      absolute: path.isAbsolute(entry),
      info: describeFilesystemPath(entry),
    })),
    rejectedEntries: rawVariables.flatMap(({ key, value }) =>
      value
        .split(path.delimiter)
        .map((entry, index) => ({
          key,
          index,
          entry,
          reason: rejectedPathEntryReason(entry),
        }))
        .filter((entry) => entry.reason),
    ),
  };
}

function rejectedPathEntryReason(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "empty";
  }
  const unquoted = stripSurroundingQuotes(trimmed);
  if (process.platform === "win32" && unquoted.includes('"')) {
    return "contains-unmatched-quote";
  }
  return undefined;
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function isUsablePathExecutableCandidate(candidate: string): boolean {
  if (process.platform === "win32" && !path.isAbsolute(candidate)) {
    return false;
  }
  try {
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAsarPath(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  return normalized.includes(`${path.sep}app.asar${path.sep}`) || normalized.endsWith(`${path.sep}app.asar`);
}

function remoteTerminalEventName(channel: string): TerminalRemoteEventName | undefined {
  switch (channel) {
    case desktopIpc.terminalData:
      return "terminal-data";
    case desktopIpc.terminalExit:
      return "terminal-exit";
    case desktopIpc.terminalError:
      return "terminal-error";
    default:
      return undefined;
  }
}

function defaultShellForPlatform(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  if (process.platform === "darwin") {
    return "/bin/zsh";
  }
  return "/bin/bash";
}

function buildTerminalEnv(
  launchConfig: TerminalLaunchConfig,
  agentDir: string | undefined,
  mcpBridgeServers: readonly TerminalMcpBridgeServerConfig[],
  usesElectronRunAsNode: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "pi-gui";
  if (launchConfig.mode === "pi-tui") {
    if (usesElectronRunAsNode) {
      env.ELECTRON_RUN_AS_NODE = "1";
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
    }
    const resolvedAgentDir = agentDir || env.PI_CODING_AGENT_DIR;
    if (resolvedAgentDir) {
      env.PI_CODING_AGENT_DIR = resolvedAgentDir;
    }
    applyBundledRuntimeToTerminalEnv(env);
    env[MCP_BRIDGE_SERVERS_ENV] = JSON.stringify(mcpBridgeServers);
  } else if (isExternalCliLaunchConfig(launchConfig)) {
    delete env.ELECTRON_RUN_AS_NODE;
    applyBundledRuntimeToTerminalEnv(env);
    prependEnvPathEntries(env, getExternalCliPathCandidates());
  }
  delete env.TERMINFO;
  delete env.TERMINFO_DIRS;
  return env;
}

/**
 * Remote invoke serializes omitted/undefined args as JSON null. Default
 * parameters only cover undefined, so every public entry that accepts a
 * launch config must normalize null/undefined first.
 */
function normalizeTerminalLaunchConfig(
  launchConfig?: TerminalLaunchConfig | null,
): TerminalLaunchConfig {
  return launchConfig ?? { mode: "shell" };
}

function isExternalCliLaunchConfig(
  launchConfig: TerminalLaunchConfig | null | undefined,
): launchConfig is TerminalLaunchConfig & { readonly mode: SplitPanelCliType } {
  if (!launchConfig || typeof launchConfig !== "object") {
    return false;
  }
  switch (launchConfig.mode) {
    case "codex":
    case "claude":
    case "opencode":
    case "grok":
    case "copilot":
    case "antigravity":
    case "kiro":
    case "cursor":
    case "droid":
      return true;
    default:
      return false;
  }
}

function applyBundledRuntimeToTerminalEnv(env: Record<string, string>): void {
  const nodePath = resolveBundledNodeExecutable();
  const npmCliPath = resolveBundledNpmCliPath();

  const pathEntries: string[] = [
    nodePath ? path.dirname(nodePath) : undefined,
    npmCliPath ? path.dirname(npmCliPath) : undefined,
    ...getBundledNodeModuleBinCandidates(),
  ].filter((entry): entry is string => Boolean(entry));

  // Windows 特有：打包 ripgrep
  if (process.platform === "win32") {
    const ripgrepPath = resolveBundledRipgrepExecutable();
    if (ripgrepPath) {
      env[PI_GUI_RIPGREP_PATH_ENV] = ripgrepPath;
      pathEntries.push(path.dirname(ripgrepPath));
    }
  }

  if (nodePath) {
    env[PI_GUI_NODE_PATH_ENV] = nodePath;
  }
  if (npmCliPath) {
    env[PI_GUI_NPM_CLI_PATH_ENV] = npmCliPath;
  }
  prependEnvPathEntries(env, pathEntries);
}

function getExternalCliPathCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return [
    home ? path.join(home, ".local", "bin") : undefined,
    home ? path.join(home, ".codex", "packages", "standalone", "current") : undefined,
    home ? path.join(home, ".opencode", "bin") : undefined,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((entry): entry is string => Boolean(entry));
}

function prependEnvPathEntries(env: Record<string, string>, entries: readonly string[]): void {
  const pathKey = resolveEnvPathKey(env);
  const currentPath = env[pathKey] ?? "";
  const nextPath = uniquePathEntries([...entries, ...currentPath.split(path.delimiter)]).join(path.delimiter);
  env[pathKey] = nextPath;
  env.PATH = nextPath;
  env.Path = nextPath;
}

function resolveEnvPathKey(env: Record<string, string>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function uniquePathEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueEntries: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueEntries.push(trimmed);
  }
  return uniqueEntries;
}

function ensureNodePtySpawnHelperExecutable(isPackaged: boolean): void {
  if (process.platform === "win32") {
    return;
  }
  const packageDir = path.dirname(require.resolve("node-pty/package.json"));
  const helperPath = resolveNodePtySpawnHelperPath(packageDir);
  if (!helperPath) {
    return;
  }
  const checkKey = `${isPackaged ? "packaged" : "dev"}\0${helperPath}`;
  if (nodePtySpawnHelperExecutableCheckKey === checkKey) {
    return;
  }
  try {
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    if (isPackaged) {
      throw error;
    }
    chmodSync(helperPath, 0o755);
  }
  nodePtySpawnHelperExecutableCheckKey = checkKey;
}

function loadNodePty(): NodePty {
  nodePty ??= require("node-pty") as NodePty;
  return nodePty;
}

function killUnixProcessGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  // Phase 1: SIGTERM to the process group for graceful shutdown.
  // OpenCode and similar CLIs spawn child HTTP servers that need a
  // moment to release their bound ports before being force-killed.
  sendSignalToProcessGroup(pid, "SIGTERM");
  // Phase 2: escalate to SIGKILL after 3s if the group is still alive.
  // This prevents orphaned processes from holding port 4097 indefinitely.
  setTimeout(() => {
    sendSignalToProcessGroup(pid, "SIGKILL");
  }, 3_000).unref();
}

function sendSignalToProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to the direct child when the process is not a group leader.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort cleanup; the process may already be gone.
  }
}

/**
 * Find a free TCP port on 127.0.0.1 by opening a server on port 0 and
 * immediately closing it. There is an inherent TOCTOU race: the port
 * could be taken between this call and the actual CLI binding. This is
 * acceptable — if it happens, the CLI will fail to start and ensurePanel
 * will rebuild the session on the next attempt.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function resolveNodePtySpawnHelperPath(packageDir: string): string | undefined {
  const candidateDirs = [
    path.join(packageDir, "build", "Release"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`),
  ];
  for (const candidateDir of candidateDirs) {
    const ptyNodePath = path.join(candidateDir, "pty.node");
    const helperPath = path.join(candidateDir, "spawn-helper");
    if (existsSync(ptyNodePath) && existsSync(helperPath)) {
      return helperPath;
    }
  }
  return undefined;
}
