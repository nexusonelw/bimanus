import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AppView, SessionRecord, WorkspaceRecord, WorktreeRecord } from "./desktop-state";
import { ChevronDownIcon, ExtensionIcon, FolderIcon, PlusIcon, SettingsIcon, SkillIcon } from "./icons";
import type { PiDesktopApi } from "./ipc";
import type { WorkspaceMenuState } from "./hooks/use-workspace-menu";
import { useSidebarResize } from "./hooks/use-sidebar-resize";
import type { ThreadGroup, ThreadListEntry } from "./thread-groups";
import type { Dispatch, SetStateAction } from "react";
import type { DesktopAppState } from "./desktop-state";
import { isElectronHost } from "./platform-env";
import { logoutRemoteUi } from "./remote-client";
import { SidebarToggleButton } from "./sidebar-toggle-button";
import { useI18n } from "./i18n";

const MAX_VISIBLE_SESSIONS = 6;

interface SidebarProps {
  readonly activeView: AppView;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly threadGroups: readonly ThreadGroup[];
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
  readonly onNewThread: () => void;
  readonly onNewThreadForWorkspace: (workspaceId: string) => void;
  readonly onSetActiveView: (view: AppView) => void;
  readonly onOpenSkills: (workspaceId?: string) => void;
  readonly onOpenExtensions: (workspaceId?: string) => void;
  readonly onOpenSettings: (workspaceId?: string) => void;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly sidebarWidth: number;
  readonly onSidebarWidthChange: (width: number) => void;
  readonly onSidebarWidthCommit: (width: number) => void;
  readonly sidebarToggleVisible?: boolean;
  readonly sidebarToggleShortcutLabel?: string;
  readonly onToggleSidebar?: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    activeView,
    selectedWorkspace,
    selectedSession,
    visibleWorkspaces,
    threadGroups,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    setSnapshot,
    updateSnapshot,
    onNewThread,
    onNewThreadForWorkspace,
    onSetActiveView,
    onOpenSkills,
    onOpenExtensions,
    onOpenSettings,
    onArchiveSession,
    onSelectSession,
    onUnarchiveSession,
    sidebarWidth,
    onSidebarWidthChange,
    onSidebarWidthCommit,
    sidebarToggleVisible,
    sidebarToggleShortcutLabel,
    onToggleSidebar,
  } = props;

  const { t } = useI18n();
  const { startResize, isResizing } = useSidebarResize({
    width: sidebarWidth,
    onWidthChange: onSidebarWidthChange,
    onWidthCommit: onSidebarWidthCommit,
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Collision detection based on workspace row headers only (~30px top of each group),
  // not the full group height including all sessions.
  const headerCollision: CollisionDetection = (args) => {
    const pointerY = args.pointerCoordinates?.y;
    if (pointerY == null) return [];

    let closest: { id: string; distance: number } | null = null;
    for (const container of args.droppableContainers) {
      const rect = container.rect.current;
      if (!rect) continue;
      const headerCenter = rect.top + 15; // center of the ~30px workspace row header
      const distance = Math.abs(pointerY - headerCenter);
      if (!closest || distance < closest.distance) {
        closest = { id: String(container.id), distance };
      }
    }
    return closest ? [{ id: closest.id, data: { droppableContainer: args.droppableContainers.find((c) => String(c.id) === closest!.id)! } }] : [];
  };

  const rootGroups = threadGroups.filter((g) => g.rootWorkspace.kind === "primary");
  const orphanGroups = threadGroups.filter((g) => g.rootWorkspace.kind !== "primary");
  const rootGroupIds = rootGroups.map((g) => g.rootWorkspace.id);
  const canDrag = rootGroups.length > 1;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = rootGroupIds.indexOf(String(active.id));
    const newIndex = rootGroupIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const newOrder = arrayMove(rootGroupIds, oldIndex, newIndex);
    // Optimistically update local state to avoid snap-back animation
    setSnapshot((prev) => prev ? { ...prev, workspaceOrder: newOrder } : prev);
    void api.reorderWorkspaces(newOrder);
  }

  const activeGroup = activeId ? rootGroups.find((g) => g.rootWorkspace.id === activeId) : undefined;
  const showSidebarToggle = Boolean(sidebarToggleVisible && onToggleSidebar);

  return (
    <aside className="sidebar">
      {showSidebarToggle ? (
        <SidebarToggleButton
          className="sidebar-toggle--sidebar"
          collapsed={false}
          shortcutLabel={sidebarToggleShortcutLabel ?? ""}
          onToggle={onToggleSidebar!}
        />
      ) : null}
      <div className="sidebar__top">
        <button
          className="sidebar__new"
          type="button"
          disabled={!selectedWorkspace}
          onClick={onNewThread}
        >
          <PlusIcon />
          <span>{t("sidebar.newThread")}</span>
        </button>

        <div className="sidebar__nav">
          <button
            className={`sidebar__nav-item ${activeView === "threads" ? "sidebar__nav-item--active" : ""}`}
            type="button"
            onClick={() => onSetActiveView("threads")}
          >
            <FolderIcon />
            <span>{t("sidebar.threads")}</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenSkills(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
            <SkillIcon />
            <span>{t("sidebar.skills")}</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenExtensions(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
            <ExtensionIcon />
            <span>{t("sidebar.extensions")}</span>
          </button>
          <button
            className="sidebar__nav-item"
            type="button"
            onClick={() => onOpenSettings(selectedWorkspace?.rootWorkspaceId ?? selectedWorkspace?.id)}
          >
            <SettingsIcon />
            <span>{t("sidebar.settings")}</span>
          </button>
        </div>
      </div>

      <div className="sidebar__section">
        <div className="section__head">
          <span>{t("sidebar.threads")}</span>
          <div className="section__tools">
            <button
              aria-label={t("sidebar.openFolder")}
              className="icon-button"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              <FolderIcon />
            </button>
          </div>
        </div>

        {visibleWorkspaces.length === 0 ? (
          <div className="empty-state" data-testid="empty-state">
            <h2>{t("sidebar.noFolders")}</h2>
            <p>{t("sidebar.noFoldersDesc")}</p>
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              {t("sidebar.openFirstFolder")}
            </button>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={headerCollision} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <SortableContext items={rootGroupIds} strategy={verticalListSortingStrategy}>
              <div className="workspace-list" data-testid="workspace-list">
                {rootGroups.map((group) => (
                  <SortableWorkspaceGroup
                    key={group.rootWorkspace.id}
                    group={group}
                    canDrag={canDrag}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    onNewThreadForWorkspace={onNewThreadForWorkspace}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onUnarchiveSession={onUnarchiveSession}
                  />
                ))}
                {orphanGroups.map((group) => (
                  <WorkspaceGroupContent
                    key={group.rootWorkspace.id}
                    group={group}
                    canDrag={false}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    onNewThreadForWorkspace={onNewThreadForWorkspace}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onUnarchiveSession={onUnarchiveSession}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeGroup ? (
                <div className="workspace-group workspace-group--overlay">
                  <WorkspaceGroupContent
                    group={activeGroup}
                    canDrag={false}
                    selectedWorkspace={selectedWorkspace}
                    selectedSession={selectedSession}
                    linkedWorktreeByWorkspaceId={linkedWorktreeByWorkspaceId}
                    wsMenu={wsMenu}
                    api={api}
                    onNewThreadForWorkspace={onNewThreadForWorkspace}
                    onArchiveSession={onArchiveSession}
                    onSelectSession={onSelectSession}
                    onUnarchiveSession={onUnarchiveSession}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
      {!isElectronHost() ? (
        <div className="sidebar__footer">
          <button className="sidebar__nav-item" type="button" onClick={logoutRemoteUi}>
            <span>{t("sidebar.logOut")}</span>
          </button>
        </div>
      ) : null}
      <div
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        className={`sidebar__resize-handle${isResizing ? " sidebar__resize-handle--active" : ""}`}
        role="separator"
        onMouseDown={startResize}
      />
    </aside>
  );
}

/* ── Sortable workspace group wrapper ──────────────────── */

interface WorkspaceGroupProps {
  readonly group: ThreadGroup;
  readonly canDrag: boolean;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedSession: SessionRecord | undefined;
  readonly linkedWorktreeByWorkspaceId: ReadonlyMap<string, WorktreeRecord>;
  readonly wsMenu: WorkspaceMenuState;
  readonly api: PiDesktopApi;
  readonly onNewThreadForWorkspace: (workspaceId: string) => void;
  readonly onArchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onSelectSession: (target: { workspaceId: string; sessionId: string }) => void;
  readonly onUnarchiveSession: (target: { workspaceId: string; sessionId: string }) => void;
}

function SortableWorkspaceGroup(props: WorkspaceGroupProps) {
  const { group, wsMenu } = props;
  const isRenaming = wsMenu.workspaceRenameId === group.rootWorkspace.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.rootWorkspace.id,
    disabled: isRenaming,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : undefined,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      className={`workspace-group ${isDragging ? "workspace-group--dragging" : ""}`}
    >
      <WorkspaceGroupContent
        {...props}
        dragHandleProps={props.canDrag && !isRenaming ? { attributes, listeners } : undefined}
      />
    </section>
  );
}

/* ── Workspace group content (used both inline and in overlay) ──── */

interface DragHandleProps {
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
}

function WorkspaceGroupContent(
  props: WorkspaceGroupProps & { readonly dragHandleProps?: DragHandleProps },
) {
  const {
    group: { rootWorkspace, threads, archivedThreads },
    selectedWorkspace,
    selectedSession,
    linkedWorktreeByWorkspaceId,
    wsMenu,
    api,
    onNewThreadForWorkspace,
    onArchiveSession,
    onSelectSession,
    onUnarchiveSession,
    dragHandleProps,
  } = props;

  const { t } = useI18n();
  const workspaceActive =
    rootWorkspace.id === selectedWorkspace?.id ||
    rootWorkspace.id === selectedWorkspace?.rootWorkspaceId;
  const linkedWorktree = linkedWorktreeByWorkspaceId.get(rootWorkspace.id);
  const archivedSectionOpen = wsMenu.expandedArchivedByWorkspace[rootWorkspace.id] ?? false;
  const isCollapsed = wsMenu.collapsedWorkspaces[rootWorkspace.id] ?? false;
  const sessionListExpanded = wsMenu.expandedSessionListByWorkspace[rootWorkspace.id] ?? false;

  const visibleThreads = useMemo(() => {
    if (sessionListExpanded || threads.length <= MAX_VISIBLE_SESSIONS) {
      return threads;
    }
    return threads.slice(0, MAX_VISIBLE_SESSIONS);
  }, [threads, sessionListExpanded]);

  const hiddenCount = threads.length - MAX_VISIBLE_SESSIONS;
  const hasHiddenSessions = hiddenCount > 0 && !sessionListExpanded;

  return (
    <>
      <div className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}>
        <button
          className={`workspace-row__select ${dragHandleProps ? "workspace-row__select--draggable" : ""}`}
          onClick={() => {
            wsMenu.selectWorkspace(rootWorkspace.id);
            wsMenu.toggleWorkspaceCollapsed(rootWorkspace.id);
          }}
          type="button"
          {...(dragHandleProps ? { ...dragHandleProps.attributes, ...dragHandleProps.listeners } : {})}
        >
          <span className="workspace-row__icon" aria-hidden="true" data-collapsed={isCollapsed || undefined}>
            <span className="workspace-row__icon-folder"><FolderIcon /></span>
            <span className="workspace-row__icon-chevron"><ChevronDownIcon /></span>
          </span>
          <span className="workspace-row__name">{rootWorkspace.name}</span>
        </button>
        <span className="workspace-row__actions">
          <button
            aria-label={t("sidebar.newThreadIn", { name: rootWorkspace.name })}
            className="icon-button workspace-row__new-thread"
            type="button"
            title={t("sidebar.newThread")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNewThreadForWorkspace(rootWorkspace.id);
            }}
          >
            <PlusIcon />
          </button>
          <span
            className="workspace-row__menu-wrap"
            ref={wsMenu.workspaceMenuId === rootWorkspace.id ? wsMenu.workspaceMenuWrapRef : undefined}
          >
            <button
              aria-label={t("sidebar.workspaceActions", { name: rootWorkspace.name })}
              aria-haspopup="menu"
              className="icon-button workspace-row__menu-button"
              aria-expanded={wsMenu.workspaceMenuId === rootWorkspace.id}
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                wsMenu.openWorkspaceMenu(rootWorkspace.id);
              }}
            >
              …
            </button>
          {wsMenu.workspaceMenuId === rootWorkspace.id ? (
            <div className="workspace-menu">
              <button
                className="workspace-menu__item"
                type="button"
                onClick={(event) =>
                  wsMenu.runWorkspaceMenuAction(event, () => {
                    void api.openWorkspaceInFinder(rootWorkspace.id);
                  })
                }
              >
                {t("sidebar.openFolder")}
              </button>
              {linkedWorktree ? (
                <button
                  className="workspace-menu__item workspace-menu__item--danger"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () =>
                      wsMenu.removeWorktree(linkedWorktree.rootWorkspaceId || rootWorkspace.id, linkedWorktree),
                    )
                  }
                >
                  {t("sidebar.removeWorktree")}
                </button>
              ) : (
                <button
                  className="workspace-menu__item"
                  type="button"
                  onClick={(event) =>
                    wsMenu.runWorkspaceMenuAction(event, () => wsMenu.createWorktree(rootWorkspace.id))
                  }
                >
                  {t("sidebar.createPermanentWorktree")}
                </button>
              )}
              <button
                className="workspace-menu__item"
                type="button"
                onClick={(event) => wsMenu.runWorkspaceMenuAction(event, () => wsMenu.startRename(rootWorkspace))}
              >
                {t("sidebar.editName")}
              </button>
              <button
                className="workspace-menu__item workspace-menu__item--danger"
                type="button"
                onClick={(event) => wsMenu.runWorkspaceMenuAction(event, () => wsMenu.removeWorkspace(rootWorkspace))}
              >
                {t("sidebar.remove")}
              </button>
            </div>
          ) : null}
        </span>
        </span>
      </div>
      {wsMenu.workspaceRenameId === rootWorkspace.id ? (
        <form
          className="workspace-rename"
          ref={wsMenu.workspaceRenamePanelRef}
          onSubmit={(event) => {
            event.preventDefault();
            wsMenu.submitRename(rootWorkspace);
          }}
        >
          <input
            aria-label={t("sidebar.renameWorkspace", { name: rootWorkspace.name })}
            className="workspace-rename__input"
            ref={wsMenu.workspaceRenameInputRef}
            value={wsMenu.workspaceRenameDraft}
            onChange={(event) => {
              wsMenu.setWorkspaceRenameDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                wsMenu.cancelRename();
              }
            }}
          />
          <div className="workspace-rename__actions">
            <button className="workspace-rename__button" type="button" onClick={wsMenu.cancelRename}>
              {t("sidebar.cancel")}
            </button>
            <button className="workspace-rename__button workspace-rename__button--primary" type="submit">
              {t("sidebar.save")}
            </button>
          </div>
        </form>
      ) : null}
      {!isCollapsed ? (
        <>
          <div className="session-list">
            {visibleThreads.map((thread) => {
              const active = thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
              return (
                <ThreadSessionRow
                  key={`${thread.workspaceId}:${thread.session.id}`}
                  active={active}
                  thread={thread}
                  onSelect={() => onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })}
                />
              );
            })}
          </div>
          {hasHiddenSessions ? (
            <button
              className="session-list__expand-button"
              type="button"
              onClick={() => wsMenu.toggleExpandedSessionList(rootWorkspace.id)}
            >
              {t("sidebar.showAll", { count: threads.length })}
            </button>
          ) : null}
          {sessionListExpanded && threads.length > MAX_VISIBLE_SESSIONS ? (
            <button
              className="session-list__collapse-button"
              type="button"
              onClick={() => wsMenu.toggleExpandedSessionList(rootWorkspace.id)}
            >
              {t("sidebar.showLess")}
            </button>
          ) : null}
          {archivedThreads.length > 0 ? (
            <div className="archived-thread-group">
              <button
                aria-expanded={archivedSectionOpen}
                className="archived-thread-group__toggle"
                type="button"
                onClick={() => wsMenu.toggleArchived(rootWorkspace.id, !archivedSectionOpen)}
              >
                <span
                  aria-hidden="true"
                  className={`archived-thread-group__chevron ${archivedSectionOpen ? "archived-thread-group__chevron--open" : ""}`}
                >
                  <ChevronDownIcon />
                </span>
                <span>{t("sidebar.archived")}</span>
                <span className="archived-thread-group__count">{archivedThreads.length}</span>
              </button>
              {archivedSectionOpen ? (
                <div className="session-list session-list--archived">
                  {archivedThreads.map((thread) => {
                    const active =
                      thread.workspaceId === selectedWorkspace?.id && thread.session.id === selectedSession?.id;
                    return (
                      <ThreadSessionRow
                        key={`${thread.workspaceId}:${thread.session.id}`}
                        active={active}
                        thread={thread}
                        onSelect={() => onSelectSession({ workspaceId: thread.workspaceId, sessionId: thread.session.id })}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/* ── Thread session row ────────────────────────────────── */

function sessionIndicatorVariant(thread: ThreadListEntry): "running" | "unseen" | "none" {
  if (thread.session.status === "running") {
    return "running";
  }
  if (thread.session.hasUnseenUpdate) {
    return "unseen";
  }
  return "none";
}

function ThreadSessionRow({
  active,
  thread,
  onSelect,
}: {
  readonly active: boolean;
  readonly thread: ThreadListEntry;
  readonly onSelect: () => void;
}) {
  const indicatorVariant = sessionIndicatorVariant(thread);
  return (
    <div
      className={`session-row ${active ? "session-row--active" : ""}`}
      data-sidebar-indicator={indicatorVariant}
      data-session-id={thread.session.id}
    >
      <button className="session-row__select" onClick={onSelect} type="button">
        <span className="session-row__body">
          <span className="session-row__title-line">
            <span className="session-row__title">{thread.session.title}</span>
          </span>
        </span>
      </button>
    </div>
  );
}
