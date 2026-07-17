import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forcePersistSession, transcriptFromMessages } from "./session-supervisor-utils.js";

test("forcePersistSession keeps SessionManager append persistence from recreating the jsonl file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-gui-session-manager-"));
  try {
    const manager = SessionManager.create(tempDir);
    manager.appendSessionInfo("Persisted title");
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);

    forcePersistSession(manager);

    assert.doesNotThrow(() => {
      manager.appendMessage({
        role: "assistant",
        content: "Done.",
        timestamp: Date.now(),
      } as never);
    });
    assert.match(await readFile(sessionFile, "utf8"), /"role":"assistant"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("transcriptFromMessages rebuilds tool rows from persisted toolCall and toolResult messages", () => {
  const transcript = transcriptFromMessages([
    {
      role: "user",
      content: "inspect files",
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the file." },
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
      ],
      timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
    },
    {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "# Project\n" }],
      isError: false,
      timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
    },
  ], "2026-01-01T00:00:00.000Z");

  assert.equal(transcript.length, 4);
  assert.deepEqual(
    transcript.map((item) => item.kind),
    ["message", "message", "tool", "message"],
  );
  assert.deepEqual(transcript[2], {
    kind: "tool",
    id: "call-read",
    callId: "call-read",
    toolName: "read",
    status: "success",
    label: "Explored README.md",
    createdAt: "2026-01-01T00:00:01.000Z",
    input: { path: "README.md" },
    output: "# Project\n",
  });
});

test("transcriptFromMessages preserves markdown structure from persisted text parts", () => {
  const transcript = transcriptFromMessages([
    {
      role: "assistant",
      content: [
        { type: "text", text: "## Result\n\n- one\n- two" },
        { type: "text", text: "```ts\nconst value = 1;\n```" },
      ],
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    },
  ], "2026-01-01T00:00:00.000Z");

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.kind, "message");
  assert.equal(
    transcript[0]?.kind === "message" ? transcript[0].text : "",
    "## Result\n\n- one\n- two\n\n```ts\nconst value = 1;\n```",
  );
});
