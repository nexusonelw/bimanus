import { expect, test } from "@playwright/test";
import { desktopShortcut, launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test.fixme("settings persists MCP enabled state", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mcp-settings-workspace");

  const firstHarness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await firstHarness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    const settingsNav = window.getByRole("navigation", { name: "Settings sections" }).getByRole("button");
    await settingsNav.nth(4).click();
    await expect(window.locator(".view-header__title")).toHaveText("MCP");

    await window.getByLabel("MCP server name").fill("Context7");
    await window.getByLabel("MCP server HTTP URL").fill("https://example.com/mcp");
    await window.getByRole("button", { name: "Add MCP server" }).click();

    const serverRow = window.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: "Context7" }),
    });
    await expect(serverRow).toContainText("Enabled");
    await serverRow.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(serverRow).toContainText("Disabled");
  } finally {
    await firstHarness.close();
  }

  const secondHarness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await secondHarness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    const settingsNav = window.getByRole("navigation", { name: "Settings sections" }).getByRole("button");
    await settingsNav.nth(4).click();
    const serverRow = window.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: "Context7" }),
    });
    await expect(serverRow).toContainText("Disabled");
    await serverRow.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(serverRow).toContainText("Enabled");
  } finally {
    await secondHarness.close();
  }
});
