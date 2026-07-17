import { spawn } from "node:child_process";
import type { CliAdapter } from "./cli-adapter.js";
import type { CliBackgroundSession, CliDetectionResult, CliEvent, CliSpawnConfig, CliType, KillStep } from "./types.js";
import { buildSpawnInvocation, findExecutable } from "./spawn-utils.js";

export class GenericTuiAdapter implements CliAdapter {
  constructor(
    readonly cliType: CliType,
    readonly displayName: string,
    private readonly command: string,
  ) {}

  async detect(): Promise<CliDetectionResult> {
    try {
      const binaryPath = await this.resolveBinaryPath();
      if (!binaryPath) {
        return { installed: false, binaryPath: null, version: null, installSource: null, error: null };
      }
      const version = await this.getVersion(binaryPath);
      return { installed: true, binaryPath, version, installSource: this.classifyInstallSource(binaryPath), error: null };
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
    return true;
  }

  buildTuiSpawnCommand(config: CliSpawnConfig): {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string | undefined>;
  } {
    return {
      command: this.command,
      args: config.prompt ? [config.prompt] : [],
      env: { ...process.env, ...config.env },
    };
  }

  async *executeHeadless(_config: CliSpawnConfig): AsyncIterable<CliEvent> {
    throw new Error(`${this.displayName} headless execution is not implemented`);
  }

  async startBackgroundSession(_prompt: string, _cwd: string): Promise<string> {
    throw new Error(`${this.displayName} background sessions are not implemented`);
  }

  async listBackgroundSessions(): Promise<readonly CliBackgroundSession[]> {
    return [];
  }

  async *attachToSession(_sessionId: string): AsyncIterable<CliEvent> {
    throw new Error(`${this.displayName} session attach is not implemented`);
  }

  async stopSession(_sessionId: string): Promise<void> {
    throw new Error(`${this.displayName} session stop is not implemented`);
  }

  async getSessionLogs(_sessionId: string): Promise<string> {
    throw new Error(`${this.displayName} session logs are not implemented`);
  }

  isProcessAlive(pid: number): boolean {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  }

  buildKillSequence(): readonly KillStep[] {
    return [
      { signal: "SIGTERM", timeoutMs: 3000, description: "Graceful shutdown" },
      { signal: "SIGKILL", timeoutMs: 1000, description: "Force kill" },
    ];
  }

  supportedPlatforms(): readonly string[] {
    return ["darwin", "linux", "win32"];
  }

  requiresSpawnWorkaround(): boolean {
    return false;
  }

  buildSpawnInvocation(command: string, args: readonly string[]): { command: string; args: readonly string[] } {
    return buildSpawnInvocation(this.cliType, command, args);
  }

  private async resolveBinaryPath(): Promise<string | null> {
    return findExecutable(this.command);
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

  private execCommand(command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 3_000,
        killSignal: "SIGKILL",
      });
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
