import type { SessionCatalogEntry, WorkspaceCatalogEntry, WorktreeCatalogEntry } from "@bimanus/catalogs";
import { sessionKey } from "@bimanus/pi-sdk-driver";
import type { SessionConfig, SessionRef } from "@bimanus/session-driver";
import type {
  SessionRecord,
  WorktreeRecord,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "../src/desktop-state";

const REMOTE_AGENT_SESSION_ID_PREFIX = "pi-gui-remote-";

export function isRemoteAgentSessionId(sessionId: string | undefined): boolean {
  return sessionId?.startsWith(REMOTE_AGENT_SESSION_ID_PREFIX) ?? false;
}

export function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  return Object.fromEntries(map.entries());
}

export function buildWorkspaceRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  worktrees: readonly WorktreeCatalogEntry[],
  sessions: readonly SessionCatalogEntry[],
  runningSinceBySession: Map<string, string>,
  sessionConfigBySession: Map<string, SessionConfig>,
  lastViewedAtBySession: Map<string, string>,
): WorkspaceRecord[] {
  const workspaceRoots = resolveWorkspaceRoots(workspaces, worktrees);

  return workspaces.map((workspace) => {
    const rootWorkspaceId = workspaceRoots.get(workspace.workspaceId);

    return {
      id: workspace.workspaceId,
      name: workspace.displayName,
      path: workspace.path,
      lastOpenedAt: workspace.lastOpenedAt,
      kind: rootWorkspaceId ? "worktree" : "primary",
      ...(rootWorkspaceId
        ? {
            rootWorkspaceId,
            branchName: linkedWorktreeBranchName(workspace, worktrees, rootWorkspaceId),
          }
        : {}),
      sessions: sessions
        .filter((session) => session.workspaceId === workspace.workspaceId)
        .map((session) =>
          buildSessionRecord(
            session,
            runningSinceBySession,
            sessionConfigBySession,
            lastViewedAtBySession,
          ),
        ),
    };
  });
}

export function buildWorktreeRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  worktrees: readonly WorktreeCatalogEntry[],
): Record<string, readonly WorktreeRecord[]> {
  const workspaceRoots = resolveWorkspaceRoots(workspaces, worktrees);
  const linkedWorkspaceIdsByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace.workspaceId] as const));
  const groups = new Map<string, WorktreeRecord[]>();

  for (const worktree of worktrees) {
    if (worktree.kind !== "linked") {
      continue;
    }
    const linkedWorkspaceId = linkedWorkspaceIdsByPath.get(worktree.path);
    const resolvedRootWorkspaceId = linkedWorkspaceId ? workspaceRoots.get(linkedWorkspaceId) : undefined;
    if (linkedWorkspaceId) {
      if (!resolvedRootWorkspaceId || resolvedRootWorkspaceId !== worktree.workspaceId) {
        continue;
      }
    }
    const entry: WorktreeRecord = {
      id: worktree.worktreeId,
      rootWorkspaceId: resolvedRootWorkspaceId ?? worktree.workspaceId,
      linkedWorkspaceId,
      name: worktree.displayName,
      path: worktree.path,
      status: worktree.status,
      branchName: worktree.branchName,
      updatedAt: worktree.updatedAt,
    };
    const existing = groups.get(worktree.workspaceId);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(worktree.workspaceId, [entry]);
    }
  }

  for (const entries of groups.values()) {
    entries.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.name.localeCompare(right.name);
    });
  }

  return mapToRecord(groups);
}

function resolveWorkspaceRoots(
  workspaces: readonly WorkspaceCatalogEntry[],
  worktrees: readonly WorktreeCatalogEntry[],
): Map<string, string | undefined> {
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace] as const));
  const linkedEntriesByPath = new Map<string, WorktreeCatalogEntry[]>();
  for (const worktree of worktrees) {
    if (worktree.kind !== "linked") {
      continue;
    }
    const existing = linkedEntriesByPath.get(worktree.path);
    if (existing) {
      existing.push(worktree);
    } else {
      linkedEntriesByPath.set(worktree.path, [worktree]);
    }
  }

  const candidateRootByWorkspaceId = new Map<string, string | undefined>();
  for (const workspace of workspaces) {
    const candidates = (linkedEntriesByPath.get(workspace.path) ?? []).filter(
      (worktree) => worktree.workspaceId !== workspace.workspaceId,
    );
    const owner = pickPreferredWorkspaceId(
      candidates.map((candidate) => candidate.workspaceId),
      workspacesById,
    );
    candidateRootByWorkspaceId.set(workspace.workspaceId, owner);
  }

  const resolvedRoots = new Map<string, string | undefined>();
  for (const workspace of workspaces) {
    const candidateRootId = candidateRootByWorkspaceId.get(workspace.workspaceId);
    if (!candidateRootId) {
      resolvedRoots.set(workspace.workspaceId, undefined);
      continue;
    }
    const reciprocalRootId = candidateRootByWorkspaceId.get(candidateRootId);
    if (reciprocalRootId === workspace.workspaceId) {
      const primaryId = pickPreferredWorkspaceId([workspace.workspaceId, candidateRootId], workspacesById);
      resolvedRoots.set(workspace.workspaceId, primaryId === workspace.workspaceId ? undefined : primaryId);
      continue;
    }
    resolvedRoots.set(workspace.workspaceId, candidateRootId);
  }

  return resolvedRoots;
}

function pickPreferredWorkspaceId(
  workspaceIds: readonly string[],
  workspacesById: ReadonlyMap<string, WorkspaceCatalogEntry>,
): string | undefined {
  return [...workspaceIds]
    .filter((workspaceId, index, values) => values.indexOf(workspaceId) === index)
    .sort((left, right) => {
      const leftWorkspace = workspacesById.get(left);
      const rightWorkspace = workspacesById.get(right);
      const leftSortOrder = leftWorkspace?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightSortOrder = rightWorkspace?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftSortOrder !== rightSortOrder) {
        return leftSortOrder - rightSortOrder;
      }
      const leftLastOpenedAt = leftWorkspace?.lastOpenedAt ?? "";
      const rightLastOpenedAt = rightWorkspace?.lastOpenedAt ?? "";
      if (leftLastOpenedAt !== rightLastOpenedAt) {
        return leftLastOpenedAt.localeCompare(rightLastOpenedAt);
      }
      const leftPath = workspacesById.get(left)?.path ?? left;
      const rightPath = workspacesById.get(right)?.path ?? right;
      if (leftPath.length !== rightPath.length) {
        return leftPath.length - rightPath.length;
      }
      return leftPath.localeCompare(rightPath);
    })[0];
}

function linkedWorktreeBranchName(
  workspace: WorkspaceCatalogEntry,
  worktrees: readonly WorktreeCatalogEntry[],
  rootWorkspaceId: string,
): string | undefined {
  return worktrees.find(
    (worktree) =>
      worktree.kind === "linked" &&
      worktree.path === workspace.path &&
      worktree.workspaceId === rootWorkspaceId,
  )?.branchName;
}

function buildSessionRecord(
  session: SessionCatalogEntry,
  runningSinceBySession: Map<string, string>,
  sessionConfigBySession: Map<string, SessionConfig>,
  lastViewedAtBySession: Map<string, string>,
): SessionRecord {
  const key = sessionKey(session.sessionRef);
  const preview = session.previewSnippet ?? session.title;
  const lastViewedAt = lastViewedAtBySession.get(key);
  return {
    id: session.sessionRef.sessionId,
    title: session.title,
    updatedAt: session.updatedAt,
    lastViewedAt,
    archivedAt: session.archivedAt,
    preview,
    status: session.status,
    runningSince: runningSinceBySession.get(key),
    hasUnseenUpdate: hasUnseenSessionUpdate(session.status, session.updatedAt, lastViewedAt),
    config: sessionConfigBySession.get(key),
  };
}

export function hasUnseenSessionUpdate(
  status: "idle" | "running" | "failed",
  updatedAt: string,
  lastViewedAt: string | undefined,
): boolean {
  if (status === "running" || !lastViewedAt) {
    return false;
  }

  return updatedAt > lastViewedAt;
}

export function toSessionRef(target: WorkspaceSessionTarget): SessionRef {
  return {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
  };
}
