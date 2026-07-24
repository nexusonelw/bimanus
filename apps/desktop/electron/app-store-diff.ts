import { execFile } from "node:child_process";
import path from "node:path";

function validateFilePath(workspacePath: string, filePath: string): string {
  const resolved = path.resolve(workspacePath, filePath);
  if (!resolved.startsWith(workspacePath + path.sep) && resolved !== workspacePath) {
    throw new Error("Path escapes workspace");
  }
  return filePath;
}

export interface ChangedFileEntry {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "untracked";
}

export interface RemoteBranchEntry {
  readonly remote: string;
  readonly branch: string;
}

export function getChangedFiles(workspacePath: string): Promise<ChangedFileEntry[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd: workspacePath, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const entries: ChangedFileEntry[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          const xy = line.slice(0, 2);
          let filePath = line.slice(3).trim();
          // Renames show as "old -> new"; use the new path
          const renameArrow = filePath.indexOf(" -> ");
          if (renameArrow >= 0) {
            filePath = filePath.slice(renameArrow + 4);
          }
          entries.push({
            path: filePath,
            status: parseStatus(xy),
          });
        }
        resolve(entries);
      },
    );
  });
}

export function getFileDiff(workspacePath: string, filePath: string): Promise<string> {
  validateFilePath(workspacePath, filePath);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", "--", filePath],
      { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          // Try staged diff
          execFile(
            "git",
            ["diff", "--cached", "--", filePath],
            { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
            (error2, stdout2) => {
              if (!error2 && stdout2.trim()) {
                resolve(stdout2);
                return;
              }
              // Untracked file — show content as all-additions diff
              execFile(
                "git",
                ["diff", "--no-index", "--", "/dev/null", filePath],
                { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
                (_error3, stdout3) => {
                  // git diff --no-index exits 1 when files differ, which is expected
                  resolve(stdout3 || "");
                },
              );
            },
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function commitChanges(
  workspacePath: string,
  filePaths: readonly string[],
  message: string,
): Promise<void> {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    throw new Error("Commit message is required");
  }

  const normalizedPaths = [
    ...new Set(filePaths.map((filePath) => validateFilePath(workspacePath, filePath))),
  ];
  if (normalizedPaths.length === 0) {
    throw new Error("At least one changed file must be selected");
  }

  await runGit(workspacePath, ["add", "--", ...normalizedPaths]);
  await runGit(workspacePath, [
    "commit",
    "--only",
    "-m",
    normalizedMessage,
    "--",
    ...normalizedPaths,
  ]);
}

export async function listRemoteBranches(workspacePath: string): Promise<RemoteBranchEntry[]> {
  const [remoteOutput, refOutput, currentBranchOutput] = await Promise.all([
    runGitOutput(workspacePath, ["remote"]),
    runGitOutput(workspacePath, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/",
    ]),
    runGitOutput(workspacePath, ["branch", "--show-current"]),
  ]);
  const remotes = remoteOutput.split("\n").map((remote) => remote.trim()).filter(Boolean);
  if (remotes.length === 0) {
    return [];
  }

  const entries: RemoteBranchEntry[] = [];
  const seen = new Set<string>();
  const remotesByLength = [...remotes].sort((left, right) => right.length - left.length);
  const addEntry = (remote: string, branch: string) => {
    const key = `${remote}\0${branch}`;
    if (!branch || branch === "HEAD" || seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ remote, branch });
  };

  for (const ref of refOutput.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const remote = remotesByLength.find((candidate) => ref.startsWith(`${candidate}/`));
    if (remote) {
      addEntry(remote, ref.slice(remote.length + 1));
    }
  }

  const currentBranch = currentBranchOutput.trim();
  if (currentBranch) {
    for (const remote of remotes) {
      addEntry(remote, currentBranch);
    }
  }

  return entries.sort((left, right) =>
    left.remote.localeCompare(right.remote) || left.branch.localeCompare(right.branch),
  );
}

export async function pushRemoteBranch(
  workspacePath: string,
  remote: string,
  branch: string,
): Promise<void> {
  const remotes = (await runGitOutput(workspacePath, ["remote"]))
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`Unknown Git remote: ${remote}`);
  }

  await runGit(workspacePath, ["check-ref-format", `refs/heads/${branch}`]);
  await runGit(workspacePath, ["push", "--", remote, `HEAD:refs/heads/${branch}`]);
}

function parseStatus(xy: string): ChangedFileEntry["status"] {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";

  if (x === "?" && y === "?") {
    return "untracked";
  }
  if (x === "A" || y === "A") {
    return "added";
  }
  if (x === "D" || y === "D") {
    return "deleted";
  }
  return "modified";
}

function runGit(workspacePath: string, args: readonly string[]): Promise<void> {
  return runGitOutput(workspacePath, args).then(() => undefined);
}

function runGitOutput(workspacePath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: workspacePath, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
