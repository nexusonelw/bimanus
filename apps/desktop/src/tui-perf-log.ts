export const TUI_PERF_LOG_PREFIX = "[PI-GUI-TUI-PERF]";

export interface TuiPerfLogContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly terminalId?: string;
  readonly traceId?: string;
}

type TuiPerfDetails = Record<string, unknown>;

const traceStarts = new Map<string, number>();
let nextTraceSequence = 1;

export function createTuiPerfTraceId(workspaceId: string | undefined, sessionId: string | undefined): string {
  return [
    sanitizeTracePart(workspaceId || "workspace"),
    sanitizeTracePart(sessionId || "new-session"),
    Date.now().toString(36),
    nextTraceSequence++,
  ].join(":");
}

export function logTuiPerf(
  phase: string,
  context: TuiPerfLogContext = {},
  details: TuiPerfDetails = {},
): void {
  const now = nowMs();
  const traceKey = context.traceId || `${context.workspaceId || "unknown"}:${context.sessionId || "unknown"}`;
  const start = traceStarts.get(traceKey) ?? now;
  traceStarts.set(traceKey, start);

  const payload = {
    phase,
    ts: new Date().toISOString(),
    elapsedMs: Math.round(now - start),
    workspaceId: context.workspaceId || "",
    sessionId: context.sessionId || "",
    terminalId: context.terminalId || "",
    traceId: context.traceId || "",
    details,
  };

  console.log(`${TUI_PERF_LOG_PREFIX} ${JSON.stringify(payload)}`);
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function sanitizeTracePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}
