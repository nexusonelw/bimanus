import type { MouseEvent as ReactMouseEvent, Dispatch, ReactNode, SetStateAction } from "react";
import type { AppView, DesktopAppState, SessionRecord, WorkspaceRecord, WorktreeRecord } from "./desktop-state";
import { DiffIcon, SparkIcon, SplitPanelIcon, TerminalIcon } from "./icons";
import { getDesktopShortcutLabel, type PiDesktopApi } from "./ipc";
import type { WorkspaceMenuState } from "./hooks/use-workspace-menu";
import { SidebarToggleButton } from "./sidebar-toggle-button";
import { useI18n } from "./i18n";

interface TopbarProps {
  readonly activeView: AppView;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly selectedSessionTitle: string | undefined;
  readonly selectedWorktree: WorktreeRecord | undefined;
  readonly activeWorktrees: readonly WorktreeRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly terminalAvailable: boolean;
  readonly terminalVisible: boolean;
  readonly onToggleTerminal: () => void;
  readonly showDiffPanel: boolean;
  readonly onToggleDiffPanel: () => void;
  readonly showSystemPromptPanel: boolean;
  readonly onToggleSystemPromptPanel: () => void;
  readonly showSplitPanel: boolean;
  readonly onToggleSplitPanel: () => void;
  readonly sidebarToggleVisible: boolean;
  readonly sidebarToggleShortcutLabel: string;
  readonly onToggleSidebar: () => void;
}

interface HeaderActionsProps {
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly terminalAvailable: boolean;
  readonly terminalVisible: boolean;
  readonly onToggleTerminal: () => void;
  readonly showDiffPanel: boolean;
  readonly onToggleDiffPanel: () => void;
  readonly showSystemPromptPanel: boolean;
  readonly onToggleSystemPromptPanel: () => void;
  readonly showSplitPanel: boolean;
  readonly onToggleSplitPanel: () => void;
  readonly buttonClassName?: string;
  readonly tooltipClassName?: string;
  /**
   * When "menu", renders each action as a full-width dropdown-style row
   * (icon + label + shortcut) instead of the default icon-button + tooltip.
   * This ensures the entire row is a single clickable button with a large
   * tap target — critical for mobile dropdown menus.
   */
  readonly variant?: "toolbar" | "menu";
}

export function HeaderActions(props: HeaderActionsProps): ReactNode {
  const {
    api,
    terminalAvailable,
    terminalVisible,
    onToggleTerminal,
    showDiffPanel,
    onToggleDiffPanel,
    showSystemPromptPanel,
    onToggleSystemPromptPanel,
    showSplitPanel,
    onToggleSplitPanel,
    buttonClassName = "topbar__icon",
    tooltipClassName = "topbar__tooltip",
    variant = "toolbar",
  } = props;
  const { t } = useI18n();
  const terminalShortcut = getDesktopShortcutLabel(api.platform, "J");
  const diffShortcut = getDesktopShortcutLabel(api.platform, "D");
  const splitPanelShortcut = `${api.platform === "darwin" ? "⇧⌘" : "Ctrl+Shift+"}P`;

  if (variant === "menu") {
    return (
      <>
        <button
          type="button"
          className="terminal-panel__dropdown-item header-action-menu-item"
          aria-label={t("topbar.toggleTerminal")}
          disabled={!terminalAvailable}
          onClick={onToggleTerminal}
        >
          <TerminalIcon />
          <span>{t("topbar.toggleTerminal")}</span>
          <kbd className="header-action-menu-item__kbd">{terminalShortcut}</kbd>
        </button>
        <button
          type="button"
          className="terminal-panel__dropdown-item header-action-menu-item"
          aria-label={t("topbar.toggleChanges")}
          onClick={onToggleDiffPanel}
        >
          <DiffIcon />
          <span>{t("topbar.toggleChanges")}</span>
          <kbd className="header-action-menu-item__kbd">{diffShortcut}</kbd>
        </button>
        <button
          type="button"
          className="terminal-panel__dropdown-item header-action-menu-item"
          aria-label={t("topbar.toggleSystemPrompt")}
          onClick={onToggleSystemPromptPanel}
        >
          <SparkIcon />
          <span>{t("topbar.systemPrompt")}</span>
        </button>
        <button
          type="button"
          className="terminal-panel__dropdown-item header-action-menu-item"
          aria-label={t("topbar.toggleCliSplitPanel")}
          onClick={onToggleSplitPanel}
        >
          <SplitPanelIcon />
          <span>{t("topbar.toggleCliSplitPanel")}</span>
          <kbd className="header-action-menu-item__kbd">{splitPanelShortcut}</kbd>
        </button>
      </>
    );
  }

  return (
    <>
      <div className="shortcut-tooltip-wrap">
        <button
          aria-label={t("topbar.toggleTerminal")}
          className={`icon-button ${buttonClassName} ${terminalVisible ? "icon-button--active" : ""}`}
          type="button"
          disabled={!terminalAvailable}
          onClick={onToggleTerminal}
        >
          <TerminalIcon />
        </button>
        <span className={`shortcut-tooltip ${tooltipClassName}`} role="tooltip">
          <span>{t("topbar.toggleTerminal")}</span>
          <kbd>{terminalShortcut}</kbd>
        </span>
      </div>
      <div className="shortcut-tooltip-wrap">
        <button
          aria-label={t("topbar.toggleChanges")}
          className={`icon-button ${buttonClassName} ${showDiffPanel ? "icon-button--active" : ""}`}
          type="button"
          onClick={onToggleDiffPanel}
        >
          <DiffIcon />
        </button>
        <span className={`shortcut-tooltip ${tooltipClassName}`} role="tooltip">
          <span>{t("topbar.toggleChanges")}</span>
          <kbd>{diffShortcut}</kbd>
        </span>
      </div>
      <div className="shortcut-tooltip-wrap">
        <button
          aria-label={t("topbar.toggleSystemPrompt")}
          className={`icon-button ${buttonClassName} ${showSystemPromptPanel ? "icon-button--active" : ""}`}
          type="button"
          onClick={onToggleSystemPromptPanel}
        >
          <SparkIcon />
        </button>
        <span className={`shortcut-tooltip ${tooltipClassName}`} role="tooltip">
          <span>{t("topbar.systemPrompt")}</span>
        </span>
      </div>
      <div className="shortcut-tooltip-wrap">
        <button
          aria-label={t("topbar.toggleCliSplitPanel")}
          className={`icon-button ${buttonClassName} ${showSplitPanel ? "icon-button--active" : ""}`}
          type="button"
          onClick={onToggleSplitPanel}
        >
          <SplitPanelIcon />
        </button>
        <span className={`shortcut-tooltip ${tooltipClassName}`} role="tooltip">
          <span>{t("topbar.toggleCliSplitPanel")}</span>
          <kbd>{splitPanelShortcut}</kbd>
        </span>
      </div>
    </>
  );
}

export function Topbar(props: TopbarProps) {
  const {
    activeView,
    rootWorkspace,
    selectedWorkspace,
    selectedSession,
    selectedSessionTitle,
    selectedWorktree,
    activeWorktrees,
    workspaces,
    wsMenu,
    api,
    setSnapshot,
    updateSnapshot,
    terminalAvailable,
    terminalVisible,
    onToggleTerminal,
    showDiffPanel,
    onToggleDiffPanel,
    showSystemPromptPanel,
    onToggleSystemPromptPanel,
    showSplitPanel,
    onToggleSplitPanel,
    sidebarToggleVisible,
    sidebarToggleShortcutLabel,
    onToggleSidebar,
  } = props;

  const { t } = useI18n();

  const handleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.closest(".topbar__actions, .topbar__interactive")) {
      return;
    }

    void api.toggleWindowMaximize();
  };

  return (
    <header className={`topbar ${sidebarToggleVisible ? "topbar--with-toggle" : ""}`} data-testid="topbar" onDoubleClick={handleDoubleClick}>
      <div className="topbar__title">
        {sidebarToggleVisible ? (
          <SidebarToggleButton
            className="sidebar-toggle--topbar topbar__interactive"
            collapsed
            shortcutLabel={sidebarToggleShortcutLabel}
            onToggle={onToggleSidebar}
          />
        ) : null}
        <span className="topbar__workspace">
          {rootWorkspace ? rootWorkspace.name : t("topbar.openFolderToBegin")}
        </span>
        {selectedWorkspace && activeView === "threads" ? (
          <>
            <span className="topbar__separator">/</span>
            <div className="environment-picker topbar__interactive" ref={wsMenu.environmentMenuRef}>
              <button
                aria-expanded={wsMenu.environmentMenuOpen}
                aria-haspopup="menu"
                className="environment-picker__button"
                type="button"
                onClick={() => wsMenu.setEnvironmentMenuOpen((current) => !current)}
              >
                {selectedWorkspace.kind === "worktree" ? selectedWorktree?.name ?? selectedWorkspace.name : t("topbar.local")}
              </button>
              {wsMenu.environmentMenuOpen && rootWorkspace ? (
                <div className="workspace-menu environment-picker__menu">
                  <button
                    className="workspace-menu__item"
                    type="button"
                    onClick={() => wsMenu.selectWorkspace(rootWorkspace.id)}
                  >
                    {t("topbar.local")}
                  </button>
                  {activeWorktrees.map((worktree) => {
                    const linkedWorkspace = workspaces.find(
                      (workspace) => workspace.id === worktree.linkedWorkspaceId,
                    );
                    const worktreeSelectable = Boolean(linkedWorkspace) && worktree.status === "ready";
                    return (
                      <button
                        className="workspace-menu__item"
                        key={worktree.id}
                        type="button"
                        disabled={!worktreeSelectable}
                        onClick={() => {
                          if (worktreeSelectable && linkedWorkspace) {
                            wsMenu.selectWorkspace(linkedWorkspace.id);
                          }
                        }}
                      >
                        {worktree.name}
                        {!worktreeSelectable ? ` (${worktree.status !== "ready" ? worktree.status : t("topbar.unavailable")})` : ""}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {selectedWorkspace && activeView === "threads" && selectedSession ? (
          <>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">{selectedSessionTitle ?? selectedSession.title}</span>
          </>
        ) : activeView === "new-thread" && rootWorkspace ? (
          <>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">{t("topbar.newThread")}</span>
          </>
        ) : null}
      </div>

      <div className="topbar__actions">
        <HeaderActions
          api={api}
          setSnapshot={setSnapshot}
          updateSnapshot={updateSnapshot}
          terminalAvailable={terminalAvailable}
          terminalVisible={terminalVisible}
          onToggleTerminal={onToggleTerminal}
          showDiffPanel={showDiffPanel}
          onToggleDiffPanel={onToggleDiffPanel}
          showSystemPromptPanel={showSystemPromptPanel}
          onToggleSystemPromptPanel={onToggleSystemPromptPanel}
          showSplitPanel={showSplitPanel}
          onToggleSplitPanel={onToggleSplitPanel}
        />
      </div>
    </header>
  );
}
