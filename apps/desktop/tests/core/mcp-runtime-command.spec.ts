import { expect, test } from "@playwright/test";
import { createNamedThread, getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("injects MCP runtime commands into the slash menu", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mcp-runtime-command-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "MCP runtime command session");

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const sessionKey = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
        return (state.sessionCommandsBySession[sessionKey] ?? []).map((command) => command.name).sort();
      }, { timeout: 15_000 })
      .toContain("mcp");

    const composer = window.getByTestId("composer");
    await composer.fill("/mcp");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toContainText("Runtime Commands");
    await expect(slashMenu).toContainText("/mcp");
    await expect(slashMenu).toContainText("/mcp:start");
    await expect(slashMenu).toContainText("/mcp:disable");
  } finally {
    await harness.close();
  }
});
