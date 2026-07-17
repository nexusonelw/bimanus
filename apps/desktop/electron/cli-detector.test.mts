import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliType, findExecutable } from "@bimanus/cli-adapter";
import { CliDetector } from "./cli-detector.ts";

const installed = (binaryPath: string) => ({
  installed: true,
  binaryPath,
  version: "1.0.0",
  installSource: "standalone" as const,
  error: null,
});

function registryFor(adapter: { cliType: CliType; displayName: string; detect(): Promise<ReturnType<typeof installed>> }) {
  return {
    getSupportedTypes: () => [adapter.cliType],
    getAdapter: () => ({
      ...adapter,
      buildTuiSpawnCommand: ({ prompt }: { prompt: string }) => ({ command: "unused", args: prompt ? [prompt] : [], env: {} }),
    }),
  };
}

describe("CliDetector", () => {
  if (process.platform !== "win32") {
    it("finds executables in the standard per-user CLI directory", () => {
      const home = mkdtempSync(path.join(tmpdir(), "pi-gui-cli-"));
      const binaryPath = path.join(home, ".local", "bin", "agy");
      try {
        mkdirSync(path.dirname(binaryPath), { recursive: true });
        writeFileSync(binaryPath, "#!/bin/sh\n");
        chmodSync(binaryPath, 0o755);

        expect(findExecutable("agy", { env: { PATH: "" }, home })).toBe(binaryPath);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("coalesces detection and reuses the cached result", async () => {
    let calls = 0;
    const adapter = {
      cliType: CliType.Grok,
      displayName: "Grok CLI",
      detect: async () => {
        calls += 1;
        return installed("/bin/sh");
      },
    };
    const detector = new CliDetector(registryFor(adapter), (command) => command.startsWith("/") ? command : null);

    await Promise.all([detector.detectOne("grok"), detector.detectOne("grok")]);
    await detector.detectOne("grok");

    expect(calls).toBe(1);
  });

  it("returns an absolute launch command before background detection finishes", async () => {
    let finishDetection!: (result: ReturnType<typeof installed>) => void;
    const adapter = {
      cliType: CliType.Antigravity,
      displayName: "Antigravity CLI",
      detect: () => new Promise<ReturnType<typeof installed>>((resolve) => { finishDetection = resolve; }),
    };
    const detector = new CliDetector(
      registryFor(adapter),
      (command) => command === "agy" || command === "/tmp/agy" ? "/tmp/agy" : null,
    );

    const launch = detector.resolveLaunchCommand("antigravity", "hello");

    expect(launch).toEqual({ file: "/tmp/agy", args: ["hello"] });
    await Promise.resolve();
    finishDetection(installed("/tmp/agy"));
  });

  it("rejects a missing CLI instead of returning a bare command", () => {
    const adapter = {
      cliType: CliType.Antigravity,
      displayName: "Antigravity CLI",
      detect: async () => installed("/tmp/agy"),
    };
    const detector = new CliDetector(registryFor(adapter), () => null);

    expect(() => detector.resolveLaunchCommand("antigravity", "")).toThrow('executable "agy" was not found');
  });
});
