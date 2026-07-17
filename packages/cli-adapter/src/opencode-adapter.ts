/**
 * @fileoverview OpenCode CLI (anomalyco) 适配器实现
 *
 * 参考文档: https://github.com/anomalyco/opencode
 * 已知坑点:
 * - Sidecar kill 导致孤儿进程 (#17068)
 * - 重启后数据损坏（旧版本）
 * - 端口冲突
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliAdapter } from "./cli-adapter.js";
import type { CliBackgroundSession, CliDetectionResult, CliEvent, CliSpawnConfig } from "./types.js";
import { CliType } from "./types.js";
import { buildSpawnInvocation, findExecutable } from "./spawn-utils.js";

/**
 * OpenCode CLI 适配器
 *
 * 特性：
 * - TUI 模式: opencode [prompt]
 * - Headless 模式: opencode "prompt" (隐式) 或 SDK Client.sendPrompt()
 * - 后台模式: opencode serve --port X (HTTP Server)
 * - 事件格式: SSE (Server-Sent Events)
 *
 * 注：OpenCode 的 headless 模式不如其他两个 CLI 完善，
 *     优先通过 TUI 模式 + node-pty 使用，headless 作为备选。
 */
export class OpenCodeAdapter implements CliAdapter {
  readonly cliType = CliType.OpenCode;
  readonly displayName = "OpenCode CLI";

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
    // OpenCode 可能不需要专门的 API key 或通过配置文件管理
    return true;
  }

  // ── 启动与执行 ──

  buildTuiSpawnCommand(config: CliSpawnConfig): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string | undefined>;
  } {
    const args: string[] = [];
    // Use a caller-provided port so multiple OpenCode sessions can run
    // concurrently without colliding on the same local port. If no port
    // is given, pass --port 0 so the OS assigns a free one.
    args.push("--port", String(config.port ?? 0));
    // OpenCode TUI 模式: opencode --prompt <prompt>
    if (config.prompt) {
      args.push("--prompt", config.prompt);
    }
    return {
      command: "opencode",
      args,
      env: this.buildEnv(config.env),
    };
  }

  async *executeHeadless(config: CliSpawnConfig): AsyncIterable<CliEvent> {
    const args = [config.prompt];
    const { command: spawnCmd, args: spawnArgs } = this.buildSpawnInvocation("opencode", args);
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
        // 尝试解析 SSE 事件
        // OpenCode SSE 格式: data: {...}\n\n
        if (line.startsWith("data: ")) {
          const json = JSON.parse(line.slice(6));
          const event = this.parseOpenCodeSseEvent(json);
          if (event) yield event;
        } else if (line.trim()) {
          // 非 SSE 行作为 agent_message 处理
          yield { type: "agent_message", content: line, timestamp: Date.now() };
        }
      } catch {
        // 忽略解析错误
      }
    }

    // 尝试从 stderr 抓取 session ID
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/session[:\s]+([a-zA-Z0-9_-]+)/i);
      if (match?.[1]) sessionId = match[1];
    });

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
    // OpenCode 后台模式: opencode serve 启动 HTTP 服务器
    // 然后通过 API 发送 prompt
    const child = spawn("opencode", ["serve", "--port", "0"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.buildEnv(),
    });

    return new Promise((resolve, reject) => {
      let stdout = "";
      child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        // 尝试寻找端口信息
        const portMatch = text.match(/port[:\s]+(\d+)/i);
        if (portMatch) {
          resolve(`opencode-serve-${portMatch[1]}`);
        }
      });
      const timeout = setTimeout(() => {
        reject(new Error("Background session start timed out"));
      }, 15000);
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`OpenCode serve exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }

  async listBackgroundSessions(): Promise<readonly CliBackgroundSession[]> {
    // OpenCode 通过 HTTP API 查询 sessions
    // 简化实现：返回空列表
    return [];
  }

  async *attachToSession(_sessionId: string): AsyncIterable<CliEvent> {
    throw new Error("OpenCode attach to session not implemented");
  }

  async stopSession(sessionId: string): Promise<void> {
    // 通过 HTTP API 停止 session
    throw new Error("OpenCode stop session not implemented");
  }

  async getSessionLogs(sessionId: string): Promise<string> {
    throw new Error("OpenCode get session logs not implemented");
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
    return findExecutable("opencode");
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
    if (binaryPath.includes(".opencode")) return "standalone";
    if (binaryPath.includes("homebrew") || binaryPath.includes("/brew/")) return "homebrew";
    if (binaryPath.includes("npm") || binaryPath.includes("node_modules")) return "npm";
    return "unknown";
  }

  private buildEnv(extraEnv?: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    return { ...process.env, ...extraEnv };
  }

  /**
   * 解析 OpenCode SSE 事件
   *
   * OpenCode SSE 格式:
   *   data: {"type":"session.created","session":{"id":"..."}}
   *   data: {"type":"message.stream","message":{"content":"..."}}
   *   data: {"type":"turn.completed","turn":{"id":"..."}}
   */
  private parseOpenCodeSseEvent(json: Record<string, unknown>): CliEvent | null {
    const ts = Date.now();
    const type = json.type as string | undefined;

    switch (type) {
      case "session.created":
        return {
          type: "completed",
          sessionId: (json.session as Record<string, unknown>)?.["id"] as string ?? null,
          timestamp: ts,
        };

      case "message.stream": {
        const message = json.message as Record<string, unknown> | undefined;
        return {
          type: "agent_message",
          content: String(message?.content ?? message?.text ?? ""),
          timestamp: ts,
        };
      }

      case "turn.completed":
        return { type: "progress", message: "Turn completed", timestamp: ts };

      case "session.updated":
        return null; // 会话状态更新，不产生独立事件

      case "error":
        return {
          type: "error",
          message: String(json.message ?? json.error ?? "Unknown OpenCode error"),
          fatal: true,
          timestamp: ts,
        };

      default:
        return null;
    }
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
