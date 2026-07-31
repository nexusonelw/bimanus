import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { PiDesktopApi, WorkspaceDirectoryEntry } from "./ipc";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  RefreshIcon,
} from "./icons";
import { useI18n } from "./i18n";

interface FileManagerPanelProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly api: PiDesktopApi;
  readonly initialExpandedDirectories?: readonly string[];
  readonly onExpandedDirectoriesChange: (
    workspaceId: string,
    expandedDirectories: readonly string[],
  ) => void;
  /** Called when the user clicks a file row's name to open it in the file preview panel. */
  readonly onOpenFile?: (filePath: string) => void;
  readonly resizeHandles?: ReactNode;
}

interface FileManagerContextMenu {
  readonly x: number;
  readonly y: number;
  readonly paths: readonly string[];
}

function toWorkspacePath(workspacePath: string, relativePath: string): string {
  const root = workspacePath.replace(/[\\/]+$/, "");
  return root ? `${root}/${relativePath}` : relativePath;
}

function copyTextWithDocument(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyText(value: string): Promise<void> {
  // Run the user-gesture based fallback first. It is reliable in Electron and
  // on remote HTTP pages, where the asynchronous Clipboard API can be blocked
  // by permissions or remain pending.
  if (copyTextWithDocument(value)) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  throw new Error("Clipboard access is unavailable");
}

type DirectoryLoader = (
  relativePath: string,
) => Promise<readonly WorkspaceDirectoryEntry[]>;

// 递归收集目录下所有已知的后代路径，既包含文件，也包含子文件夹自身的路径。
// 子文件夹路径必须包含在内，否则「勾选父文件夹」时子文件夹自身不会被视为已选中，
// 进而导致在（尚未展开的）子文件夹上右键时，无法识别出它其实已经被父级勾选覆盖，
// 只能复制它自己的路径，而不是复制整个已选中集合。
function getKnownDirectoryDescendantPaths(
  entriesByDirectory: ReadonlyMap<string, readonly WorkspaceDirectoryEntry[]>,
  directoryPath: string,
): readonly string[] | null {
  const entries = entriesByDirectory.get(directoryPath);
  if (!entries) {
    return null;
  }

  const descendantPaths: string[] = [];
  for (const entry of entries) {
    descendantPaths.push(entry.path);
    if (entry.kind === "file") {
      continue;
    }

    const nestedPaths = getKnownDirectoryDescendantPaths(entriesByDirectory, entry.path);
    if (!nestedPaths) {
      return null;
    }
    descendantPaths.push(...nestedPaths);
  }
  return descendantPaths;
}

const DEFAULT_COLLAPSED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  "jspm_packages",
  "Pods",
  "DerivedData",
  "target",
  "__pycache__",
  "venv",
]);

function shouldExpandDirectoryByDefault(entry: WorkspaceDirectoryEntry): boolean {
  return (
    !entry.name.startsWith(".") &&
    !DEFAULT_COLLAPSED_DIRECTORY_NAMES.has(entry.name)
  );
}

function includeDirectoryAncestors(
  directoryPaths: readonly string[],
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const directoryPath of directoryPaths) {
    const segments = directoryPath.split("/").filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      result.add(segments.slice(0, index).join("/"));
    }
  }
  return result;
}

// 递归加载并收集目录下所有后代路径，既包含文件，也包含子文件夹自身的路径，
// 这样勾选一个文件夹时，其所有子文件夹（无论是否已展开）也会一并计入选中集合，
// 后续在这些子文件夹上右键才能正确识别为「已选中」，从而复制整个多选路径集合。
async function listDirectoryDescendantPaths(
  loadDirectory: DirectoryLoader,
  directoryPath: string,
): Promise<readonly string[]> {
  const entries = await loadDirectory(directoryPath);
  const directPaths = entries.map((entry) => entry.path);
  const nestedPaths = await Promise.all(
    entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => listDirectoryDescendantPaths(loadDirectory, entry.path)),
  );
  return [...directPaths, ...nestedPaths.flat()];
}

export function FileManagerPanel({
  workspaceId,
  workspaceName,
  workspacePath,
  api,
  initialExpandedDirectories,
  onExpandedDirectoriesChange,
  onOpenFile,
  resizeHandles,
}: FileManagerPanelProps) {
  const { t } = useI18n();
  const [entriesByDirectory, setEntriesByDirectory] = useState<
    ReadonlyMap<string, readonly WorkspaceDirectoryEntry[]>
  >(() => new Map());
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const initialExpandedDirectoriesRef = useRef(initialExpandedDirectories);
  const hasInitializedExpandedDirectoriesRef = useRef(false);
  const expandedDirectoriesRef = useRef<ReadonlySet<string>>(
    new Set(initialExpandedDirectories),
  );
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => expandedDirectoriesRef.current,
  );
  const [hasLoadedRoot, setHasLoadedRoot] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [selectingDirectories, setSelectingDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const [contextMenu, setContextMenu] = useState<FileManagerContextMenu | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const loadDirectory = useCallback(
    async (relativePath: string): Promise<readonly WorkspaceDirectoryEntry[]> => {
      setLoadingDirectories((current) => new Set(current).add(relativePath));
      try {
        const entries = await api.listWorkspaceDirectory(workspaceId, relativePath);
        setEntriesByDirectory((current) => {
          const next = new Map(current);
          next.set(relativePath, entries);
          return next;
        });
        return entries;
      } finally {
        setLoadingDirectories((current) => {
          const next = new Set(current);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [api, workspaceId],
  );

  const loadRootDirectory = useCallback(() => {
    setError(null);
    setCopyStatus(null);
    void loadDirectory("")
      .then((rootEntries) => {
        const defaultExpandedDirectories = rootEntries
          .filter(
            (entry) =>
              entry.kind === "directory" &&
              shouldExpandDirectoryByDefault(entry),
          )
          .map((entry) => entry.path);
        const nextExpandedDirectories = hasInitializedExpandedDirectoriesRef.current
          ? expandedDirectoriesRef.current
          : includeDirectoryAncestors(
              initialExpandedDirectoriesRef.current ?? defaultExpandedDirectories,
            );

        hasInitializedExpandedDirectoriesRef.current = true;
        expandedDirectoriesRef.current = nextExpandedDirectories;
        setExpandedDirectories(new Set(nextExpandedDirectories));
        setHasLoadedRoot(true);
        void Promise.all(
          [...nextExpandedDirectories].map((directoryPath) => loadDirectory(directoryPath)),
        ).catch(() => {
          // The root listing remains usable if an individual directory disappears while loading.
        });
      })
      .catch(() => {
        setError(t("fileManager.loadFailed"));
      });
  }, [loadDirectory, t]);

  useEffect(() => {
    loadRootDirectory();
  }, [loadRootDirectory]);

  useEffect(() => {
    if (hasLoadedRoot) {
      onExpandedDirectoriesChange(
        workspaceId,
        [...expandedDirectories].sort(),
      );
    }
  }, [
    expandedDirectories,
    hasLoadedRoot,
    onExpandedDirectoriesChange,
    workspaceId,
  ]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeContextMenu = () => setContextMenu(null);
    // 左键点击（mousedown）菜单之外的任意区域时立即关闭右键菜单；
    // 点击菜单内部（例如“复制路径”按钮）交给按钮自身的 onPointerDown 处理，
    // 避免这里抢先关闭菜单导致按钮上的复制逻辑读不到菜单数据。
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node | null;
      if (contextMenuRef.current && target && contextMenuRef.current.contains(target)) {
        return;
      }
      closeContextMenu();
    };

    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [contextMenu]);

  const toggleDirectory = useCallback(
    (directoryPath: string) => {
      const isExpanded = expandedDirectoriesRef.current.has(directoryPath);
      setExpandedDirectories((current) => {
        const next = new Set(current);
        if (next.has(directoryPath)) {
          next.delete(directoryPath);
        } else {
          next.add(directoryPath);
        }
        expandedDirectoriesRef.current = next;
        return next;
      });

      if (!isExpanded && !entriesByDirectory.has(directoryPath)) {
        void loadDirectory(directoryPath).catch(() => {
          setError(t("fileManager.loadFailed"));
        });
      }
    },
    [entriesByDirectory, loadDirectory, t],
  );

  const toggleFileSelection = useCallback((filePath: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
    setCopyStatus(null);
  }, []);

  const toggleDirectorySelection = useCallback(
    (directoryPath: string) => {
      if (selectingDirectories.has(directoryPath)) {
        return;
      }

      setError(null);
      setCopyStatus(null);
      setSelectingDirectories((current) => new Set(current).add(directoryPath));
      void listDirectoryDescendantPaths(loadDirectory, directoryPath)
        .then((descendantPaths) => {
          // 文件夹自身路径，以及其下所有文件和子文件夹的路径，都需要一并加入/移出
          // 选中集合。这样即使是空文件夹，或子文件夹尚未展开，也能被正确标记为已选中，
          // 后续在这些子文件夹上右键才能识别出它们属于当前多选集合。
          const allPaths = [directoryPath, ...descendantPaths];
          setSelectedPaths((current) => {
            const next = new Set(current);
            const shouldSelect = allPaths.some((path) => !next.has(path));
            for (const path of allPaths) {
              if (shouldSelect) {
                next.add(path);
              } else {
                next.delete(path);
              }
            }
            return next;
          });
        })
        .catch(() => {
          setError(t("fileManager.loadFailed"));
        })
        .finally(() => {
          setSelectingDirectories((current) => {
            const next = new Set(current);
            next.delete(directoryPath);
            return next;
          });
        });
    },
    [loadDirectory, selectingDirectories, t],
  );

  // 通用右键菜单处理：文件和文件夹均可调用。
  // 选中状态（selectedPaths）只能由 checkbox 左键点击驱动
  // （toggleFileSelection / toggleDirectorySelection），右键菜单绝不修改
  // 该持久状态，避免"多选后右键某一项导致其他已选中项被清空"的问题。
  // 若右键的目标本身已在选中集合中，则复制整个选中集合；
  // 否则仅复制右键命中的这一项（不勾选它），从而仍支持
  // "不勾选 checkbox，直接右键复制路径" 的场景。
  const showPathContextMenu = useCallback(
    (event: ReactMouseEvent, path: string) => {
      event.preventDefault();
      const menuPaths = selectedPaths.has(path) ? selectedPaths : new Set<string>([path]);

      const menuWidth = 236;
      const menuHeight = 44;
      setContextMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
        paths: [...menuPaths].sort(),
      });
    },
    [selectedPaths],
  );

  const copySelectedPaths = useCallback(() => {
    if (!contextMenu) {
      return;
    }

    const text = contextMenu.paths
      .map((relativePath) => toWorkspacePath(workspacePath, relativePath))
      .join("\n");

    setContextMenu(null);
    void copyText(text)
      .then(() => setCopyStatus("copied"))
      .catch(() => setCopyStatus("failed"));
  }, [contextMenu, workspacePath]);

  const renderDirectoryEntries = (
    directoryPath: string,
    depth = 0,
  ): ReactNode => {
    const entries = entriesByDirectory.get(directoryPath);
    if (!entries) {
      return loadingDirectories.has(directoryPath) ? (
        <div className="file-manager-panel__loading-children" key={`loading:${directoryPath}`}>
          {t("fileManager.loading")}
        </div>
      ) : null;
    }

    return entries.map((entry) => {
      const rowStyle = { paddingLeft: `${8 + depth * 16}px` };
      if (entry.kind === "directory") {
        const isExpanded = expandedDirectories.has(entry.path);
        const descendantPaths = getKnownDirectoryDescendantPaths(entriesByDirectory, entry.path);
        // 选中集合的判定需要同时考虑文件夹自身路径与其下属文件/子文件夹路径：
        // - 后代路径已知时，把“文件夹自身”并入总数一起计算是否全选/部分选。
        // - 后代路径尚未加载（descendantPaths 为 null）时，仅依据文件夹自身是否被选中来展示勾选态。
        const knownPaths = descendantPaths ? [entry.path, ...descendantPaths] : null;
        const selectedCount =
          knownPaths?.reduce((count, path) => count + (selectedPaths.has(path) ? 1 : 0), 0) ??
          (selectedPaths.has(entry.path) ? 1 : 0);
        const isChecked = knownPaths
          ? knownPaths.length > 0 && selectedCount === knownPaths.length
          : selectedPaths.has(entry.path);
        const isPartiallyChecked = selectedCount > 0 && !isChecked;
        const isSelecting = selectingDirectories.has(entry.path);
        return (
          <div
            aria-expanded={isExpanded}
            aria-level={depth + 1}
            className="file-manager-panel__tree-directory"
            data-testid={`file-manager-directory-${entry.path}`}
            key={`directory:${entry.path}`}
            role="treeitem"
          >
            <div
              className="file-manager-panel__tree-row"
              style={rowStyle}
              onContextMenu={(event) => showPathContextMenu(event, entry.path)}
            >
              <button
                aria-label={t(
                  isExpanded ? "fileManager.collapseDirectory" : "fileManager.expandDirectory",
                  { path: entry.path },
                )}
                className="file-manager-panel__tree-toggle"
                type="button"
                onClick={() => toggleDirectory(entry.path)}
              >
                {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </button>
              <input
                aria-label={t("fileManager.selectDirectory", { path: entry.path })}
                checked={isChecked}
                className="file-manager-panel__selection-checkbox"
                data-testid={`file-manager-select-directory-${entry.path}`}
                disabled={isSelecting}
                ref={(input) => {
                  if (input) {
                    input.indeterminate = isPartiallyChecked;
                  }
                }}
                type="checkbox"
                onChange={() => toggleDirectorySelection(entry.path)}
              />
              <button
                className="file-manager-panel__directory-name"
                title={entry.path}
                type="button"
                onClick={() => toggleDirectory(entry.path)}
              >
                <FolderIcon />
                <span className="file-manager-panel__tree-label">{entry.name}</span>
              </button>
            </div>
            {isExpanded ? (
              <div className="file-manager-panel__tree-children" role="group">
                {renderDirectoryEntries(entry.path, depth + 1)}
              </div>
            ) : null}
          </div>
        );
      }

      const isSelected = selectedPaths.has(entry.path);
      return (
        <div
          aria-level={depth + 1}
          aria-selected={isSelected}
          className={`file-manager-panel__tree-row file-manager-panel__file${isSelected ? " file-manager-panel__file--selected" : ""}`}
          data-testid={`file-manager-file-${entry.path}`}
          key={`file:${entry.path}`}
          role="treeitem"
          style={rowStyle}
          onContextMenu={(event) => showPathContextMenu(event, entry.path)}
        >
          <span className="file-manager-panel__tree-spacer" aria-hidden="true" />
          <input
            aria-label={t("fileManager.selectFile", { path: entry.path })}
            checked={isSelected}
            className="file-manager-panel__selection-checkbox"
            data-testid={`file-manager-select-${entry.path}`}
            type="checkbox"
            onChange={() => toggleFileSelection(entry.path)}
          />
          <button
            className="file-manager-panel__file-name"
            data-testid={`file-manager-open-${entry.path}`}
            title={entry.path}
            type="button"
            onClick={() => onOpenFile?.(entry.path)}
          >
            <FileIcon />
            <span className="file-manager-panel__tree-label">{entry.name}</span>
          </button>
        </div>
      );
    });
  };

  const rootEntries = entriesByDirectory.get("");
  const rootLoading = loadingDirectories.has("");

  return (
    <aside className="file-manager-panel" data-testid="file-manager-panel">
      {resizeHandles}
      <div className="file-manager-panel__header">
        <div className="file-manager-panel__heading">
          <h2 className="file-manager-panel__title">{t("fileManager.title")}</h2>
          <span className="file-manager-panel__workspace" title={workspacePath}>
            {workspaceName}
          </span>
        </div>
        <button
          aria-label={t("fileManager.refresh")}
          className="icon-button file-manager-panel__refresh"
          type="button"
          onClick={loadRootDirectory}
        >
          <RefreshIcon />
        </button>
      </div>

      {copyStatus ? (
        <div
          className={`file-manager-panel__notice file-manager-panel__notice--${copyStatus}`}
          role="status"
        >
          {copyStatus === "copied" ? t("fileManager.pathsCopied") : t("fileManager.copyFailed")}
        </div>
      ) : null}

      {error ? (
        <div className="file-manager-panel__empty" role="alert">
          {error}
        </div>
      ) : rootLoading && !rootEntries ? (
        <div className="file-manager-panel__empty">{t("fileManager.loading")}</div>
      ) : rootEntries && rootEntries.length > 0 ? (
        <div className="file-manager-panel__file-list" role="tree">
          {renderDirectoryEntries("")}
        </div>
      ) : (
        <div className="file-manager-panel__empty">{t("fileManager.empty")}</div>
      )}

      {contextMenu ? (
        <div
          aria-label={t("fileManager.contextMenu")}
          className="file-manager-panel__context-menu"
          ref={contextMenuRef}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="file-manager-panel__context-menu-item"
            data-testid="file-manager-copy-paths"
            role="menuitem"
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              copySelectedPaths();
            }}
          >
            <CopyIcon />
            {/* 已经多选（右键命中项属于当前选中集合且集合内不止一项）时，
                复制的是全部选中路径，文案展示为“复制选择的文件路径”；
                否则只复制右键命中的单个路径，文案展示为“复制文件路径”。 */}
            <span>
              {t(contextMenu.paths.length > 1 ? "fileManager.copyPaths" : "fileManager.copyPath")}
            </span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}
