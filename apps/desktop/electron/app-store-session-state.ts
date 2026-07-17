import { sessionKey } from "@bimanus/pi-sdk-driver";
import type { SessionDriverEvent, SessionSnapshot } from "@bimanus/session-driver";
import type { DesktopAppState, SessionRecord } from "../src/desktop-state";
import { hasUnseenSessionUpdate } from "./app-store-utils";

export function applySessionEventState(
  state: DesktopAppState,
  event: SessionDriverEvent,
  runningSinceBySession: Map<string, string>,
  lastViewedAtBySession: Map<string, string>,
): DesktopAppState {
  const key = sessionKey(event.sessionRef);
  const lastViewedAt = lastViewedAtBySession.get(key);

  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === event.sessionRef.workspaceId
        ? {
            ...workspace,
            sessions: workspace.sessions.map((session) =>
              session.id === event.sessionRef.sessionId
                ? updateSessionRecord(session, {
                    snapshot: snapshotForEvent(event),
                    status: statusForEvent(session.status, event),
                    runningSince: runningSinceBySession.get(key),
                    lastViewedAt,
                  })
                : session,
            ),
          }
        : workspace,
    ),
    revision: state.revision + 1,
  };
}

export function updateSessionRecord(
  session: SessionRecord,
  options: {
    readonly snapshot?: Partial<
      Pick<SessionSnapshot, "title" | "updatedAt" | "archivedAt" | "preview" | "status" | "config">
    >;
    readonly status?: SessionRecord["status"];
    readonly runningSince: string | undefined;
    readonly lastViewedAt: string | undefined;
  },
): SessionRecord {
  const updatedAt = options.snapshot?.updatedAt ?? session.updatedAt;
  const nextStatus = options.status ?? options.snapshot?.status ?? session.status;
  return {
    ...session,
    title: options.snapshot?.title ?? session.title,
    updatedAt,
    lastViewedAt: options.lastViewedAt,
    archivedAt: options.snapshot?.archivedAt ?? session.archivedAt,
    preview: options.snapshot?.preview ?? session.preview,
    status: nextStatus,
    runningSince: options.runningSince,
    hasUnseenUpdate: hasUnseenSessionUpdate(nextStatus, updatedAt, options.lastViewedAt),
    config: options.snapshot?.config ?? session.config,
  };
}

function snapshotForEvent(event: SessionDriverEvent) {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      return event.snapshot;
    default:
      return undefined;
  }
}

function statusForEvent(sessionStatus: SessionRecord["status"], event: SessionDriverEvent): SessionRecord["status"] {
  switch (event.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted":
      return event.snapshot.status;
    case "runFailed":
      return "failed";
    case "sessionClosed":
      return "idle";
    default:
      return sessionStatus;
  }
}
