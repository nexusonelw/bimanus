/**
 * @fileoverview spawn 平台兼容工具函数
 *
 * 处理各 CLI spawn 的平台特定问题：
 * - Claude Code (Windows): 需要 cmd /c 包装以避免 Node.js spawn hang
 * - CodeX / OpenCode: 标准 spawn 即可
 */

import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { CliType } from "./types.js";

export interface FindExecutableOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

/** Resolve a command to an absolute executable path without spawning a shell. */
export function findExecutable(
  command: string,
  options: FindExecutableOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const pathValue = platform === "win32" ? env.Path ?? env.PATH ?? "" : env.PATH ?? "";
  const directories = path.isAbsolute(command)
    ? [""]
    : uniqueStrings([
        ...pathValue.split(path.delimiter),
        home && path.join(home, ".local", "bin"),
        home && path.join(home, ".cursor", "bin"),
        home && path.join(home, ".grok", "bin"),
        home && path.join(home, ".bun", "bin"),
        home && path.join(home, ".opencode", "bin"),
        home && path.join(home, ".codex", "packages", "standalone", "current"),
        ...(platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]),
      ]);
  const extensions = platform === "win32" && !path.extname(command)
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const accessMode = platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${command}${extension.toLowerCase()}`);
      try {
        accessSync(candidate, accessMode);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * 构建平台兼容的 spawn 调用参数
 *
 * @param cliType - CLI 类型
 * @param command - 原始命令
 * @param args - 原始参数
 * @param platform - 目标平台（默认当前平台）
 * @returns 处理后的命令和参数
 */
export function buildSpawnInvocation(
  cliType: CliType,
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: readonly string[] } {
  // Claude Code 在 Windows 上需要 cmd /c 包装
  // 参考: https://github.com/nicegui/nicegui/issues/771
  if (cliType === "claude" && platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", command, ...args],
    };
  }
  return { command, args };
}

/**
 * 检查指定 CLI 在当前平台上是否需要 spawn workaround
 */
export function requiresSpawnWorkaround(cliType: CliType, platform: NodeJS.Platform = process.platform): boolean {
  return cliType === "claude" && platform === "win32";
}

/**
 * 获取 CLI 的检测命令
 */
export function getDetectionCommand(cliType: CliType): string {
  switch (cliType) {
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "grok":
      return "grok";
    case "copilot":
      return "copilot";
    case "antigravity":
      return "agy";
    case "kiro":
      return "kiro-cli";
    case "cursor":
      return "cursor-agent";
    case "droid":
      return "droid";
  }
  return cliType;
}

/**
 * 获取 CLI 的版本命令
 */
export function getVersionArgs(): readonly string[] {
  return ["--version"];
}

/**
 * 将二进制路径分类为安装来源
 */
export function classifyInstallSource(binaryPath: string): "standalone" | "npm" | "homebrew" | "unknown" {
  if (binaryPath.includes(".local/bin") || binaryPath.includes(".codex")) {
    return "standalone";
  }
  if (binaryPath.includes("/homebrew/") || binaryPath.includes("brew")) {
    return "homebrew";
  }
  if (binaryPath.includes("/npm/") || binaryPath.includes("/node_modules/")) {
    return "npm";
  }
  return "unknown";
}
