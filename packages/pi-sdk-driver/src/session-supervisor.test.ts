import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@bimanus/session-driver";
import { SessionSupervisor } from "./session-supervisor.js";

test("cancelCurrentRun keeps stale streaming events from restoring running status", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-gui-session-supervisor-"));
  try {
    let emitAgentEvent: ((event: AgentSessionEvent) => void) | undefined;
    let clearQueueCalls = 0;
    let abortCalls = 0;

    const supervisor = new SessionSupervisor({
      catalogFilePath: join(tempDir, "catalogs.json"),
      createAgentSessionRuntimeImpl: async (options) => {
        const manager = options?.sessionManager ?? SessionManager.create(tempDir);
        const session = {
          sessionId: "session-1",
          sessionManager: manager,
          sessionFile: manager.getSessionFile(),
          sessionName: undefined,
          isStreaming: false,
          messages: [],
          promptTemplates: [],
          resourceLoader: { getSkills: () => ({ skills: [] }) },
          extensionRunner: { getRegisteredCommands: () => [] },
          subscribe(listener: (event: AgentSessionEvent) => void) {
            emitAgentEvent = listener;
            return () => {
              emitAgentEvent = undefined;
            };
          },
          async bindExtensions() {},
          clearQueue() {
            clearQueueCalls += 1;
            return { steering: [], followUp: [] };
          },
          async abort() {
            abortCalls += 1;
          },
          async prompt() {
            this.isStreaming = true;
          },
        };

        return {
          session,
          services: {},
          diagnostics: [],
          cwd: tempDir,
          setRebindSession() {},
          setBeforeSessionInvalidate() {},
          async dispose() {},
        } as never;
      },
    });

    const snapshot = await supervisor.createSession({
      workspaceId: tempDir,
      path: tempDir,
      displayName: "Test",
    });
    const events: SessionDriverEvent[] = [];
    supervisor.subscribe(snapshot.ref, (event) => {
      events.push(event);
    });

    await supervisor.sendUserMessage(snapshot.ref, { text: "run" });
    assert.equal(latestSessionStatus(events), "running");

    await supervisor.cancelCurrentRun(snapshot.ref);
    assert.equal(clearQueueCalls, 1);
    assert.equal(abortCalls, 1);
    assert.equal(latestSessionStatus(events), "idle");

    emitAgentEvent?.({ type: "turn_start" } as AgentSessionEvent);
    emitAgentEvent?.({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: {},
    } as AgentSessionEvent);
    await flushAsyncEvents();
    assert.equal(latestSessionStatus(events), "idle");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sendUserMessage syncs idle status when prompt returns after completion", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-gui-session-supervisor-"));
  try {
    const supervisor = new SessionSupervisor({
      catalogFilePath: join(tempDir, "catalogs.json"),
      createAgentSessionRuntimeImpl: async (options) => {
        const manager = options?.sessionManager ?? SessionManager.create(tempDir);
        const session = {
          sessionId: "session-1",
          sessionManager: manager,
          sessionFile: manager.getSessionFile(),
          sessionName: undefined,
          isStreaming: false,
          messages: [],
          promptTemplates: [],
          resourceLoader: { getSkills: () => ({ skills: [] }) },
          extensionRunner: { getRegisteredCommands: () => [] },
          subscribe() {
            return () => {};
          },
          async bindExtensions() {},
          clearQueue() {
            return { steering: [], followUp: [] };
          },
          async abort() {},
          async prompt() {
            this.isStreaming = true;
            this.isStreaming = false;
          },
        };

        return {
          session,
          services: {},
          diagnostics: [],
          cwd: tempDir,
          setRebindSession() {},
          setBeforeSessionInvalidate() {},
          async dispose() {},
        } as never;
      },
    });

    const snapshot = await supervisor.createSession({
      workspaceId: tempDir,
      path: tempDir,
      displayName: "Test",
    });
    const events: SessionDriverEvent[] = [];
    supervisor.subscribe(snapshot.ref, (event) => {
      events.push(event);
    });

    await supervisor.sendUserMessage(snapshot.ref, { text: "run" });
    assert.equal(latestSessionStatus(events), "idle");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function latestSessionStatus(events: readonly SessionDriverEvent[]) {
  return [...events].reverse().find((event) => event.type === "sessionUpdated")?.snapshot.status;
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
