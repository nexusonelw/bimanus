import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type CDPSession } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace, waitForWorkspaceByPath } from "../helpers/electron-app";

test("scrolls a mobile TUI vertically and pages to the CLI split horizontally", async () => {
  test.setTimeout(90_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mobile-terminal-gestures");
  const fakePiCliPath = join(userDataDir, "fake-mobile-scroll-cli.js");
  await writeFile(fakePiCliPath, `#!/usr/bin/env node
for (let index = 0; index < 400; index += 1) process.stdout.write(\`MOBILE_SCROLL_\${index}\\r\\n\`);
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(fakePiCliPath, 0o755);

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
    await window.setViewportSize({ width: 390, height: 844 });
    await waitForWorkspaceByPath(window, workspacePath);
    await window.getByTestId("sidebar-toggle").click();

    const tui = window.getByTestId("pi-tui-terminal");
    const viewport = tui.locator(".terminal-panel__viewport");
    const scrollThumb = tui.locator(".xterm-scrollable-element > .scrollbar.vertical > .slider");
    await expect(tui).toBeVisible();
    await expect(scrollThumb).toHaveCount(1);

    await expect.poll(() => scrollThumb.evaluate((element) => parseFloat((element as HTMLElement).style.top))).toBeGreaterThan(0);
    const before = await scrollThumb.evaluate((element) => parseFloat((element as HTMLElement).style.top));
    const box = await viewport.boundingBox();
    if (!box) throw new Error("Expected a visible terminal viewport");
    const x = box.x + box.width / 2;
    const client = await window.context().newCDPSession(window);
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await swipe(client, { x, y: box.y + 100 }, { x, y: box.y + box.height - 80 });
    await expect.poll(() => scrollThumb.evaluate((element) => parseFloat((element as HTMLElement).style.top))).toBeLessThan(before);

    await tui.getByLabel("More actions").click();
    await tui.getByLabel("Toggle CLI split panel").click();
    const shell = window.locator(".shell");
    await expect(shell).toHaveClass(/shell--with-split-panel/);

    await swipe(
      client,
      { x: box.x + box.width * 0.8, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.2, y: box.y + box.height / 2 },
    );
    await expect.poll(() => shell.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
    await client.detach();
  } finally {
    await harness.close();
  }
});

async function swipe(client: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let step = 1; step <= 8; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: from.x + (to.x - from.x) * step / 8,
        y: from.y + (to.y - from.y) * step / 8,
      }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
