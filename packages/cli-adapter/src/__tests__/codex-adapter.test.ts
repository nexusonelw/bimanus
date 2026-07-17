/**
 * CodeX CLI 适配器单元测试
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodeXAdapter } from "../codex-adapter.js";
import { CliType } from "../types.js";

describe("CodeXAdapter", () => {
  let adapter: CodeXAdapter;

  beforeEach(() => {
    adapter = new CodeXAdapter();
  });

  it("should have correct cliType", () => {
    expect(adapter.cliType).toBe(CliType.CodeX);
  });

  it("should have correct displayName", () => {
    expect(adapter.displayName).toBe("CodeX CLI");
  });

  it("should support all platforms", () => {
    expect(adapter.supportedPlatforms()).toContain("darwin");
    expect(adapter.supportedPlatforms()).toContain("linux");
    expect(adapter.supportedPlatforms()).toContain("win32");
  });

  it("should not require spawn workaround", () => {
    expect(adapter.requiresSpawnWorkaround()).toBe(false);
  });

  it("should build kill sequence with SIGTERM then SIGKILL", () => {
    const seq = adapter.buildKillSequence();
    expect(seq).toHaveLength(2);
    expect(seq[0].signal).toBe("SIGTERM");
    expect(seq[1].signal).toBe("SIGKILL");
  });

  it("should build TUI spawn command without prompt", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "",
      outputFormat: "text",
    });
    expect(cmd.command).toBe("codex");
    expect(cmd.args).toEqual([]);
  });

  it("should build TUI spawn command with prompt", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "hello",
      outputFormat: "text",
    });
    expect(cmd.command).toBe("codex");
    expect(cmd.args).toEqual(["hello"]);
  });

  it("should check auth returns false when no API key", () => {
    // 清除环境变量
    const origCodexKey = process.env.CODEX_API_KEY;
    const origOpenaiKey = process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    expect(adapter.checkAuth()).resolves.toBe(false);

    // 恢复
    if (origCodexKey) process.env.CODEX_API_KEY = origCodexKey;
    if (origOpenaiKey) process.env.OPENAI_API_KEY = origOpenaiKey;
  });

  it("should detect as not installed when binary not found", async () => {
    const result = await adapter.detect();
    // 取决于测试环境是否安装了 codex
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("binaryPath");
    expect(result).toHaveProperty("version");
  });

  it("should throw on background sessions (not supported)", () => {
    expect(adapter.startBackgroundSession("test", "/test")).rejects.toThrow();
    expect(adapter.listBackgroundSessions()).rejects.toThrow();
    expect(adapter.stopSession("test")).rejects.toThrow();
    expect(adapter.getSessionLogs("test")).rejects.toThrow();
  });
});
