import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import type { SessionDriverEvent } from "@bimanus/session-driver";
import {
  createNamedThread,
  createSessionViaIpc,
  desktopShortcut,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  TINY_PNG_BASE64,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function selectedSessionContext(window: Parameters<typeof getDesktopState>[0]): Promise<{
  readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string };
  readonly workspace: { readonly workspaceId: string; readonly path: string; readonly displayName: string };
  readonly title: string;
}> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  if (!workspace) {
    throw new Error("Expected a selected workspace");
  }
  const session = workspace.sessions.find((entry) => entry.id === state.selectedSessionId);
  if (!session) {
    throw new Error("Expected a selected session");
  }
  return {
    sessionRef: {
      workspaceId: workspace.id,
      sessionId: session.id,
    },
    workspace: {
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    },
    title: session.title,
  };
}

async function emitRunningSessionSnapshot(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  window: Parameters<typeof getDesktopState>[0],
  runId: string,
): Promise<void> {
  const context = await selectedSessionContext(window);
  const timestamp = new Date().toISOString();
  const event: Extract<SessionDriverEvent, { type: "sessionUpdated" }> = {
    type: "sessionUpdated",
    sessionRef: context.sessionRef,
    timestamp,
    runId,
    snapshot: {
      ref: context.sessionRef,
      workspace: context.workspace,
      title: context.title,
      status: "running",
      updatedAt: timestamp,
      preview: "Running from test",
      runningRunId: runId,
    },
  };
  await emitTestSessionEvent(harness, event);
}

test("opens a workspace terminal with persistent output, tabs, and takeover controls", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-root");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN: "terminal-test-token-000000000000000000000",
      PI_GUI_COMPUTER_USE_DESKTOP_PID: "424242",
      PI_GUI_COMPUTER_USE_DESKTOP_PATH: "/Applications/Bimanus.app/Contents/MacOS/Bimanus",
      PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET: "/tmp/pi-gui-terminal-test.sock",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Terminal host thread");

    await window.getByLabel("Toggle terminal").hover();
    const terminalTooltip = window.locator(".topbar__tooltip", { hasText: "Toggle terminal" });
    await expect(terminalTooltip).toContainText("Toggle terminal");
    await expect(terminalTooltip.locator("kbd")).toHaveText(/⌘J|Ctrl\+J/);

    await window.getByLabel("Toggle terminal").click();
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(1);

    await terminal.locator(".xterm").click();
    await window.keyboard.type("printf 'PI_TERMINAL_OK\\n'; pwd");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("PI_TERMINAL_OK", { timeout: 15_000 });
    await expect(terminal.locator(".xterm-rows")).toContainText(basename(workspacePath), { timeout: 15_000 });
    await window.keyboard.type("printf '\\033[5mPI_TERMINAL_BLINK\\033[0m\\n'");
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("PI_TERMINAL_BLINK", { timeout: 15_000 });
    await expect(terminal.locator(".terminal-panel__xterm-blink").filter({ hasText: "PI_TERMINAL_BLINK" })).toHaveCount(1);
    await window.keyboard.type(
      "printf 'PI_COMPUTER_USE_ENV:%s:%s:%s:%s\\n' \"${PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN:-missing}\" \"${PI_GUI_COMPUTER_USE_DESKTOP_PID:-missing}\" \"${PI_GUI_COMPUTER_USE_DESKTOP_PATH:-missing}\" \"${PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET:-missing}\"",
    );
    await window.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText("PI_COMPUTER_USE_ENV:missing:missing:missing:missing", {
      timeout: 15_000,
    });

    await window.keyboard.press(desktopShortcut("J"));
    await expect(terminal).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("J"));
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText("PI_TERMINAL_OK", {
      timeout: 15_000,
    });

    await createNamedThread(window, "Terminal other thread");
    await expect(window.getByTestId("integrated-terminal")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("J"));
    await expect(window.getByTestId("integrated-terminal")).toBeVisible();
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).not.toContainText("PI_TERMINAL_OK");
    await selectSession(window, "Terminal host thread");
    await expect(window.getByTestId("integrated-terminal")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("J"));
    await expect(window.getByTestId("integrated-terminal")).toBeVisible();
    await expect(window.getByTestId("integrated-terminal").locator(".xterm-rows")).toContainText("PI_TERMINAL_OK", {
      timeout: 15_000,
    });

    await window.getByTestId("integrated-terminal").locator(".xterm").click();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("Shift+O"));
    await expect(window.getByTestId("new-thread-composer")).toHaveCount(0);
    await harness.electronApp.evaluate(({ clipboard, nativeImage }, pngBase64) => {
      clipboard.writeImage(nativeImage.createFromDataURL(`data:image/png;base64,${pngBase64}`));
    }, TINY_PNG_BASE64);
    await window.keyboard.press(desktopShortcut("V"));
    await expect.poll(async () => (await getDesktopState(window)).composerAttachments.length).toBe(0);

    await window.getByLabel("New terminal").click();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(2);
    await window.getByTestId("integrated-terminal").locator(".xterm").click();
    await window.keyboard.press(desktopShortcut("T"));
    await expect(window.getByTestId("terminal-tab")).toHaveCount(3);

    const beforeTakeover = await window.getByTestId("integrated-terminal").boundingBox();
    await window.getByLabel("Maximize terminal").click();
    await expect(window.getByTestId("integrated-terminal")).toHaveClass(/terminal-panel--takeover/);
    await expect(window.getByTestId("composer")).toHaveCount(0);
    const takeover = await window.getByTestId("integrated-terminal").boundingBox();
    expect(takeover?.height ?? 0).toBeGreaterThan(beforeTakeover?.height ?? 0);

    await window.getByLabel("Restore terminal").click();
    await expect(window.getByTestId("integrated-terminal")).not.toHaveClass(/terminal-panel--takeover/);
    await expect(window.getByTestId("composer")).toBeVisible();

    await window.getByLabel(/Close Terminal/).last().click();
    await expect(window.getByTestId("terminal-tab")).toHaveCount(2);
  } finally {
    await harness.close();
  }
});

test("opens the original pi TUI as a thread takeover", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-root");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI host thread");

    await window.getByLabel("Toggle pi TUI").click();
    const tui = window.getByTestId("pi-tui-terminal");
    await expect(tui).toBeVisible();
    await expect(tui).toHaveClass(/terminal-panel--takeover/);
    await expect(tui.locator(".terminal-panel__error")).toHaveCount(0);
    await expect(tui.locator(".xterm")).toBeVisible();
    await expect(tui.getByTestId("terminal-tab")).toContainText("pi TUI");
    await expect(window.getByTestId("composer")).toHaveCount(0);
    await expect(window.getByTestId("integrated-terminal")).toHaveCount(0);

    await window.getByRole("complementary").getByRole("button", { name: "New thread", exact: true }).click();
    const newThreadTui = window.getByTestId("pi-tui-terminal");
    await expect(newThreadTui).toBeVisible();
    await expect(newThreadTui).toHaveClass(/terminal-panel--takeover/);
    await expect(newThreadTui.locator(".terminal-panel__error")).toHaveCount(0);
    await expect(newThreadTui.locator(".xterm")).toBeVisible();
    await expect(window.getByLabel("New thread prompt")).toHaveCount(0);

    await newThreadTui.getByLabel("Hide terminal").click();
    await expect(window.getByLabel("New thread prompt")).toBeVisible();

    await createNamedThread(window, "pi TUI second host thread");
    await window.getByLabel("Toggle pi TUI").click();
    const secondTui = window.getByTestId("pi-tui-terminal");
    await expect(secondTui).toBeVisible();
    await expect(secondTui).toHaveClass(/terminal-panel--takeover/);
    await expect(secondTui.locator(".terminal-panel__error")).toHaveCount(0);
    await expect(secondTui.locator(".xterm")).toBeVisible();
    await expect(window.getByTestId("composer")).toHaveCount(0);

    await secondTui.getByLabel("Hide terminal").click();
    await expect(window.getByTestId("pi-tui-terminal")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("surfaces a pi TUI startup failure instead of leaving a blank cursor", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-startup-failure");
  const fakePiCliPath = join(userDataDir, "fake-pi-failure-cli.js");
  await writeFailingPiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "pi TUI failing host");
    await selectSession(window, "pi TUI failing host");

    const tui = window.getByTestId("pi-tui-terminal");
    if ((await tui.count()) === 0) {
      await window.getByLabel("Toggle pi TUI").click();
    }
    await expect(tui).toBeVisible();
    await expect(tui.locator(".terminal-panel__error")).toContainText("pi TUI exited before producing output", {
      timeout: 15_000,
    });
    await expect(tui.locator(".xterm")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("starts sidebar New thread pi TUI with an explicit fresh session id", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-new-thread-session-id");
  const fakePiCliPath = join(userDataDir, "fake-pi-argv-cli.js");
  await writeArgumentEchoPiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI argv host");
    const workspaceNewThreadButton = window.getByRole("button", {
      name: `New thread in ${basename(workspacePath)}`,
    });

    await window.getByLabel("Toggle pi TUI").click();
    let rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText("ARG_SESSION=", { timeout: 15_000 });
    await expect(rows).toContainText("ARG_SESSION_ID=<missing>", { timeout: 15_000 });

    await workspaceNewThreadButton.click();
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText("ARG_SESSION=<missing>", { timeout: 15_000 });
    await expect(rows).toContainText(/ARG_SESSION_ID=pi-gui-[0-9a-f]{24}/, { timeout: 15_000 });
    const firstNewSessionId = await readEchoedPiTuiSessionId(rows);
    await expect(window.getByTestId("pi-tui-terminal").getByTestId("terminal-tab")).toHaveCount(2);

    await workspaceNewThreadButton.click();
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    const secondNewSessionId = await readEchoedPiTuiSessionId(rows, { differentFrom: firstNewSessionId });
    expect(secondNewSessionId).not.toBe(firstNewSessionId);
    await expect(window.getByTestId("pi-tui-terminal").getByTestId("terminal-tab")).toHaveCount(3);
  } finally {
    await harness.close();
  }
});

test("shows sessions created by a running pi TUI in the sidebar", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-live-session-sync");
  const fakePiCliPath = join(userDataDir, "fake-pi-cli.js");
  await writeFakePiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI live sync host");

    await window.getByLabel("Toggle pi TUI").click();
    const tui = window.getByTestId("pi-tui-terminal");
    await expect(tui).toBeVisible();
    await expect(tui.locator(".xterm-rows")).toContainText("fake pi tui ready", { timeout: 15_000 });

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
        return workspace?.sessions.some((session) => session.title === "TUI live discovered thread") ?? false;
      }, { timeout: 15_000 })
      .toBe(true);

    await expect(window.locator(".session-row", { hasText: "TUI live discovered thread" })).toBeVisible();
    await expect(tui).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("refreshes model scope before launching the pi TUI", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspaceA = await makeWorkspace("pi-tui-scope-a");
  const workspaceB = await makeWorkspace("pi-tui-scope-b");
  const fakePiCliPath = join(userDataDir, "fake-pi-settings-cli.js");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({ "openai-codex": { type: "api_key", key: "test-codex-key" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.5"] }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(join(workspaceB, ".pi"), { recursive: true });
  await writeFile(
    join(workspaceB, ".pi", "settings.json"),
    `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.1", "openai-codex/gpt-5.5"] }, null, 2)}\n`,
    "utf8",
  );
  await writeSettingsEchoPiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspaceA, workspaceB],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspaceB);
    await createNamedThread(window, "pi TUI scoped settings host", { workspaceName: workspace.name });

    await window.getByLabel("Toggle pi TUI").click();
    const rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText("TUI_ENABLED_MODELS=openai-codex/gpt-5.5", { timeout: 15_000 });
    await expect(rows).not.toContainText("openai-codex/gpt-5.1");
  } finally {
    await harness.close();
  }
});

test("switches the pi TUI target when the selected thread changes", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-session-target");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI frozen thread");
    await createNamedThread(window, "pi TUI other thread");
    await selectSession(window, "pi TUI frozen thread");
    const frozenContext = await selectedSessionContext(window);

    await window.getByLabel("Toggle pi TUI").click();
    const tui = window.getByTestId("pi-tui-terminal");
    await expect(tui).toBeVisible();
    await expect(tui.locator(".xterm")).toBeVisible();
    await expect(tui).toHaveAttribute("data-session-id", frozenContext.sessionRef.sessionId);
    await expect(tui).toHaveAttribute(
      "data-terminal-scope-id",
      /^pi-tui-tabs:.*pi-tui-session-target.*$/,
    );
    await expect(tui.getByTestId("terminal-tab")).toHaveCount(1);

    await selectSession(window, "pi TUI other thread");
    const otherContext = await selectedSessionContext(window);
    await expect(window.locator(".topbar__session")).toHaveText("pi TUI other thread");
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible();
    await expect(window.getByTestId("pi-tui-terminal").locator(".xterm")).toBeVisible();
    await expect(window.getByTestId("pi-tui-terminal")).toHaveAttribute("data-session-id", otherContext.sessionRef.sessionId);
    await expect(window.getByTestId("pi-tui-terminal")).toHaveAttribute(
      "data-terminal-scope-id",
      /^pi-tui-tabs:.*pi-tui-session-target.*$/,
    );
    await expect(window.getByTestId("pi-tui-terminal").getByTestId("terminal-tab")).toHaveCount(2);

    await window.getByTestId("pi-tui-terminal").getByTestId("terminal-tab").first().click();
    await expect(window.locator(".topbar__session")).toHaveText("pi TUI frozen thread");
    await expect(window.getByTestId("pi-tui-terminal")).toHaveAttribute("data-session-id", frozenContext.sessionRef.sessionId);

    await tui.getByLabel("Hide terminal").click();
    await expect(window.getByTestId("pi-tui-terminal")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toBeVisible();

    await selectSession(window, "pi TUI frozen thread");
    await window.getByLabel("Toggle pi TUI").click();
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible();
    await expect(window.getByTestId("pi-tui-terminal").getByTestId("terminal-tab")).toHaveCount(2);
  } finally {
    await harness.close();
  }
});

test("reattaches a hidden pi TUI with live output when selecting its thread from the sidebar", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-hidden-reattach");
  const fakePiCliPath = join(userDataDir, "fake-streaming-pi-cli.js");
  await writeStreamingPiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI hidden reattach");
    const context = await selectedSessionContext(window);

    await window.getByLabel("Toggle pi TUI").click();
    let rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText(context.sessionRef.sessionId, { timeout: 15_000 });
    const tickBeforeHide = await waitForStreamingTickAbove(rows, context.sessionRef.sessionId, 0);

    await window.getByTestId("pi-tui-terminal").getByLabel("Hide terminal").click();
    await expect(window.getByTestId("pi-tui-terminal")).toHaveCount(0);
    await window.waitForTimeout(1_000);

    await selectSession(window, "pi TUI hidden reattach");
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible({ timeout: 15_000 });
    await expect(rows).toContainText(context.sessionRef.sessionId, { timeout: 15_000 });
    await waitForStreamingTickAbove(rows, context.sessionRef.sessionId, tickBeforeHide);
  } finally {
    await harness.close();
  }
});

test("reattaches an evicted pi TUI via background session IPC when selecting its thread from the sidebar", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-background-ipc");
  const fakePiCliPath = join(userDataDir, "fake-streaming-pi-cli.js");
  await writeStreamingPiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.evaluate(async () => {
      await window.piApp?.setTuiTabLimit(1);
    });
    await createNamedThread(window, "pi TUI background ipc first");
    const firstContext = await selectedSessionContext(window);
    await createNamedThread(window, "pi TUI background ipc second");

    await selectSession(window, "pi TUI background ipc first");
    await window.getByLabel("Toggle pi TUI").click();
    let rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText(firstContext.sessionRef.sessionId, { timeout: 15_000 });
    const tickBeforeEvict = await waitForStreamingTickAbove(rows, firstContext.sessionRef.sessionId, 0);

    await selectSession(window, "pi TUI background ipc second");
    const secondContext = await selectedSessionContext(window);
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText(secondContext.sessionRef.sessionId, { timeout: 15_000 });
    await expect(rows).not.toContainText(firstContext.sessionRef.sessionId, { timeout: 15_000 });

    await window.getByTestId("pi-tui-terminal").getByLabel("Hide terminal").click();
    await expect(window.getByTestId("pi-tui-terminal")).toHaveCount(0);

    await expect
      .poll(async () =>
        window.evaluate(async (sessionRef) => {
          const api = window.piApp;
          if (!api?.findBackgroundPiTuiSession) {
            return null;
          }
          return api.findBackgroundPiTuiSession(sessionRef.workspaceId, sessionRef.sessionId);
        }, firstContext.sessionRef),
      )
      .toMatchObject({
        sessionId: firstContext.sessionRef.sessionId,
        status: "running",
      });

    await window.waitForTimeout(1_000);
    await selectSession(window, "pi TUI background ipc first");
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible({ timeout: 15_000 });
    await expect(rows).toContainText(firstContext.sessionRef.sessionId, { timeout: 15_000 });
    await waitForStreamingTickAbove(rows, firstContext.sessionRef.sessionId, tickBeforeEvict);
  } finally {
    await harness.close();
  }
});

test("reattaches a background pi TUI with fresh replay when returning to its thread", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-reattach-replay");
  const fakePiCliPath = join(userDataDir, "fake-streaming-pi-cli.js");
  await writeStreamingPiCli(fakePiCliPath);

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_GUI_PI_CLI_PATH: fakePiCliPath,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI replay first");
    const firstContext = await selectedSessionContext(window);
    await createNamedThread(window, "pi TUI replay second");
    const secondContext = await selectedSessionContext(window);

    await selectSession(window, "pi TUI replay first");
    await window.getByLabel("Toggle pi TUI").click();
    let rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText(firstContext.sessionRef.sessionId, { timeout: 15_000 });
    await expect(rows).toContainText("STREAM_TICK", { timeout: 15_000 });
    const firstTickBeforeSwitch = await waitForStreamingTickAbove(rows, firstContext.sessionRef.sessionId, 0);

    await selectSession(window, "pi TUI replay second");
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(rows).toContainText(secondContext.sessionRef.sessionId, { timeout: 15_000 });
    await waitForStreamingTickAbove(rows, secondContext.sessionRef.sessionId, 0);

    await window.waitForTimeout(1_000);
    await selectSession(window, "pi TUI replay first");
    rows = window.getByTestId("pi-tui-terminal").locator(".xterm-rows");
    await expect(window.getByTestId("pi-tui-terminal")).toHaveAttribute("data-session-id", firstContext.sessionRef.sessionId);
    await expect(rows).toContainText(firstContext.sessionRef.sessionId, { timeout: 15_000 });
    await waitForStreamingTickAbove(rows, firstContext.sessionRef.sessionId, firstTickBeforeSwitch);
  } finally {
    await harness.close();
  }
});

test("closes the pi TUI instead of attaching to a running thread selected from the sidebar", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("pi-tui-running-target");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "pi TUI safe thread");
    await createNamedThread(window, "pi TUI running thread");

    await selectSession(window, "pi TUI running thread");
    await emitRunningSessionSnapshot(harness, window, "pi-tui-running-target");

    await selectSession(window, "pi TUI safe thread");
    await window.getByLabel("Toggle pi TUI").click();
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible();

    await selectSession(window, "pi TUI running thread");
    await expect(window.getByTestId("pi-tui-terminal")).toHaveCount(0);
    await expect(window.getByTestId("composer")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("persists the integrated terminal shell setting", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-settings");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    const shellInput = window.getByLabel("Shell of integrated terminal");
    await shellInput.fill("/bin/zsh");
    await shellInput.press("Enter");
    await expect.poll(async () => (await getDesktopState(window)).integratedTerminalShell).toBe("/bin/zsh");
  } finally {
    await harness.close();
  }
});

test("pastes clipboard text into the integrated terminal once", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("terminal-paste-once");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Terminal paste thread");

    await window.getByLabel("Toggle terminal").click();
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await expect(terminal.locator(".xterm-rows")).toContainText(
      new RegExp(`${escapeRegExp(basename(workspacePath))}|[#$%]\\s*$`),
      { timeout: 15_000 },
    );

    await harness.electronApp.evaluate(({ clipboard }) => {
      clipboard.writeText("PI_TERMINAL_PASTE_ONCE");
    });
    await window.keyboard.press(desktopShortcut("V"));

    await expect
      .poll(async () => countOccurrences((await terminal.locator(".xterm-rows").innerText()) ?? "", "PI_TERMINAL_PASTE_ONCE"))
      .toBe(1);
  } finally {
    await harness.close();
  }
});

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForStreamingTickAbove(
  rows: Locator,
  sessionId: string,
  minimumTick: number,
): Promise<number> {
  const tickPattern = new RegExp(`STREAM_TICK:${escapeRegExp(sessionId)}:(\\d+)`, "g");
  const deadline = Date.now() + 15_000;
  let lastTick = 0;
  while (Date.now() < deadline) {
    const text = await rows.innerText();
    for (const match of text.matchAll(tickPattern)) {
      lastTick = Math.max(lastTick, Number(match[1] ?? "0"));
    }
    if (lastTick > minimumTick) {
      return lastTick;
    }
    await rows.page().waitForTimeout(100);
  }
  expect(lastTick).toBeGreaterThan(minimumTick);
  return lastTick;
}

async function writeFakePiCli(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const cwd = resolve(process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  throw new Error("PI_CODING_AGENT_DIR is required");
}

const safePath = \`--\${cwd.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-")}--\`;
const sessionDir = join(agentDir, "sessions", safePath);
mkdirSync(sessionDir, { recursive: true });

const startedAt = Date.now();
const sessionId = \`tui-live-\${startedAt.toString(36)}\`;
const timestamp = new Date(startedAt).toISOString();
const sessionFile = join(sessionDir, \`\${timestamp.replace(/[:.]/g, "-")}_\${sessionId}.jsonl\`);
const entries = [
  { type: "session", version: 3, id: sessionId, timestamp, cwd },
  { type: "session_info", id: "session-name", parentId: null, timestamp, name: "TUI live discovered thread" },
  {
    type: "message",
    id: "user-message",
    parentId: "session-name",
    timestamp,
    message: { role: "user", content: "hello from a running tui", timestamp: startedAt },
  },
  {
    type: "message",
    id: "assistant-message",
    parentId: "user-message",
    timestamp: new Date(startedAt + 1_000).toISOString(),
    message: {
      role: "assistant",
      content: "live tui response",
      timestamp: startedAt + 1_000,
      provider: "openai",
      model: "gpt-5",
    },
  },
];
writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n", "utf8");
process.stdout.write("fake pi tui ready\\n");

const timer = setInterval(() => undefined, 1_000);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function writeArgumentEchoPiCli(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || "<empty>" : "<missing>";
}
process.stdout.write("ARG_SESSION=" + valueAfter("--session") + "\\n");
process.stdout.write("ARG_SESSION_ID=" + valueAfter("--session-id") + "\\n");
const timer = setInterval(() => undefined, 1_000);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function writeFailingPiCli(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
process.exit(1);
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function readEchoedPiTuiSessionId(
  rows: Locator,
  options: { readonly differentFrom?: string } = {},
): Promise<string> {
  const startedAt = Date.now();
  let lastSessionId = "";
  while (Date.now() - startedAt < 15_000) {
    const text = await rows.innerText().catch(() => "");
    const matches = [...text.matchAll(/ARG_SESSION_ID=(pi-gui-[0-9a-f]{24})/g)];
    const sessionId = matches.at(-1)?.[1] ?? "";
    if (sessionId && sessionId !== options.differentFrom) {
      return sessionId;
    }
    lastSessionId = sessionId || lastSessionId;
    await rows.page().waitForTimeout(100);
  }
  throw new Error(
    `Expected pi TUI session id echo${options.differentFrom ? ` different from ${options.differentFrom}` : ""}; last seen ${lastSessionId || "<missing>"}`,
  );
}

async function writeSettingsEchoPiCli(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

function readSettings(path) {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const agentDir = process.env.PI_CODING_AGENT_DIR;
const globalSettings = agentDir ? readSettings(join(agentDir, "settings.json")) : {};
const projectSettings = readSettings(join(process.cwd(), ".pi", "settings.json"));
const enabledModels = Array.isArray(projectSettings.enabledModels)
  ? projectSettings.enabledModels
  : Array.isArray(globalSettings.enabledModels)
    ? globalSettings.enabledModels
    : [];
process.stdout.write("TUI_ENABLED_MODELS=" + enabledModels.join(",") + "\\n");

const timer = setInterval(() => undefined, 1_000);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}

async function writeStreamingPiCli(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const { basename } = require("node:path");
const sessionArgIndex = process.argv.indexOf("--session");
const sessionArg = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] || "" : "";
const sessionFileName = basename(sessionArg);
const sessionIdMatch = sessionFileName.match(/([0-9a-f]{8,}[-0-9a-f]*|tui-[A-Za-z0-9_-]+)/);
const sessionId = sessionIdMatch ? sessionIdMatch[1] : sessionArg || "new-session";
process.stdout.write("STREAM_READY:" + sessionId + ":" + sessionArg + "\\n");
let tick = 0;
const timer = setInterval(() => {
  tick += 1;
  process.stdout.write("STREAM_TICK:" + sessionId + ":" + tick + "\\n");
}, 250);
process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
`,
    "utf8",
  );
  await chmod(filePath, 0o755);
}
