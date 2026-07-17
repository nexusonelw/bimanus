import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SessionFileWatchWorkspace {
  readonly workspaceId: string;
  readonly path: string;
  readonly displayName?: string;
}

export interface SessionFileWatcherOptions {
  readonly getAgentDir: () => string;
  readonly onWorkspaceSessionsChanged: (workspaceId: string) => void | Promise<void>;
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Maximum duration (ms) to suppress a workspace before forcing a sync.
   * Acts as a safety net so a hung agent doesn't block syncs forever.
   * Default: 30 seconds.
   */
  readonly maxSuppressMs?: number;
}

interface WatchTarget {
  readonly workspaceId: string;
  workspacePath: string;
  displayName: string | undefined;
  sessionDir: string;
  watcher: FSWatcher | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  fingerprint: string | undefined;
  pollErrorReported: boolean;
  disposed: boolean;
  /** When non-zero, file-change events are ignored until this timestamp (epoch ms). */
  suppressedUntil: number;
  /** Safety-net timer that forces a sync even while suppressed. */
  suppressMaxTimer: NodeJS.Timeout | undefined;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_MAX_SUPPRESS_MS = 30_000;

export class SessionFileWatcher {
  private readonly targetsByWorkspaceId = new Map<string, WatchTarget>();
  private readonly syncTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
  private readonly syncQueuesByWorkspaceId = new Map<string, Promise<void>>();

  constructor(private readonly options: SessionFileWatcherOptions) {}

  retainWorkspaces(workspaces: readonly SessionFileWatchWorkspace[]): void {
    const retainedWorkspaceIds = new Set<string>();
    const agentDir = this.options.getAgentDir();

    for (const workspace of workspaces) {
      retainedWorkspaceIds.add(workspace.workspaceId);
      const sessionDir = defaultSessionDirForWorkspace(workspace.path, agentDir);
      const existing = this.targetsByWorkspaceId.get(workspace.workspaceId);
      if (existing && existing.workspacePath === workspace.path && existing.sessionDir === sessionDir) {
        existing.displayName = workspace.displayName;
        continue;
      }

      if (existing) {
        this.disposeTarget(existing);
      }

      const target: WatchTarget = {
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.path,
        displayName: workspace.displayName,
        sessionDir,
        watcher: undefined,
        pollTimer: undefined,
        fingerprint: undefined,
        pollErrorReported: false,
        disposed: false,
        suppressedUntil: 0,
        suppressMaxTimer: undefined,
      };
      this.targetsByWorkspaceId.set(workspace.workspaceId, target);
      void this.startTarget(target);
    }

    for (const [workspaceId, target] of this.targetsByWorkspaceId) {
      if (!retainedWorkspaceIds.has(workspaceId)) {
        this.targetsByWorkspaceId.delete(workspaceId);
        this.disposeTarget(target);
      }
    }
  }

  dispose(): void {
    for (const timer of this.syncTimersByWorkspaceId.values()) {
      clearTimeout(timer);
    }
    this.syncTimersByWorkspaceId.clear();

    for (const target of this.targetsByWorkspaceId.values()) {
      this.disposeTarget(target);
    }
    this.targetsByWorkspaceId.clear();
  }

  private async startTarget(target: WatchTarget): Promise<void> {
    try {
      await mkdir(target.sessionDir, { recursive: true });
      target.fingerprint = await readSessionDirectoryFingerprint(target.sessionDir);
    } catch (error) {
      this.startPolling(target, error);
      return;
    }

    if (target.disposed || this.targetsByWorkspaceId.get(target.workspaceId) !== target) {
      return;
    }

    try {
      const watcher = watch(target.sessionDir, { persistent: false }, (_eventType, fileName) => {
        if (!isSessionFileName(fileName)) {
          return;
        }
        this.scheduleWorkspaceSync(target.workspaceId);
      });
      watcher.on("error", (error) => {
        this.startPolling(target, error);
      });
      target.watcher = watcher;
    } catch (error) {
      this.startPolling(target, error);
    }
  }

  private startPolling(target: WatchTarget, cause: unknown): void {
    if (target.disposed || this.targetsByWorkspaceId.get(target.workspaceId) !== target) {
      return;
    }

    target.watcher?.close();
    target.watcher = undefined;

    if (!target.pollTimer) {
      console.warn(
        `[pi-gui] Falling back to polling pi session files for ${target.displayName ?? target.workspacePath}: ${formatError(cause)}`,
      );
      const pollTimer = setInterval(() => {
        void this.pollTarget(target);
      }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      pollTimer.unref?.();
      target.pollTimer = pollTimer;
      void this.pollTarget(target);
    }
  }

  private async pollTarget(target: WatchTarget): Promise<void> {
    if (target.disposed || this.targetsByWorkspaceId.get(target.workspaceId) !== target) {
      return;
    }

    try {
      await mkdir(target.sessionDir, { recursive: true });
      const nextFingerprint = await readSessionDirectoryFingerprint(target.sessionDir);
      const previousFingerprint = target.fingerprint;
      target.fingerprint = nextFingerprint;
      target.pollErrorReported = false;
      if (previousFingerprint !== undefined && previousFingerprint !== nextFingerprint) {
        this.scheduleWorkspaceSync(target.workspaceId);
      }
    } catch (error) {
      if (!target.pollErrorReported) {
        target.pollErrorReported = true;
        console.warn(
          `[pi-gui] Unable to poll pi session files for ${target.displayName ?? target.workspacePath}: ${formatError(error)}`,
        );
      }
    }
  }

  /**
   * Suppress file-change-triggered syncs for a workspace.
   *
   * When an agent is actively running, the main process already receives
   * session events directly from the driver subscription — it does not need
   * the file watcher to tell it about `.jsonl` changes.  Suppressing the
   * watcher prevents the I/O sync storm that occurs when multiple agents
   * concurrently append to their session files.
   *
   * A safety-net timer guarantees that suppression is lifted after
   * `maxSuppressMs` (default 30 s) even if `releaseWorkspaceId` is never
   * called (e.g. the agent crashes).
   */
  suppressWorkspaceId(workspaceId: string): void {
    const target = this.targetsByWorkspaceId.get(workspaceId);
    if (!target || target.disposed) {
      return;
    }
    const maxSuppressMs = this.options.maxSuppressMs ?? DEFAULT_MAX_SUPPRESS_MS;
    target.suppressedUntil = Date.now() + maxSuppressMs;
    if (target.suppressMaxTimer) {
      clearTimeout(target.suppressMaxTimer);
    }
    target.suppressMaxTimer = setTimeout(() => {
      target.suppressMaxTimer = undefined;
      // Force-release: clear suppression and trigger one sync.
      target.suppressedUntil = 0;
      this.scheduleWorkspaceSync(workspaceId);
    }, maxSuppressMs);
    target.suppressMaxTimer.unref?.();
  }

  /**
   * Release suppression for a workspace and immediately trigger one sync
   * to pick up any file changes that occurred during the silent period.
   */
  releaseWorkspaceId(workspaceId: string): void {
    const target = this.targetsByWorkspaceId.get(workspaceId);
    if (!target || target.disposed) {
      return;
    }
    target.suppressedUntil = 0;
    if (target.suppressMaxTimer) {
      clearTimeout(target.suppressMaxTimer);
      target.suppressMaxTimer = undefined;
    }
    // Trigger one sync to catch up on changes that happened during suppression.
    this.scheduleWorkspaceSync(workspaceId);
  }

  private scheduleWorkspaceSync(workspaceId: string): void {
    const target = this.targetsByWorkspaceId.get(workspaceId);
    if (!target || target.disposed) {
      return;
    }

    // Skip sync while the workspace is suppressed (agent is running).
    if (target.suppressedUntil > 0 && Date.now() < target.suppressedUntil) {
      return;
    }
    // Suppression expired — clear it so future events proceed normally.
    if (target.suppressedUntil > 0) {
      target.suppressedUntil = 0;
      if (target.suppressMaxTimer) {
        clearTimeout(target.suppressMaxTimer);
        target.suppressMaxTimer = undefined;
      }
    }

    const existingTimer = this.syncTimersByWorkspaceId.get(workspaceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.syncTimersByWorkspaceId.delete(workspaceId);
      this.enqueueWorkspaceSync(workspaceId);
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    timer.unref?.();
    this.syncTimersByWorkspaceId.set(workspaceId, timer);
  }

  private enqueueWorkspaceSync(workspaceId: string): void {
    const previous = this.syncQueuesByWorkspaceId.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const target = this.targetsByWorkspaceId.get(workspaceId);
        if (!target || target.disposed) {
          return;
        }
        await this.options.onWorkspaceSessionsChanged(workspaceId);
        target.fingerprint = await readSessionDirectoryFingerprint(target.sessionDir);
      })
      .catch((error) => {
        console.warn(`[pi-gui] Unable to sync pi session files: ${formatError(error)}`);
      });

    const tracked = next.finally(() => {
      if (this.syncQueuesByWorkspaceId.get(workspaceId) === tracked) {
        this.syncQueuesByWorkspaceId.delete(workspaceId);
      }
    });
    this.syncQueuesByWorkspaceId.set(workspaceId, tracked);
  }

  private disposeTarget(target: WatchTarget): void {
    target.disposed = true;
    target.watcher?.close();
    target.watcher = undefined;
    if (target.pollTimer) {
      clearInterval(target.pollTimer);
      target.pollTimer = undefined;
    }
    if (target.suppressMaxTimer) {
      clearTimeout(target.suppressMaxTimer);
      target.suppressMaxTimer = undefined;
    }
    target.suppressedUntil = 0;
  }
}

export function defaultSessionDirForWorkspace(workspacePath: string, agentDir: string): string {
  const cwd = resolve(workspacePath);
  const resolvedAgentDir = agentDir.trim() || join(homedir(), ".pi", "agent");
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "sessions", safePath);
}

async function readSessionDirectoryFingerprint(sessionDir: string): Promise<string> {
  const entries = await readdir(sessionDir);
  const sessionFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const parts = await Promise.all(
    sessionFiles.map(async (entry) => {
      const filePath = join(sessionDir, entry);
      const stats = await stat(filePath);
      return `${entry}:${stats.size}:${stats.mtimeMs}`;
    }),
  );
  return parts.join("\n");
}

function isSessionFileName(fileName: string | Buffer | null): boolean {
  return fileName === null || fileName.toString().endsWith(".jsonl");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
