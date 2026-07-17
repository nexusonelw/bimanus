/**
 * @fileoverview Claude Code CLI (Anthropic) 适配器实现
 *
 * 参考文档: https://docs.anthropic.com/en/docs/claude-code
 * 已知坑点:
 * - Node.js spawn 会 hang (需 cmd /c workaround on Windows) (#771/#6295)
 * - 无 --cwd 标志 (#26287)
 * - stream-json 事件类型未文档化 (#24596)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliAdapter } from "./cli-adapter.js";
import type { CliBackgroundSession, CliDetectionResult, CliEvent, CliSpawnConfig } from "./types.js";
import { CliType } from "./types.js";
import { buildSpawnInvocation, findExecutable } from "./spawn-utils.js";

/**
 * Claude Code CLI 适配器
 *
 * 特性：
 * - TUI 模式: claude [-p prompt]
 * - Headless 模式: claude -p [--output-format stream-json] "prompt"
 * - 后台模式: claude --bg "task"
 * - 事件格式: NDJSON
 */
export class ClaudeCodeAdapter implements CliAdapter {
  readonly cliType = CliType.ClaudeCode;
  readonly displayName = "Claude Code CLI";

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
    return !!process.env.ANTHROPIC_API_KEY;
  }

  // ── 启动与执行 ──

  buildTuiSpawnCommand(config: CliSpawnConfig): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string | undefined>;
  } {
    const args: string[] = [];
    // Claude Code TUI 模式: claude [prompt]
    // 注意: 无 --cwd 标志，必须在 spawn 时设置 cwd
    if (config.prompt) {
      args.push(config.prompt);
    }
    return {
      command: "claude",
      args,
      env: this.buildEnv(config.env),
    };
  }

  async *executeHeadless(config: CliSpawnConfig): AsyncIterable<CliEvent> {
    const args = this.buildHeadlessArgs(config);
    const { command: spawnCmd, args: spawnArgs } = this.buildSpawnInvocation("claude", args);
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
        const event = this.parseClaudeNdjsonEvent(json);
        if (event) {
          // 尝试从 result 中提取 session ID
          if (event.type === "completed" && json.session_id) {
            sessionId = json.session_id as string;
          }
          yield event;
        }
      } catch {
        // 忽略无效 JSON 行
      }
    }

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

  async startBackgroundSession(prompt: string, cwd: string): Promise<string> {
    const child = spawn("claude", ["--bg", prompt], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.buildEnv(),
    });

    return new Promise((resolve, reject) => {
      let stdout = "";
      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.on("close", (code) => {
        if (code === 0) {
          // 尝试从输出中提取 session ID
          const match = stdout.match(/session[:\s]+([a-zA-Z0-9_-]+)/i);
          resolve(match?.[1] ?? `bg-${Date.now()}`);
        } else {
          reject(new Error(`Background session start failed with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }

  async listBackgroundSessions(): Promise<readonly CliBackgroundSession[]> {
    // claude agents 列出后台 agent
    try {
      const result = await this.execCommand("claude", ["agents"]);
      return this.parseAgentList(result);
    } catch {
      return [];
    }
  }

  async *attachToSession(sessionId: string): AsyncIterable<CliEvent> {
    // claude -r <sessionId> 或 claude -c (继续上次)
    const args = sessionId === "last" ? ["-c"] : ["-r", sessionId];
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.buildEnv(),
    });

    yield { type: "started", timestamp: Date.now() };

    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      try {
        const json = JSON.parse(line);
        const event = this.parseClaudeNdjsonEvent(json);
        if (event) yield event;
      } catch {
        // 忽略
      }
    }

    yield { type: "completed", sessionId, timestamp: Date.now() };
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.execCommand("claude", ["agents", "stop", sessionId]);
  }

  async getSessionLogs(sessionId: string): Promise<string> {
    return this.execCommand("claude", ["agents", "logs", sessionId]);
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
      { signal: "SIGINT", timeoutMs: 5000, description: "Graceful interrupt (SIGINT)" },
      { signal: "SIGTERM", timeoutMs: 3000, description: "Force terminate (SIGTERM)" },
      { signal: "SIGKILL", timeoutMs: 1000, description: "Emergency kill (SIGKILL)" },
    ];
  }

  // ── 平台适配 ──

  supportedPlatforms(): readonly string[] {
    return ["darwin", "linux", "win32"];
  }

  requiresSpawnWorkaround(): boolean {
    return process.platform === "win32";
  }

  buildSpawnInvocation(
    command: string,
    args: readonly string[],
  ): { command: string; args: readonly string[] } {
    return buildSpawnInvocation(this.cliType, command, args);
  }

  // ── 内部辅助方法 ──

  private async resolveBinaryPath(): Promise<string | null> {
    return findExecutable("claude");
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
    if (binaryPath.includes(".local/bin")) return "standalone";
    if (binaryPath.includes("homebrew") || binaryPath.includes("/brew/")) return "homebrew";
    if (binaryPath.includes("npm") || binaryPath.includes("node_modules")) return "npm";
    return "unknown";
  }

  private buildEnv(extraEnv?: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    return { ...process.env, ...extraEnv };
  }

  private buildHeadlessArgs(config: CliSpawnConfig): string[] {
    const args: string[] = ["-p"];
    if (config.outputFormat === "stream-json") {
      args.push("--output-format", "stream-json");
    }
    if (config.bare) {
      args.push("--bare");
    }
    if (config.maxTurns) {
      args.push("--max-turns", String(config.maxTurns));
    }
    if (config.maxBudgetUsd) {
      args.push("--max-budget-usd", String(config.maxBudgetUsd));
    }
    if (config.allowedTools?.length) {
      args.push("--allowed-tools", config.allowedTools.join(","));
    }
    if (config.disallowedTools?.length) {
      args.push("--disallowed-tools", config.disallowedTools.join(","));
    }
    if (config.permissionMode === "acceptEdits") {
      args.push("--accept-edits");
    } else if (config.permissionMode === "bypassPermissions") {
      args.push("--bypass-permissions");
    }
    args.push(config.prompt);
    return args;
  }

  /**
   * 解析 Claude Code NDJSON 事件流
   *
   * Claude Code 输出格式（未完整文档化）:
   *   {"type":"stream_event","stream_event":{"type":"content_block_delta","content_block":{"type":"text_delta","text":"..."}}}
   *   {"type":"message_start","message":{"id":"...","content":[...]}}
   *   {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
   *   {"type":"message_stop"}
   *   {"type":"result","result":{"type":"text","text":"..."}}
   *   {"type":"user","text":"..."}
   *   {"type":"system","text":"..."}
   */
  private parseClaudeNdjsonEvent(json: Record<string, unknown>): CliEvent | null {
    const ts = Date.now();
    const type = json.type as string | undefined;

    switch (type) {
      case "message_start":
        return { type: "started", timestamp: ts };

      case "stream_event": {
        const streamEvent = json.stream_event as Record<string, unknown> | undefined;
        const seType = streamEvent?.type as string | undefined;
        if (seType === "content_block_delta") {
          const block = streamEvent?.content_block as Record<string, unknown> | undefined;
          if (block?.type === "text_delta") {
            return { type: "agent_message", content: String(block.text ?? ""), timestamp: ts };
          }
          if (block?.type === "input_json_delta") {
            return { type: "progress", message: "Receiving JSON input...", timestamp: ts };
          }
        }
        return null;
      }

      case "message_delta":
        return { type: "progress", message: "Processing message delta", timestamp: ts };

      case "message_stop":
        return null; // 消息结束，不产生独立事件

      case "result":
        return { type: "completed", sessionId: null, timestamp: ts };

      case "error":
        return {
          type: "error",
          message: String(json.error ?? json.message ?? "Unknown Claude Code error"),
          fatal: true,
          timestamp: ts,
        };

      case "system":
        return { type: "progress", message: String(json.text ?? ""), timestamp: ts };

      default:
        return null;
    }
  }

  private parseAgentList(output: string): readonly CliBackgroundSession[] {
    const sessions: CliBackgroundSession[] = [];
    // 解析 claude agents 输出（格式待确认）
    const lines = output.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && parts[0]) {
        sessions.push({
          id: parts[0],
          title: parts.slice(1).join(" "),
          status: "running",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
      }
    }
    return sessions;
  }

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
