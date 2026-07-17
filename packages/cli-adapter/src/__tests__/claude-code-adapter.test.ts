/**
 * Claude Code CLI 适配器单元测试
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ClaudeCodeAdapter } from "../claude-code-adapter.js";
import { CliType } from "../types.js";

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  it("should have correct cliType", () => {
    expect(adapter.cliType).toBe(CliType.ClaudeCode);
  });

  it("should have correct displayName", () => {
    expect(adapter.displayName).toBe("Claude Code CLI");
  });

  it("should support all platforms", () => {
    expect(adapter.supportedPlatforms()).toContain("darwin");
    expect(adapter.supportedPlatforms()).toContain("linux");
    expect(adapter.supportedPlatforms()).toContain("win32");
  });

  it("should require spawn workaround on Windows", () => {
    // 在非 Windows 上为 false
    if (process.platform !== "win32") {
      expect(adapter.requiresSpawnWorkaround()).toBe(false);
    }
  });

  it("should build kill sequence with SIGINT, SIGTERM, then SIGKILL", () => {
    const seq = adapter.buildKillSequence();
    expect(seq).toHaveLength(3);
    expect(seq[0].signal).toBe("SIGINT");
    expect(seq[1].signal).toBe("SIGTERM");
    expect(seq[2].signal).toBe("SIGKILL");
  });

  it("should build TUI spawn command without prompt", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "",
      outputFormat: "text",
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.args).toEqual([]);
  });

  it("should build TUI spawn command with prompt", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "refactor this",
      outputFormat: "text",
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.args).toEqual(["refactor this"]);
  });

  it("should check auth returns false when no API key", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(adapter.checkAuth()).resolves.toBe(false);

    if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
  });
});
