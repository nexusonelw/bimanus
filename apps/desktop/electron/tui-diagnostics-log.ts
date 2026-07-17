import { accessSync, appendFileSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";

type TuiDiagnosticDetails = Record<string, unknown>;

let diagnosticsLogPath: string | undefined;
let diagnosticsWriteFailed = false;
let logStream: WriteStream | null = null;
const logQueue: string[] = [];
let flushScheduled = false;

const MAX_STRING_LENGTH = 32_000;
const MAX_ARRAY_LENGTH = 250;
const MAX_OBJECT_KEYS = 250;
const SENSITIVE_ENV_PATTERN = /(api[_-]?key|token|secret|password|passwd|credential|cookie|authorization|auth[_-]?socket)/i;

export function configureTuiDiagnosticsLog(filePath: string): void {
  diagnosticsLogPath = filePath;
  diagnosticsWriteFailed = false;
  writeTuiDiagnosticLog("main.tuiDiagnostics.configured", {
    logPath: diagnosticsLogPath,
  });
}

export function getTuiDiagnosticsLogPath(): string | undefined {
  return diagnosticsLogPath;
}

function ensureLogStream(): WriteStream | null {
  if (logStream) return logStream;
  if (!diagnosticsLogPath || diagnosticsWriteFailed) return null;
  try {
    mkdirSync(path.dirname(diagnosticsLogPath), { recursive: true });
  } catch {
    diagnosticsWriteFailed = true;
    return null;
  }
  logStream = createWriteStream(diagnosticsLogPath, { flags: "a", encoding: "utf8" });
  logStream.on("error", () => {
    logStream = null;
  });
  process.on("beforeExit", () => {
    if (logQueue.length > 0 && logStream) {
      logStream.write(logQueue.join(""));
      logQueue.length = 0;
    }
  });
  return logStream;
}

export function writeTuiDiagnosticLog(phase: string, details: TuiDiagnosticDetails = {}): void {
  const stream = ensureLogStream();
  if (!stream) return;

  const entry = JSON.stringify(toSerializable({
    ts: new Date().toISOString(),
    pid: process.pid,
    phase,
    details,
  })) + "\n";
  logQueue.push(entry);

  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      if (logQueue.length === 0) return;
      const batch = logQueue.join("");
      logQueue.length = 0;
      stream.write(batch);
    });
  }
}

export function describeFilesystemPath(filePath: string | undefined): TuiDiagnosticDetails {
  if (!filePath) {
    return { path: "", exists: false, error: "empty path" };
  }
  try {
    const stats = statSync(filePath);
    return {
      path: filePath,
      exists: true,
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      mode: stats.mode.toString(8),
      mtime: stats.mtime.toISOString(),
      realpath: realpathSync.native(filePath),
    };
  } catch (error) {
    return {
      path: filePath,
      exists: existsSync(filePath),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeDirectory(directoryPath: string | undefined): TuiDiagnosticDetails {
  if (!directoryPath) {
    return { path: "", exists: false, error: "empty path" };
  }
  const pathInfo = describeFilesystemPath(directoryPath);
  if (pathInfo.exists !== true) {
    return pathInfo;
  }
  try {
    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .slice(0, 200)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
    return { ...pathInfo, entries };
  } catch (error) {
    return {
      ...pathInfo,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeAccess(filePath: string | undefined): TuiDiagnosticDetails {
  if (!filePath) {
    return { path: "", exists: false, readable: false, executable: false };
  }
  const accessInfo: TuiDiagnosticDetails = {
    ...describeFilesystemPath(filePath),
    readable: false,
    executable: false,
  };
  try {
    accessSync(filePath, constants.R_OK);
    accessInfo.readable = true;
  } catch {
    accessInfo.readable = false;
  }
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    accessInfo.executable = true;
  } catch {
    accessInfo.executable = false;
  }
  return accessInfo;
}

export function sanitizeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (typeof value !== "string") {
      continue;
    }
    sanitized[key] = SENSITIVE_ENV_PATTERN.test(key) ? `<redacted:${value.length} chars>` : value;
  }
  return sanitized;
}

export function sanitizeError(error: unknown): TuiDiagnosticDetails {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

export function truncateForLog(value: string, maxLength = MAX_STRING_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function toSerializable(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateForLog(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Error) {
    return sanitizeError(value);
  }
  if (depth > 8) {
    return "[max-depth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => toSerializable(entry, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = toSerializable((value as Record<string, unknown>)[key], seen, depth + 1);
    }
    return output;
  }
  return String(value);
}
