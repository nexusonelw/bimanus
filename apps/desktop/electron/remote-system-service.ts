import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Minimatch } from "minimatch";

const require = createRequire(__filename);

const MAX_OUTPUT_CHARS = 5_000;
const OUTPUT_TRUNCATED_NOTICE = "\n… 后续内容超过5000字符，已省略。";
const MAX_SCANNED_LINE_CHARS = 64 * 1024;
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
const MAX_IMPORT_CHUNK_BYTES = 1024 * 1024;
const PI_GUI_RIPGREP_PATH_ENV = "PI_GUI_RIPGREP_PATH";

type ShellTask = {
  readonly clientId: string;
  readonly child: ChildProcess;
  output: string;
  truncated: boolean;
  status: "running" | "completed" | "killed";
  exitCode: number | null;
  resolveExit: () => void;
  readonly exited: Promise<void>;
};

type FileEntry = { name: string; path: string; isDirectory: boolean; size: number };

export class RemoteSystemService {
  private readonly osCheckedClients = new Set<string>();
  private readonly shellTasks = new Map<string, ShellTask>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  clientConnected(clientId: string): void {
    const timer = this.disconnectTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(clientId);
    this.osCheckedClients.add(clientId);
  }

  getOperatingSystem(clientId: string) {
    this.osCheckedClients.add(clientId);
    return {
      platform: process.platform,
      operatingSystem: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
      release: os.release(),
      arch: process.arch,
    };
  }

  async invokeFile(clientId: string, operation: string, rawInput: unknown) {
    try {
      this.assertOsChecked(clientId);
      const input = asObject(rawInput);
      const targetPath = operation === "write-file"
        ? await resolveWritableTarget(input.path)
        : await resolveTarget(input.path);

      switch (operation) {
      case "get-directory-tree": {
        const budget = createOutputBudget();
        const excludedGlobs = globList(input.exclude, "exclude");
        const result = {
          path: targetPath,
          tree: await readTree(
            targetPath,
            targetPath,
            numberAtLeast(input.depth, 0, Number.MAX_SAFE_INTEGER),
            budget,
            excludedGlobs,
          ),
        };
        return limitResult(result, budget.truncated);
      }
      case "read-file": {
        const file = await readTextPrefix(targetPath);
        const result = { path: targetPath, content: file.content };
        return limitResult(result, file.truncated);
      }
      case "get-import-files-metadata":
        return collectImportFilesMetadata(input.paths);
      case "read-import-file-chunk": {
        const offset = numberAtLeast(input.offset, 0, 0);
        const length = Math.min(MAX_IMPORT_CHUNK_BYTES, numberAtLeast(input.length, 1, MAX_IMPORT_CHUNK_BYTES));
        const file = await open(targetPath, "r");
        try {
          const stats = await file.stat();
          if (!stats.isFile()) throw new Error(`Remote import path is not a file: ${targetPath}`);
          const buffer = Buffer.alloc(Math.min(length, Math.max(0, stats.size - offset)));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          return {
            path: targetPath,
            offset,
            bytesRead,
            content: buffer.subarray(0, bytesRead).toString("base64"),
            eof: offset + bytesRead >= stats.size,
          };
        } finally {
          await file.close();
        }
      }
      case "read-file-lines": {
        const lineNum = numberAtLeast(input.lineNum, 1, 1);
        const offset = typeof input.offset === "number" && Number.isFinite(input.offset) ? Math.trunc(input.offset) : 0;
        let start: number;
        let end: number;
        if (offset >= 0) {
          start = lineNum;
          end = lineNum + (offset === 0 ? 0 : offset - 1);
        } else {
          end = lineNum;
          start = Math.max(1, lineNum + offset + 1);
        }
        const lines: string[] = [];
        let outputChars = 0;
        let truncated = false;
        await scanFileLines(targetPath, (text, lineNumber) => {
          if (lineNumber < start) return true;
          if (lineNumber > end) return false;
          const line = `${lineNumber}|${text}`;
          const nextChars = line.length + 1;
          if (outputChars + nextChars > MAX_OUTPUT_CHARS) {
            truncated = true;
            return false;
          }
          lines.push(line);
          outputChars += nextChars;
          return true;
        });
        const result = { path: targetPath, lineNum, offset, content: lines.join("\n") };
        return limitResult(result, truncated);
      }
      case "find-files": {
        const found = await findFiles(targetPath, input);
        return limitResult(found.result, found.truncated);
      }
      case "grep-files": {
        const found = await grepFiles(targetPath, input);
        return limitResult(found.result, found.truncated);
      }
      case "write-file": {
        if (typeof input.content !== "string") throw new Error("'content' is required and must be a string.");
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, input.content, "utf8");
        return { path: targetPath, saved: true, message: "File written successfully." };
      }
      case "replace-in-file": {
        if (typeof input.search !== "string" || !input.search) throw new Error("'search' is required and must not be empty.");
        if (typeof input.replace !== "string") throw new Error("'replace' is required and must be a string.");
        const content = await readFile(targetPath, "utf8");
        const replaceAll = input.replaceAll === true;
        let replaced = 0;
        let nextContent = content;
        if (input.useRegex === true) {
          const regex = new RegExp(input.search, replaceAll ? "g" : "");
          replaced = replaceAll ? (content.match(regex)?.length ?? 0) : (regex.test(content) ? 1 : 0);
          if (replaced > 0) nextContent = content.replace(regex, () => input.replace as string);
        } else {
          const occurrences = content.split(input.search).length - 1;
          replaced = replaceAll ? occurrences : Math.min(occurrences, 1);
          if (replaced > 0) {
            nextContent = replaceAll
              ? content.split(input.search).join(input.replace)
              : content.replace(input.search, () => input.replace as string);
          }
        }
        if (replaced === 0) {
          return { path: targetPath, saved: false, replaced: 0, error: "Search string not found in target file." };
        }
        await writeFile(targetPath, nextContent, "utf8");
        return { path: targetPath, saved: true, replaced, message: `Successfully replaced ${replaced} occurrence(s).` };
      }
      default:
        throw new Error(`Unsupported remote file operation: ${operation}`);
      }
    } catch (error) {
      if (operation !== "write-file" && operation !== "replace-in-file") throw error;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async executeShell(clientId: string, rawInput: unknown) {
    this.assertOsChecked(clientId);
    const input = asObject(rawInput);
    const cwd = await resolveRoot(input.cwd, "cwd");
    const command = requiredString(input.command, "command");
    const taskId = crypto.randomUUID();
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolveExit!: () => void;
    const task: ShellTask = {
      clientId,
      child,
      output: "",
      truncated: false,
      status: "running",
      exitCode: null,
      resolveExit: () => resolveExit(),
      exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
    };
    this.shellTasks.set(taskId, task);
    const append = (chunk: Buffer | string) => {
      const next = task.output + chunk.toString();
      if (next.length > MAX_OUTPUT_CHARS) task.truncated = true;
      if (task.output.length < MAX_OUTPUT_CHARS) task.output = next.slice(0, MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => append(`${error.message}\n`));
    child.once("exit", (code) => {
      task.exitCode = code;
      if (task.status === "running") task.status = "completed";
      task.resolveExit();
    });
    await waitForTask(task, numberAtLeast(input.waitMs, 0, 30_000));
    return shellTaskResult(taskId, task);
  }

  async getShellStatus(clientId: string, rawInput: unknown) {
    this.assertOsChecked(clientId);
    const input = asObject(rawInput);
    const taskId = requiredString(input.taskId, "taskId");
    const task = this.getTask(clientId, taskId);
    await waitForTask(task, numberAtLeast(input.waitMs, 0, 30_000));
    return shellTaskResult(taskId, task);
  }

  async killShell(clientId: string, rawInput: unknown) {
    this.assertOsChecked(clientId);
    const taskId = requiredString(asObject(rawInput).taskId, "taskId");
    const task = this.getTask(clientId, taskId);
    if (task.status === "running") {
      task.status = "killed";
      await killProcessTree(task.child);
    }
    return shellTaskResult(taskId, task);
  }

  disposeClient(clientId: string): void {
    const pending = this.disconnectTimers.get(clientId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(clientId);
      this.osCheckedClients.delete(clientId);
      for (const task of this.shellTasks.values()) {
        if (task.clientId === clientId && task.status === "running") void killProcessTree(task.child);
      }
    }, 30_000);
    timer.unref();
    this.disconnectTimers.set(clientId, timer);
  }

  dispose(): void {
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    for (const task of this.shellTasks.values()) {
      if (task.status === "running") void killProcessTree(task.child);
    }
    this.shellTasks.clear();
    this.osCheckedClients.clear();
  }

  private assertOsChecked(clientId: string): void {
    if (!this.osCheckedClients.has(clientId)) {
      throw new Error("Call get-operating-system before using remote filesystem or shell methods.");
    }
  }

  private getTask(clientId: string, taskId: string): ShellTask {
    const task = this.shellTasks.get(taskId);
    if (!task || task.clientId !== clientId) throw new Error(`Unknown shell task: ${taskId}`);
    return task;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote method input must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`'${name}' is required.`);
  return result;
}

function numberAtLeast(value: unknown, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

async function resolveRoot(value: unknown, name = "rootPath"): Promise<string> {
  const input = requiredString(value, name);
  if (!path.isAbsolute(input)) throw new Error("Remote root path must be absolute.");
  const rootPath = await realpath(input);
  if (!(await lstat(rootPath)).isDirectory()) throw new Error(`Remote root is not a directory: ${input}`);
  return rootPath;
}

async function resolveTarget(value: unknown): Promise<string> {
  const input = requiredString(value, "path");
  return realpath(path.resolve(input));
}

async function resolveWritableTarget(value: unknown): Promise<string> {
  const input = requiredString(value, "path");
  const requested = path.resolve(input);
  let ancestor = requested;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Writable path has no existing ancestor: ${input}`);
    ancestor = parent;
  }
  return path.resolve(await realpath(ancestor), path.relative(ancestor, requested));
}

function isHidden(targetPath: string, rootPath: string): boolean {
  return path.relative(rootPath, targetPath).split(path.sep).some((part) => part.startsWith("."));
}

async function collectImportFilesMetadata(value: unknown) {
  const requestedPaths = stringList(value, "paths");
  if (requestedPaths.length === 0) throw new Error("'paths' must contain at least one file or directory.");

  const files: Array<{ path: string; relativePath: string; size: number; md5: string }> = [];
  const seenSources = new Set<string>();
  const seenDestinations = new Map<string, string>();
  let totalSize = 0;

  const visit = async (sourcePath: string, relativePath: string): Promise<void> => {
    const stats = await lstat(sourcePath);
    if (stats.isDirectory()) {
      for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
        await visit(path.join(sourcePath, entry.name), path.posix.join(relativePath, entry.name));
      }
      return;
    }
    if (!stats.isFile() || seenSources.has(sourcePath)) return;
    seenSources.add(sourcePath);
    const previousSource = seenDestinations.get(relativePath);
    if (previousSource && previousSource !== sourcePath) {
      throw new Error(`Multiple remote files map to the same import path: ${relativePath}`);
    }
    seenDestinations.set(relativePath, sourcePath);
    totalSize += stats.size;
    if (totalSize > MAX_IMPORT_BYTES) {
      throw new Error(`Remote import exceeds the 500 MB limit (${totalSize} bytes).`);
    }
    files.push({ path: sourcePath, relativePath, size: stats.size, md5: await md5File(sourcePath) });
  };

  for (const requestedPath of requestedPaths) {
    const sourcePath = await resolveTarget(requestedPath);
    await visit(sourcePath, path.basename(sourcePath) || "root");
  }
  return { files, totalSize };
}

async function md5File(filePath: string) {
  const hash = createHash("md5");
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

async function listEntries(dirPath: string, rootPath: string): Promise<FileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => !isHidden(path.join(dirPath, entry.name), rootPath)).map(async (entry) => {
    const entryPath = path.join(dirPath, entry.name);
    const stats = await lstat(entryPath);
    return { name: entry.name, path: entryPath, isDirectory: entry.isDirectory(), size: stats.size };
  }));
}

type OutputBudget = { remaining: number; truncated: boolean };

function createOutputBudget(): OutputBudget {
  return { remaining: MAX_OUTPUT_CHARS - OUTPUT_TRUNCATED_NOTICE.length, truncated: false };
}

function consumeOutputBudget(budget: OutputBudget, value: unknown): boolean {
  const size = JSON.stringify(value).length;
  if (size > budget.remaining) {
    budget.truncated = true;
    return false;
  }
  budget.remaining -= size;
  return true;
}

async function readTree(
  dirPath: string,
  rootPath: string,
  depth: number,
  budget: OutputBudget,
  excludedGlobs: Minimatch[],
): Promise<unknown[]> {
  if (budget.truncated) return [];
  const entries = (await listEntries(dirPath, rootPath)).sort((a, b) => a.name.localeCompare(b.name));
  const tree: unknown[] = [];
  for (const entry of entries) {
    if (matchesAnyGlob(excludedGlobs, entry.name)) continue;
    if (!consumeOutputBudget(budget, entry)) break;
    tree.push({
      ...entry,
      ...(entry.isDirectory && depth > 0
        ? { children: await readTree(entry.path, rootPath, depth - 1, budget, excludedGlobs) }
        : {}),
    });
    if (budget.truncated) break;
  }
  return tree;
}

// ─── Ripgrep integration ─────────────────────────────────────────────

let cachedRipgrepPath: string | undefined | null = null;

function resolveRipgrepPath(): string | undefined {
  if (cachedRipgrepPath !== null) return cachedRipgrepPath;

  const configuredPath = process.env[PI_GUI_RIPGREP_PATH_ENV]?.trim();
  const candidates: string[] = [];
  if (configuredPath) candidates.push(configuredPath);

  // Try @vscode/ripgrep package (works on all platforms — no Windows restriction)
  try {
    const ripgrep = require("@vscode/ripgrep") as { readonly rgPath?: unknown };
    if (typeof ripgrep.rgPath === "string" && ripgrep.rgPath.trim()) {
      candidates.push(preferUnpackedAsarPath(ripgrep.rgPath.trim()));
    }
  } catch {
    // @vscode/ripgrep not available
  }

  // Try bundled unpacked ASAR paths (for production builds)
  const binName = process.platform === "win32" ? "rg.exe" : "rg";
  candidates.push(
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "node_modules", "@vscode", "ripgrep", "bin", binName),
  );

  cachedRipgrepPath = candidates.find((candidate) => candidate && existsSync(candidate));
  return cachedRipgrepPath;
}

function preferUnpackedAsarPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  const asarSep = `${path.sep}app.asar${path.sep}`;
  const asarEnd = `${path.sep}app.asar`;
  if (!normalized.includes(asarSep) && !normalized.endsWith(asarEnd)) {
    return filePath;
  }
  const unpackedPath = filePath.replace(asarSep, `${path.sep}app.asar.unpacked${path.sep}`);
  return existsSync(unpackedPath) ? unpackedPath : filePath;
}

async function runRipgrepStreaming(
  rgPath: string,
  args: string[],
  onLine: (line: string) => boolean,
): Promise<{ stderr: string; exitCode: number; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let buffer = "";
    let stopped = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped) return;
      buffer += chunk.toString("utf8");
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!onLine(line)) {
          stopped = true;
          try { child.kill("SIGKILL"); } catch { /* process may have exited */ }
          break;
        }
        newlineIdx = buffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      reject(new Error(`ripgrep process error: ${error.message}`));
    });

    child.once("exit", (code) => {
      if (!stopped && buffer) onLine(buffer);
      resolve({ stderr, exitCode: code ?? 0, killed: stopped });
    });
  });
}

function parseRipgrepSearchLine(line: string): { path: string; line: number; text: string } | null {
  // Format from rg --line-number --no-heading --with-filename --color never:
  //   /path/to/file:42:matching line text
  // The regex uses backtracking so paths containing colons (e.g. Windows drive letters) still work.
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (!match) return null;
  const [, filePath, lineNum, text] = match;
  const lineNumber = parseInt(lineNum, 10);
  if (!Number.isFinite(lineNumber)) return null;
  return { path: filePath, line: lineNumber, text };
}

async function findFiles(targetPath: string, input: Record<string, unknown>) {
  const pattern = typeof input.pattern === "string" && input.pattern.trim() ? input.pattern.trim() : undefined;
  const excludes = stringList(input.exclude, "exclude");
  const maxResults = numberAtLeast(input.maxResults, 1, Number.MAX_SAFE_INTEGER);

  const rgPath = resolveRipgrepPath();
  if (!rgPath) throw new Error("ripgrep binary not found. Cannot perform remote file search.");

  const args: string[] = ["--files"];
  if (pattern) args.push("--glob", pattern);
  for (const ex of excludes) args.push("--glob", `!${ex}`);
  args.push(targetPath);

  const results: Array<{ name: string; path: string }> = [];
  const budget = createOutputBudget();

  const { stderr, exitCode } = await runRipgrepStreaming(rgPath, args, (line) => {
    if (!line) return true;
    const filePath = line;
    const name = path.basename(filePath);
    const entry = { name, path: filePath };
    if (!consumeOutputBudget(budget, entry)) return false;
    results.push(entry);
    return results.length < maxResults && !budget.truncated;
  });

  if (exitCode === 2) {
    throw new Error(`ripgrep file listing failed: ${stderr.trim() || "unknown error"}`);
  }

  return {
    result: { path: targetPath, results },
    truncated: budget.truncated || results.length >= maxResults,
  };
}

async function grepFiles(targetPath: string, input: Record<string, unknown>) {
  const keyword = requiredString(input.keyword, "keyword");
  const isRegex = input.isRegex === true;
  const caseSensitive = input.caseSensitive === true;
  const includeGlob = typeof input.includeGlob === "string" && input.includeGlob.trim() ? input.includeGlob.trim() : undefined;
  const excludes = stringList(input.exclude, "exclude");
  const maxResults = numberAtLeast(input.maxResults, 1, Number.MAX_SAFE_INTEGER);

  const rgPath = resolveRipgrepPath();
  if (!rgPath) throw new Error("ripgrep binary not found. Cannot perform remote grep search.");

  const args: string[] = [
    "--line-number", "--no-heading", "--with-filename", "--color", "never",
  ];
  if (!isRegex) args.push("--fixed-strings");
  if (caseSensitive) args.push("--case-sensitive");
  if (includeGlob) args.push("--glob", includeGlob);
  for (const ex of excludes) args.push("--glob", `!${ex}`);
  args.push("-e", keyword, targetPath);

  const matches: Array<{ path: string; line: number; text: string }> = [];
  const budget = createOutputBudget();

  const { stderr, exitCode } = await runRipgrepStreaming(rgPath, args, (line) => {
    if (!line) return true;
    const parsed = parseRipgrepSearchLine(line);
    if (!parsed) return true;
    if (!consumeOutputBudget(budget, parsed)) return false;
    matches.push(parsed);
    return matches.length < maxResults && !budget.truncated;
  });

  // Exit code 0 = matches found, 1 = no matches, 2 = error
  if (exitCode === 2) {
    throw new Error(`ripgrep search failed: ${stderr.trim() || "unknown error"}`);
  }

  return {
    result: { path: targetPath, matches },
    truncated: budget.truncated || matches.length >= maxResults,
  };
}

// ─── Glob helpers ────────────────────────────────────────────────────

function globList(value: unknown, name: string): Minimatch[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`'${name}' must be an array of non-empty glob patterns.`);
  }
  return value.map((pattern) => new Minimatch(pattern, { matchBase: true, dot: true }));
}

function matchesAnyGlob(patterns: Minimatch[], value: string): boolean {
  return patterns.some((pattern) => pattern.match(value));
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`'${name}' must be an array of non-empty strings.`);
  }
  return value as string[];
}

// ─── File reading helpers ────────────────────────────────────────────

async function readTextPrefix(filePath: string): Promise<{ content: string; truncated: boolean }> {
  const file = await open(filePath, "r");
  try {
    const stats = await file.stat();
    const buffer = Buffer.alloc(MAX_OUTPUT_CHARS * 4);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.toString("utf8", 0, bytesRead);
    return { content, truncated: bytesRead < stats.size || content.length > MAX_OUTPUT_CHARS };
  } finally {
    await file.close();
  }
}

async function scanFileLines(filePath: string, visit: (text: string, lineNumber: number) => boolean): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let pending = "";
  let lineNumber = 0;
  let skipLongLine = false;
  try {
    for await (const chunk of stream) {
      if (chunk.includes("\0")) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lineNumber += 1;
        const shouldVisit = !skipLongLine;
        const text = skipLongLine ? "" : pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        skipLongLine = false;
        if (shouldVisit && !visit(text, lineNumber)) return;
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_SCANNED_LINE_CHARS) {
        pending = "";
        skipLongLine = true;
      }
    }
    if (!skipLongLine && pending) visit(pending.replace(/\r$/, ""), lineNumber + 1);
  } finally {
    stream.destroy();
  }
}

// ─── Output formatting helpers ───────────────────────────────────────

function truncateWithNotice(value: string, forced = false, maxChars = MAX_OUTPUT_CHARS): string {
  if (!forced && value.length <= maxChars) return value;
  let prefix = value.slice(0, Math.max(0, maxChars - OUTPUT_TRUNCATED_NOTICE.length));
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + OUTPUT_TRUNCATED_NOTICE;
}

function limitResult(value: unknown, forced = false) {
  const output = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return boundedOutputResult({}, output, forced);
}

async function waitForTask(task: ShellTask, waitMs: number): Promise<void> {
  if (task.status !== "running" || waitMs === 0) return;
  await Promise.race([task.exited, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
}

function shellTaskResult(taskId: string, task: ShellTask) {
  return boundedOutputResult({ taskId, status: task.status, exitCode: task.exitCode }, task.output, task.truncated);
}

function boundedOutputResult<T extends Record<string, unknown>>(base: T, value: string, forced: boolean) {
  let maxChars = MAX_OUTPUT_CHARS;
  let truncated = forced || value.length > maxChars;
  for (;;) {
    const result = { ...base, output: truncateWithNotice(value, truncated, maxChars), truncated };
    const excess = JSON.stringify(result).length - MAX_OUTPUT_CHARS;
    if (excess <= 0) return result;
    truncated = true;
    maxChars = Math.max(OUTPUT_TRUNCATED_NOTICE.length, maxChars - excess);
  }
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).once("exit", () => resolve()));
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
