import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("browses a workspace tree with the first folder level expanded", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("file-manager-workspace");
  await mkdir(join(workspacePath, "src", "nested"), { recursive: true });
  await mkdir(join(workspacePath, "empty"), { recursive: true });
  await mkdir(join(workspacePath, ".cache"), { recursive: true });
  await mkdir(join(workspacePath, "node_modules", "example-package"), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Files\n");
  await writeFile(join(workspacePath, "src", "app.ts"), "export {};\n");
  await writeFile(join(workspacePath, "src", "nested", "deep.ts"), "export {};\n");
  await writeFile(join(workspacePath, ".cache", "state.json"), "{}\n");
  await writeFile(join(workspacePath, "node_modules", "example-package", "index.js"), "module.exports = {};\n");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await window.getByLabel("Toggle file manager").click();
    const panel = window.getByTestId("file-manager-panel");
    await expect(panel).toBeVisible();

    await expect(window.getByTestId("file-manager-directory-src")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(window.getByTestId("file-manager-directory-empty")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(window.getByTestId("file-manager-directory-.cache")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(window.getByTestId("file-manager-directory-node_modules")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(window.getByTestId("file-manager-file-src/app.ts")).toBeVisible();
    await expect(window.getByTestId("file-manager-directory-src/nested")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(window.getByTestId("file-manager-file-src/nested/deep.ts")).toHaveCount(0);

    await window.getByTestId("file-manager-select-directory-src").check();
    await expect(window.getByTestId("file-manager-select-src/app.ts")).toBeChecked();
    await window.getByLabel("Expand src/nested").click();
    await expect(window.getByTestId("file-manager-select-src/nested/deep.ts")).toBeChecked();

    await window.getByTestId("file-manager-select-README.md").check();
    await window.getByTestId("file-manager-select-src/app.ts").check();
    await window.getByTestId("file-manager-file-src/app.ts").click({ button: "right" });
    await expect(window.getByTestId("file-manager-copy-paths")).toBeVisible();
    await expect(window.getByTestId("file-manager-copy-paths")).toContainText(
      "Copy selected file paths",
    );
    await window.getByTestId("file-manager-copy-paths").click();
    await expect(panel.getByRole("status")).toHaveText("Selected file paths copied.");

    await window.getByLabel("Toggle changes").click();
    await expect(window.locator(".diff-panel")).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(window.locator(".shell")).toHaveClass(/shell--with-diff-panel/);
    await expect(window.locator(".shell")).toHaveClass(/shell--with-file-manager/);
  } finally {
    await harness.close();
  }
});

test("opens a text file in the preview panel and restores it after toggling", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("file-preview-workspace");
  await writeFile(join(workspacePath, "notes.txt"), "Previewed text.\n");
  await writeFile(join(workspacePath, "second.txt"), "Second file text.\n");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);

    await window.getByLabel("Toggle file manager").click();
    await window.getByTestId("file-manager-file-notes.txt").click();

    const previewPanel = window.getByTestId("file-preview-panel");
    await expect(previewPanel).toBeVisible();
    await expect(previewPanel.locator(".file-preview-panel__path")).toHaveText("notes.txt");
    await expect(previewPanel.locator(".file-preview-panel__editor .monaco-editor")).toBeVisible();

    await window.getByTestId("file-manager-file-second.txt").click();
    await expect(previewPanel.locator(".file-preview-panel__path")).toHaveText("second.txt");
    await expect(previewPanel.locator(".file-preview-panel__editor .monaco-editor")).toBeVisible();

    await window.getByLabel("Toggle file preview").click();
    await expect(previewPanel).toBeHidden();

    await window.getByLabel("Toggle file preview").click();
    await expect(previewPanel.locator(".file-preview-panel__path")).toHaveText("second.txt");
    await expect(previewPanel.locator(".file-preview-panel__editor .monaco-editor")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("follows the active Git workspace and restores its expanded tree", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspaceA = await makeWorkspace("file-manager-state-a");
  const workspaceB = await makeWorkspace("file-manager-state-b");
  await mkdir(join(workspaceA, "src", "nested"), { recursive: true });
  await writeFile(join(workspaceA, "src", "nested", "deep.ts"), "export {};\n");
  await writeFile(join(workspaceB, "other.ts"), "export {};\n");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspaceA, workspaceB],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspaceA);
    await waitForWorkspaceByPath(window, workspaceB);

    await window.getByRole("button", {
      name: "New thread in " + basename(workspaceA),
    }).click();
    await window.getByLabel("Toggle file manager").click();
    const panel = window.getByTestId("file-manager-panel");
    await expect(panel.locator(".file-manager-panel__workspace")).toHaveText(basename(workspaceA));
    await window.getByLabel("Expand src/nested").click();
    await expect(window.getByTestId("file-manager-directory-src/nested")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(window.getByTestId("file-manager-file-src/nested/deep.ts")).toBeVisible();

    await window.getByRole("button", {
      name: "New thread in " + basename(workspaceB),
    }).click();
    await expect(panel.locator(".file-manager-panel__workspace")).toHaveText(basename(workspaceB));
    await expect(window.getByTestId("file-manager-file-other.ts")).toBeVisible();

    await window.getByRole("button", {
      name: "New thread in " + basename(workspaceA),
    }).click();
    await expect(panel.locator(".file-manager-panel__workspace")).toHaveText(basename(workspaceA));
    await expect(window.getByTestId("file-manager-directory-src/nested")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(window.getByTestId("file-manager-file-src/nested/deep.ts")).toBeVisible();
  } finally {
    await harness.close();
  }
});
