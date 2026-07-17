/**
 * @fileoverview CodeX CLI (OpenAI) 适配器实现
 *
 * 参考文档: https://github.com/openai/codex
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliAdapter } from "./cli-adapter.js";
import type { CliBackgroundSession, CliDetectionResult, CliEvent, CliSpawnConfig } from "./types.js";
import { CliType } from "./types.js";
import { buildSpawnInvocation, findExecutable } from "./spawn-utils.js";

/**
 * CodeX CLI 适配器
 *
 * 特性：
 * - TUI 模式: codex [prompt]
 * - Headless 模式: codex exec [--json] [options] "prompt"
 * - 事件格式: JSONL
 * - 已知限制: 无分离模式 (#23132), 自定义 Session ID 不可用 (#17782)
 */
export class CodeXAdapter implements CliAdapter {
  readonly cliType = CliType.CodeX;
  readonly displayName = "CodeX CLI";

  // ── 安装检测 ──

  async detect(): Promise<CliDetectionResult> {
    try {
      const binaryPath = await this.resolveBinaryPath();
      if (!binaryPath) {
        return { installed: false, binaryPath: null, version: null, installSource: null, error: null };
      }
      const version = await this.getVersion(binaryPath);
      const installSource = this.classifyInstallSource(binaryPath);
      return { installed: true, binaryPath, version, installSource, error: null };
    } catch (error) {
      return {
        installed: false,
        binaryPath: null,
        version: null,
        installSource: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkAuth(): Promise<boolean> {
    return !!(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
  }

  // ── 启动与执行 ──

  buildTuiSpawnCommand(config: CliSpawnConfig): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string | undefined>;
  } {
    const args: string[] = [];
    // CodeX TUI 模式: codex [prompt]
    if (config.prompt) {
      args.push(config.prompt);
    }
    return {
      command: "codex",
      args,
      env: this.buildEnv(config.env),
    };
  }

  async *executeHeadless(config: CliSpawnConfig): AsyncIterable<CliEvent> {
    const args = this.buildHeadlessArgs(config);
    const { command: spawnCmd, args: spawnArgs } = this.buildSpawnInvocation("codex", args);
    const env = this.buildEnv(config.env);

    yield { type: "started", timestamp: Date.now() };

    const child = spawn(spawnCmd, [...spawnArgs], {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const rl = createInterface({ input: child.stdout });
    let sessionId: string | null = null;

    for await (const line of rl) {
      try {
        const json = JSON.parse(line);
        const event = this.parseCodexJsonlEvent(json);
        if (event?.type === "completed" && "thread_id" in json) {
          sessionId = json.thread_id as string ?? null;
        }
        if (event) yield event;
      } catch {
        // 忽略无效 JSON 行
      }
    }

    // 等待进程退出
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });

    if (exitCode !== null && exitCode !== 0) {
      yield { type: "error", message: `Process exited with code ${exitCode}`, fatal: true, timestamp: Date.now() };
    }

    yield { type: "completed", sessionId, timestamp: Date.now() };
  }

  // ── 后台会话 ──

  async startBackgroundSession(_prompt: string, _cwd: string): Promise<string> {
    throw new Error("CodeX CLI does not support background sessions (see issue #23132)");
  }

  async listBackgroundSessions(): Promise<readonly CliBackgroundSession[]> {
    throw new Error("CodeX CLI does not support background sessions");
  }

  async *attachToSession(_sessionId: string): AsyncIterable<CliEvent> {
    throw new Error("CodeX CLI does not support background sessions");
  }

  async stopSession(_sessionId: string): Promise<void> {
    throw new Error("CodeX CLI does not support background sessions");
  }

  async getSessionLogs(_sessionId: string): Promise<string> {
    throw new Error("CodeX CLI does not support background sessions");
  }

  // ── 进程管理 ──

  isProcessAlive(pid: number): boolean {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  }

  buildKillSequence(): readonly { signal: string; timeoutMs: number; description: string }[] {
    return [
      { signal: "SIGTERM", timeoutMs: 3000, description: "Graceful shutdown" },
      { signal: "SIGKILL", timeoutMs: 1000, description: "Force kill" },
    ];
  }

  // ── 平台适配 ──

  supportedPlatforms(): readonly string[] {
    return ["darwin", "linux", "win32"];
  }

  requiresSpawnWorkaround(): boolean {
    return false;
  }

  buildSpawnInvocation(
    command: string,
    args: readonly string[],
  ): { command: string; args: readonly string[] } {
    return buildSpawnInvocation(this.cliType, command, args);
  }

  // ── 内部辅助方法 ──

  private async resolveBinaryPath(): Promise<string | null> {
    return findExecutable("codex");
  }

  private async getVersion(binaryPath: string): Promise<string | null> {
    try {
      const result = await this.execCommand(binaryPath, ["--version"]);
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  private classifyInstallSource(binaryPath: string): "standalone" | "npm" | "homebrew" | "unknown" {
    if (binaryPath.includes(".local/bin") || binaryPath.includes(".codex")) return "standalone";
    if (binaryPath.includes("homebrew") || binaryPath.includes("/brew/")) return "homebrew";
    if (binaryPath.includes("npm") || binaryPath.includes("node_modules")) return "npm";
    return "unknown";
  }

  private buildEnv(extraEnv?: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    return { ...process.env, ...extraEnv };
  }

  private buildHeadlessArgs(config: CliSpawnConfig): string[] {
    const args: string[] = ["exec"];
    if (config.outputFormat === "json" || config.outputFormat === "stream-json") {
      args.push("--json");
    }
    if (config.sandbox) {
      args.push("--sandbox", config.sandbox);
    }
    if (config.ephemeral) {
      args.push("--ephemeral");
    }
    if (config.permissionMode) {
      args.push("--permission-mode", config.permissionMode);
    }
    if (config.timeoutMs) {
      args.push("--timeout", String(Math.ceil(config.timeoutMs / 1000)));
    }
    args.push(config.prompt);
    return args;
  }

  private parseCodexJsonlEvent(json: Record<string, unknown>): CliEvent | null {
    const ts = Date.now();
    const type = json.type as string | undefined;

    switch (type) {
      case "thread.started":
        return { type: "started", timestamp: ts };

      case "item.started": {
        const item = json.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message") {
          return { type: "agent_message", content: "", timestamp: ts };
        }
        if (item?.type === "command_execution") {
          return {
            type: "command_execution",
            command: String(item.command ?? ""),
            exitCode: null,
            output: "",
            status: "started",
            timestamp: ts,
          };
        }
        return null;
      }

      case "item.completed": {
        const item = json.item as Record<string, unknown> | undefined;
        if (!item) return null;
        const itemType = item.type as string;
        switch (itemType) {
          case "agent_message":
            return { type: "agent_message", content: String(item.text ?? ""), timestamp: ts };
          case "reasoning":
            return { type: "reasoning", content: String(item.text ?? ""), timestamp: ts };
          case "command_execution":
            return {
              type: "command_execution",
              command: String(item.command ?? ""),
              exitCode: (item.exit_code as number) ?? null,
              output: String(item.output ?? ""),
              status: (item.exit_code as number) === 0 ? "completed" : "failed",
              timestamp: ts,
            };
          case "file_change":
            return {
              type: "file_change",
              path: String(item.path ?? ""),
              kind: (item.change_type as "add" | "delete" | "update") ?? "update",
              status: "applied",
              timestamp: ts,
            };
          default:
            return null;
        }
      }

      case "turn.completed":
        return { type: "progress", message: "Turn completed", timestamp: ts };

      case "thread.completed":
        return { type: "completed", sessionId: null, timestamp: ts };

      case "error":
        return {
          type: "error",
          message: String(json.message ?? "Unknown error"),
          fatal: true,
          timestamp: ts,
        };

      default:
        return null;
    }
  }

  /**
   * 执行简单命令并返回 stdout
   */
  private execCommand(command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Exit code ${code}`));
      });
      child.on("error", reject);
    });
  }
}
