/**
 * OpenCode CLI 适配器单元测试
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenCodeAdapter } from "../opencode-adapter.js";
import { CliType } from "../types.js";

describe("OpenCodeAdapter", () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  it("should have correct cliType", () => {
    expect(adapter.cliType).toBe(CliType.OpenCode);
  });

  it("should have correct displayName", () => {
    expect(adapter.displayName).toBe("OpenCode CLI");
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

  it("should build TUI spawn command with prompt and default port 0", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "hello world",
      outputFormat: "text",
    });
    expect(cmd.command).toBe("opencode");
    expect(cmd.args).toEqual(["--port", "0", "--prompt", "hello world"]);
  });

  it("should build TUI spawn command with explicit port", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "hello world",
      outputFormat: "text",
      port: 54321,
    });
    expect(cmd.command).toBe("opencode");
    expect(cmd.args).toEqual(["--port", "54321", "--prompt", "hello world"]);
  });

  it("should build TUI spawn command without prompt", () => {
    const cmd = adapter.buildTuiSpawnCommand({
      cwd: "/test",
      prompt: "",
      outputFormat: "text",
      port: 8080,
    });
    expect(cmd.command).toBe("opencode");
    expect(cmd.args).toEqual(["--port", "8080"]);
  });

  it("should check auth by default returning true", () => {
    expect(adapter.checkAuth()).resolves.toBe(true);
  });
});
