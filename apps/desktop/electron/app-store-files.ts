import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDirectoryEntry, WorkspaceFileContent, WorkspaceFileKind, WorkspaceFileWriteResult } from "../src/ipc";

const fileCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;

// Preview/edit content limits. Text is read fully up to this size and
// truncated beyond it (Monaco can still open large-ish files); binary
// media (image/video) is base64-encoded, which is ~33% larger than the
// source, so we cap the raw file size read into memory accordingly.
const MAX_TEXT_PREVIEW_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_MEDIA_PREVIEW_BYTES = 25 * 1024 * 1024; // 25 MB

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".html": "text/html",
  ".htm": "text/html",
};

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".zip", ".gz", ".tar", ".7z", ".rar", ".pdf", ".exe", ".dll", ".so", ".dylib",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".class", ".jar", ".wasm", ".db",
  ".sqlite", ".psd", ".ai", ".sketch",
]);

function resolveWorkspaceFilePath(workspacePath: string, relativePath: string): string | null {
  const rootPath = path.resolve(workspacePath);
  const filePath = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, filePath);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return null;
  }
  return filePath;
}

function classifyByExtension(filePath: string): { kind: WorkspaceFileKind; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  const mimeFromExt = EXTENSION_MIME_TYPES[ext];
  if (mimeFromExt?.startsWith("image/")) {
    return { kind: "image", mimeType: mimeFromExt };
  }
  if (mimeFromExt?.startsWith("video/")) {
    return { kind: "video", mimeType: mimeFromExt };
  }
  if (ext === ".html" || ext === ".htm") {
    return { kind: "html", mimeType: "text/html" };
  }
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return { kind: "binary", mimeType: "application/octet-stream" };
  }
  // Unknown/plain-text extensions default to "text" — any text content is
  // opened in Monaco per product requirements. Actual binary-ness is still
  // double-checked below via a NUL-byte sniff before we commit to "text".
  return { kind: "text", mimeType: "text/plain" };
}

function looksLikeBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export async function readWorkspaceFile(
  workspacePath: string,
  relativePath: string,
): Promise<WorkspaceFileContent> {
  const filePath = resolveWorkspaceFilePath(workspacePath, relativePath);
  if (!filePath) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }

  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  const classification = classifyByExtension(filePath);

  if (classification.kind === "image" || classification.kind === "video") {
    const truncated = stats.size > MAX_MEDIA_PREVIEW_BYTES;
    if (truncated) {
      return {
        path: relativePath,
        kind: "binary",
        mimeType: classification.mimeType,
        size: stats.size,
        truncated: true,
      };
    }
    const buffer = await readFile(filePath);
    return {
      path: relativePath,
      kind: classification.kind,
      mimeType: classification.mimeType,
      size: stats.size,
      dataUrl: `data:${classification.mimeType};base64,${buffer.toString("base64")}`,
    };
  }

  if (classification.kind === "binary") {
    return {
      path: relativePath,
      kind: "binary",
      mimeType: classification.mimeType,
      size: stats.size,
    };
  }

  // "text" or "html": read as UTF-8, sniffing a prefix first to rule out
  // files that merely lack a recognized extension but are actually binary.
  const truncated = stats.size > MAX_TEXT_PREVIEW_BYTES;
  const buffer = truncated
    ? Buffer.from((await readFile(filePath)).subarray(0, MAX_TEXT_PREVIEW_BYTES))
    : await readFile(filePath);

  if (looksLikeBinaryBuffer(buffer)) {
    return {
      path: relativePath,
      kind: "binary",
      mimeType: "application/octet-stream",
      size: stats.size,
    };
  }

  return {
    path: relativePath,
    kind: classification.kind,
    mimeType: classification.mimeType === "text/plain" ? "text/plain" : classification.mimeType,
    size: stats.size,
    content: buffer.toString("utf8"),
    truncated,
  };
}

export async function writeWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  content: string,
): Promise<WorkspaceFileWriteResult> {
  const filePath = resolveWorkspaceFilePath(workspacePath, relativePath);
  if (!filePath) {
    return { saved: false, error: `Path escapes workspace: ${relativePath}` };
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return { saved: true };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listWorkspaceDirectory(
  workspacePath: string,
  relativePath = "",
): Promise<readonly WorkspaceDirectoryEntry[]> {
  const rootPath = path.resolve(workspacePath);
  const directoryPath = path.resolve(rootPath, relativePath || ".");
  const relativeDirectoryPath = path.relative(rootPath, directoryPath);
  if (
    relativeDirectoryPath.startsWith(`..${path.sep}`) ||
    relativeDirectoryPath === ".." ||
    path.isAbsolute(relativeDirectoryPath)
  ) {
    return [];
  }

  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.map((entry): WorkspaceDirectoryEntry => ({
        name: entry.name,
        path: path.relative(rootPath, path.join(directoryPath, entry.name)).split(path.sep).join("/"),
        kind: entry.isDirectory() ? "directory" : "file",
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      });
  } catch {
    return [];
  }
}

export function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const cached = fileCache.get(workspacePath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.files);
  }

  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const files = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort();
        if (fileCache.size >= CACHE_MAX_ENTRIES) {
          const oldest = fileCache.keys().next().value;
          if (oldest !== undefined) {
            fileCache.delete(oldest);
          }
        }
        fileCache.set(workspacePath, { files, timestamp: Date.now() });
        resolve(files);
      },
    );
  });
}
