import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  spawnDesktopProcess,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("ignores persisted multiple app instance opt-in and hides the setting", async () => {
  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), `${JSON.stringify({ allowMultiple: true }, null, 2)}\n`, "utf8");
  const workspacePath = await makeWorkspace("allow-multiple-instances-disabled");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let secondProcess: ChildProcess | undefined;

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await expect.poll(async () => harness.electronApp.evaluate(({ app }) => app.hasSingleInstanceLock())).toBe(true);
    secondProcess = await spawnDesktopProcess(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
    });
    await expect(await waitForProcessExit(secondProcess)).toEqual({ code: 0, signal: null });
    await expect
      .poll(async () => harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(1);
    await expect
      .poll(async () => {
        const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as {
          readonly allowMultiple?: unknown;
        };
        return persisted.allowMultiple;
      })
      .toBeUndefined();

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    await expect(window.getByLabel("Shell of integrated terminal")).toBeVisible();
    await expect(window.getByText("Allow multiple app instances")).toHaveCount(0);
    await expect(window.getByLabel("Allow multiple app instances")).toHaveCount(0);
  } finally {
    if (secondProcess && secondProcess.exitCode === null && secondProcess.signalCode === null) {
      secondProcess.kill();
    }
    await harness.close();
  }
});

test("persists the configurable TUI tab limit from General settings", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("tui-tab-limit-setting");
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

    const tuiTabLimitInput = window.getByLabel("Maximum TUI tabs");
    await expect(tuiTabLimitInput).toHaveValue("20");
    await tuiTabLimitInput.fill("12");
    await tuiTabLimitInput.press("Enter");
    await expect
      .poll(async () => {
        const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as {
          readonly tuiTabLimit?: unknown;
        };
        return persisted.tuiTabLimit;
      })
      .toBe(12);
  } finally {
    await harness.close();
  }
});

test("starts in TUI mode and persists chat mode changes", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("default-chat-mode-setting");
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    const startupState = await window.evaluate(async () => {
      const app = (window as Window & { piApp?: { getState(): Promise<unknown> } }).piApp;
      return app ? app.getState() : null;
    });
    expect((startupState as { readonly defaultChatMode?: unknown } | null)?.defaultChatMode).toBe("tui");
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible();

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();

    const defaultChatModeSelect = window.getByLabel("Default chat mode");
    await expect(defaultChatModeSelect).toHaveValue("tui");
    await window.evaluate(async () => {
      const app = (window as Window & { piApp?: { setDefaultChatMode?: (mode: string) => Promise<unknown> } }).piApp;
      if (!app?.setDefaultChatMode) {
        throw new Error("Desktop API is unavailable");
      }
      await app.setDefaultChatMode("normal");
    });
    await expect(defaultChatModeSelect).toHaveValue("normal");
    await expect
      .poll(async () => {
        const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as {
          readonly defaultChatMode?: unknown;
        };
        return persisted.defaultChatMode;
      })
      .toBe("normal");
    await window.getByRole("button", { name: "Back to app" }).click();
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();

    await expect(window.getByLabel("Default chat mode")).toHaveValue("normal");
    await window.getByRole("button", { name: "Back to app" }).click();

    await createNamedThread(window, "Default chat mode thread");
    await expect(window.getByTestId("composer")).toBeVisible();

    await window.getByLabel("Toggle pi TUI").click();
    await expect(window.getByTestId("pi-tui-terminal")).toBeVisible();
  } finally {
    await harness.close();
  }
});

async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for second app process to exit")), timeoutMs);
      }),
    ]);
    const [code, signal] = result as [number | null, NodeJS.Signals | null];
    return { code, signal };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
