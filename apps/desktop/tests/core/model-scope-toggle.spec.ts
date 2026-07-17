import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  commitAllInGitRepo,
  desktopShortcut,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
  startThreadFromSurface,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("keeps model settings global across workspaces and worktrees", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspaceA = await makeWorkspace("model-scope-a");
  const workspaceB = await makeWorkspace("model-scope-b");
  await initGitRepo(workspaceA);
  await commitAllInGitRepo(workspaceA, "init");
  await seedAgentDir(agentDir);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspaceA, workspaceB],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const rootWorkspaceA = await waitForWorkspaceByPath(window, workspaceA);
    const rootWorkspaceB = await waitForWorkspaceByPath(window, workspaceB);

    await createNamedThread(window, "Repo A global session", { workspaceName: rootWorkspaceA.name });
    await expect(window.locator(".topbar__session")).toHaveText("Repo A global session");
    await expectComposerModelState(window, {
      activeModel: "openai:gpt-5",
      visibleModelLabels: ["GPT-5", "GPT-4o"],
      hiddenModelLabels: ["GPT-4 Turbo"],
    });

    await createNamedThread(window, "Repo B global session", { workspaceName: rootWorkspaceB.name });
    await expect(window.locator(".topbar__session")).toHaveText("Repo B global session");
    await expectComposerModelState(window, {
      activeModel: "openai:gpt-5",
      visibleModelLabels: ["GPT-5", "GPT-4o"],
      hiddenModelLabels: ["GPT-4 Turbo"],
    });

    await openSettings(window);
    await openSettingsSection(window, "General");
    await expect(window.getByText("Model settings scope", { exact: true })).toHaveCount(0);

    await openSettingsSection(window, "Models");
    await expect(window.locator(".surface-toolbar__field")).toHaveCount(0);
    await expect(window.locator(".settings-select")).toHaveValue("openai:gpt-5");
    await setEnabledModels(window, ["openai/gpt-4o", "openai/gpt-4-turbo"], ["openai/gpt-5"]);
    await window.locator(".settings-select").selectOption("openai:gpt-4o");
    await expect(window.locator(".settings-select")).toHaveValue("openai:gpt-4o");
    await expect.poll(async () => {
      const state = await getDesktopState(window);
      return JSON.stringify({
        defaultProvider: state.globalModelSettings.defaultProvider,
        defaultModelId: state.globalModelSettings.defaultModelId,
        enabledModelPatterns: [...state.globalModelSettings.enabledModelPatterns].sort(),
      });
    }).toBe(JSON.stringify({
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      enabledModelPatterns: ["openai/gpt-4-turbo", "openai/gpt-4o"],
    }));

    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await createNamedThread(window, "Repo A updated global session", { workspaceName: rootWorkspaceA.name });
    await expectComposerModelState(window, {
      activeModel: "openai:gpt-4o",
      visibleModelLabels: ["GPT-4o"],
      hiddenModelLabels: [],
    });

    await createNamedThread(window, "Repo B updated global session", { workspaceName: rootWorkspaceB.name });
    await expectComposerModelState(window, {
      activeModel: "openai:gpt-4o",
      visibleModelLabels: ["GPT-4o"],
      hiddenModelLabels: [],
    });

    await startThreadFromSurface(window, {
      workspaceName: rootWorkspaceA.name,
      environment: "worktree",
      prompt: "Repo A worktree session",
    });
    await expect(window.locator(".topbar__session")).toHaveText("New thread");
    await expectComposerModelState(window, {
      activeModel: "openai:gpt-4o",
      visibleModelLabels: ["GPT-4o"],
      hiddenModelLabels: [],
    });

    await openNewThread(window);
    await expect(window.locator(".new-thread__workspace")).toHaveValue(rootWorkspaceA.id);
    await expectNewThreadModelState(window, {
      activeModel: "openai:gpt-4o",
      visibleModelLabels: ["GPT-4o"],
      hiddenModelLabels: [],
    });
    await window.locator(".session-row--active .session-row__select").first().click();
    await expect(window.getByTestId("new-thread-composer")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

async function openSettings(window: Page, section?: "General" | "Models"): Promise<void> {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  if (section) {
    await openSettingsSection(window, section);
  }
}

async function openSettingsSection(window: Page, section: "General" | "Models"): Promise<void> {
  await window.getByRole("button", { name: section, exact: true }).click();
  await expect(window.locator(".view-header__title")).toContainText(section);
}

async function ensureEnabledModelsDisclosureOpen(window: Page): Promise<void> {
  const disclosure = window.locator(".settings-disclosure", {
    has: window.locator(".settings-disclosure__summary", { hasText: "Edit enabled models" }),
  }).first();
  const detailsOpen = await disclosure.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!detailsOpen) {
    await disclosure.locator(".settings-disclosure__summary").click();
  }
  await expect(window.getByLabel("Search enabled models")).toBeVisible();
}

async function setEnabledModel(window: Page, pattern: string, enabled: boolean): Promise<void> {
  await ensureEnabledModelsDisclosureOpen(window);
  const [, modelId = pattern] = pattern.split("/");
  const searchInput = window.getByLabel("Search enabled models");
  await searchInput.fill(modelId);
  const row = window.locator("label.settings-toggle", {
    hasText: new RegExp(`${escapeForRegExp(pattern)}\\s*$`),
  }).first();
  await expect(row).toBeVisible();
  const checkbox = row.locator("input[type='checkbox']");
  if ((await checkbox.isChecked()) !== enabled) {
    await checkbox.click();
  }
  await expect.poll(async () => checkbox.isChecked()).toBe(enabled);
  await searchInput.fill("");
}

async function setEnabledModels(window: Page, enable: readonly string[], disable: readonly string[]): Promise<void> {
  for (const pattern of enable) {
    await setEnabledModel(window, pattern, true);
  }
  for (const pattern of disable) {
    await setEnabledModel(window, pattern, false);
  }
}

async function expectComposerModelState(
  window: Page,
  expectations: {
    readonly activeModel: string;
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  await expect(window.getByRole("button", { name: expectations.activeModel }).first()).toBeVisible();
  await expectModelOptions(window, ".composer__bar", expectations);
}

async function expectNewThreadModelState(
  window: Page,
  expectations: {
    readonly activeModel: string;
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  await expect(window.getByRole("button", { name: expectations.activeModel }).first()).toBeVisible();
  await expectModelOptions(window, ".new-thread__hint", expectations);
}

async function expectModelOptions(
  window: Page,
  scopeSelector: string,
  expectations: {
    readonly visibleModelLabels: readonly string[];
    readonly hiddenModelLabels: readonly string[];
  },
): Promise<void> {
  const trigger = window.locator(`${scopeSelector} .model-selector__badge`).first();
  await trigger.click();
  const menu = window.locator(`${scopeSelector} .model-selector__dropdown`).first();
  await expect(menu).toBeVisible();
  for (const label of expectations.visibleModelLabels) {
    await expect(menu).toContainText(label);
  }
  for (const label of expectations.hiddenModelLabels) {
    await expect(menu).not.toContainText(label);
  }
  await trigger.click();
  await expect(menu).toBeHidden();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
