import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { PiDesktopApi } from "./ipc";
import { InlineDiff } from "./diff-inline";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  RefreshIcon,
} from "./icons";
import { extensionToLanguage } from "./syntax-highlight";
import { useI18n } from "./i18n";

interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "untracked";
}

interface RemoteBranch {
  readonly remote: string;
  readonly branch: string;
}

interface FileTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly file: ChangedFile;
}

interface FileTreeDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: readonly FileTreeNode[];
  readonly filePaths: readonly string[];
  readonly directoryPaths: readonly string[];
}

type FileTreeNode = FileTreeFileNode | FileTreeDirectoryNode;

interface MutableFileTreeDirectory {
  readonly name: string;
  readonly path: string;
  readonly directories: Map<string, MutableFileTreeDirectory>;
  readonly files: ChangedFile[];
}

function buildFileTree(files: readonly ChangedFile[]): readonly FileTreeNode[] {
  const root: MutableFileTreeDirectory = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const fileName = parts.at(-1);
    if (!fileName) {
      continue;
    }

    let directory = root;
    let directoryPath = "";
    for (const part of parts.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = {
          name: part,
          path: directoryPath,
          directories: new Map(),
          files: [],
        };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }

  return finalizeDirectoryChildren(root);
}

function finalizeDirectoryChildren(
  directory: MutableFileTreeDirectory,
): readonly FileTreeNode[] {
  const directoryNodes = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child): FileTreeDirectoryNode => {
      const children = finalizeDirectoryChildren(child);
      const filePaths = children.flatMap((node) =>
        node.kind === "file" ? [node.path] : node.filePaths,
      );
      const directoryPaths = [
        child.path,
        ...children.flatMap((node) =>
          node.kind === "directory" ? node.directoryPaths : [],
        ),
      ];
      return {
        kind: "directory",
        name: child.name,
        path: child.path,
        children,
        filePaths,
        directoryPaths,
      };
    });
  const fileNodes = [...directory.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file): FileTreeFileNode => ({
      kind: "file",
      name: file.path.split("/").at(-1) ?? file.path,
      path: file.path,
      file,
    }));
  return [...directoryNodes, ...fileNodes];
}

function collectDirectoryPaths(nodes: readonly FileTreeNode[]): readonly string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory" ? node.directoryPaths : [],
  );
}

function getParentDirectoryPaths(filePath: string): readonly string[] {
  const parts = filePath.split("/").filter(Boolean);
  const directoryPaths: string[] = [];
  let currentPath = "";
  for (const part of parts.slice(0, -1)) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    directoryPaths.push(currentPath);
  }
  return directoryPaths;
}

export interface DiffPanelFileRequest {
  readonly path: string;
  readonly nonce: number;
}

interface DiffPanelProps {
  readonly workspaceId: string;
  readonly api: PiDesktopApi;
  readonly sessionStatus: string | undefined;
  readonly fileRequest?: DiffPanelFileRequest | null;
}

export function DiffPanel({ workspaceId, api, sessionStatus, fileRequest }: DiffPanelProps) {
  const { t } = useI18n();
  const [files, setFiles] = useState<readonly ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState("");
  const [committing, setCommitting] = useState(false);
  const [showPushDialog, setShowPushDialog] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<readonly RemoteBranch[]>([]);
  const [selectedRemoteBranch, setSelectedRemoteBranch] = useState<RemoteBranch | null>(null);
  const [loadingRemoteBranches, setLoadingRemoteBranches] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState("");
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const changedFilesRequestRef = useRef(0);
  const fileDiffRequestRef = useRef(0);

  useEffect(() => {
    changedFilesRequestRef.current += 1;
    fileDiffRequestRef.current += 1;
    setFiles([]);
    setSelectedFile(null);
    setDiffText("");
    setLoading(false);
    setSelectedPaths(new Set());
    setCommitMessage("");
    setCommitError("");
    setShowPushDialog(false);
    setRemoteBranches([]);
    setSelectedRemoteBranch(null);
    setPushError("");
    setExpandedDirectories(new Set());
  }, [workspaceId]);

  const refresh = useCallback(() => {
    const requestId = ++changedFilesRequestRef.current;
    setLoading(true);
    void api.getChangedFiles(workspaceId).then((result) => {
      if (requestId !== changedFilesRequestRef.current) {
        return;
      }
      setFiles(result);
      setSelectedFile((current) =>
        current && !result.some((f) => f.path === current) ? null : current,
      );
      setSelectedPaths((current) => {
        const availablePaths = new Set(result.map((file) => file.path));
        return new Set([...current].filter((filePath) => availablePaths.has(filePath)));
      });
      setLoading(false);
    });
  }, [api, workspaceId]);

  const prevStatusRef = useRef(sessionStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;
    if (prev === "running" && sessionStatus !== "running") {
      refresh();
    }
  }, [sessionStatus, refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!fileRequest) return;
    setSelectedFile(fileRequest.path);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      for (const directoryPath of getParentDirectoryPaths(fileRequest.path)) {
        next.add(directoryPath);
      }
      return next;
    });
  }, [fileRequest]);

  useEffect(() => {
    const requestId = ++fileDiffRequestRef.current;
    if (!selectedFile) {
      setDiffText("");
      return;
    }
    setDiffText("");
    void api.getFileDiff(workspaceId, selectedFile).then((result) => {
      if (requestId === fileDiffRequestRef.current) {
        setDiffText(result);
      }
    });
  }, [api, workspaceId, selectedFile]);

  const fileListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedFile) return;
    const row = fileListRef.current?.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(selectedFile)}"]`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedFile, files]);

  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(fileTree), [fileTree]);
  const allDirectoriesExpanded =
    directoryPaths.length > 0 && directoryPaths.every((path) => expandedDirectories.has(path));
  const allSelected = files.length > 0 && files.every((file) => selectedPaths.has(file.path));
  const partiallySelected = selectedPaths.size > 0 && !allSelected;
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected]);

  const toggleFileSelection = (filePath: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const toggleDirectoryExpanded = (directoryPath: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  };

  const toggleDirectorySelection = (directory: FileTreeDirectoryNode) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      const shouldSelect = directory.filePaths.some((filePath) => !next.has(filePath));
      for (const filePath of directory.filePaths) {
        if (shouldSelect) {
          next.add(filePath);
        } else {
          next.delete(filePath);
        }
      }
      return next;
    });
    setExpandedDirectories((current) => {
      const next = new Set(current);
      for (const directoryPath of directory.directoryPaths) {
        next.add(directoryPath);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedPaths(new Set());
      return;
    }
    setSelectedPaths(new Set(files.map((file) => file.path)));
    setExpandedDirectories(new Set(directoryPaths));
  };

  const expandAllDirectories = () => {
    setExpandedDirectories(new Set(directoryPaths));
  };

  const handleCommit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = commitMessage.trim();
    const filePaths = files
      .filter((file) => selectedPaths.has(file.path))
      .map((file) => file.path);
    if (!message || filePaths.length === 0 || committing) {
      return;
    }

    setCommitting(true);
    setCommitError("");
    void api.commitChanges(workspaceId, filePaths, message)
      .then(() => {
        setCommitMessage("");
        setSelectedPaths(new Set());
        setSelectedFile((current) =>
          current && filePaths.includes(current) ? null : current,
        );
        refresh();
      })
      .catch((error: unknown) => {
        setCommitError(error instanceof Error ? error.message : t("diff.commitFailed"));
      })
      .finally(() => {
        setCommitting(false);
      });
  };

  const openPushDialog = () => {
    setShowPushDialog(true);
    setLoadingRemoteBranches(true);
    setRemoteBranches([]);
    setSelectedRemoteBranch(null);
    setPushError("");
    void api.listRemoteBranches(workspaceId)
      .then((branches) => {
        setRemoteBranches(branches);
        setSelectedRemoteBranch(branches[0] ?? null);
      })
      .catch((error: unknown) => {
        setPushError(error instanceof Error ? error.message : t("diff.pushLoadFailed"));
      })
      .finally(() => {
        setLoadingRemoteBranches(false);
      });
  };

  const closePushDialog = () => {
    if (pushing) {
      return;
    }
    setShowPushDialog(false);
    setPushError("");
  };

  const handlePush = () => {
    if (!selectedRemoteBranch || pushing) {
      return;
    }
    setPushing(true);
    setPushError("");
    void api.pushRemoteBranch(
      workspaceId,
      selectedRemoteBranch.remote,
      selectedRemoteBranch.branch,
    )
      .then(() => {
        setShowPushDialog(false);
      })
      .catch((error: unknown) => {
        setPushError(error instanceof Error ? error.message : t("diff.pushFailed"));
      })
      .finally(() => {
        setPushing(false);
      });
  };

  const renderFileTreeNodes = (
    nodes: readonly FileTreeNode[],
    depth = 0,
  ): ReactNode => nodes.map((node) => {
    const rowStyle = { paddingLeft: `${8 + depth * 16}px` };
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories.has(node.path);
      const selectedCount = node.filePaths.reduce(
        (count, filePath) => count + (selectedPaths.has(filePath) ? 1 : 0),
        0,
      );
      const isChecked = node.filePaths.length > 0 && selectedCount === node.filePaths.length;
      const isPartiallyChecked = selectedCount > 0 && !isChecked;
      return (
        <div
          aria-expanded={isExpanded}
          aria-level={depth + 1}
          className="diff-panel__tree-directory"
          key={`directory:${node.path}`}
          role="treeitem"
        >
          <div
            className="diff-panel__tree-row diff-panel__tree-row--directory"
            data-directory-path={node.path}
            style={rowStyle}
          >
            <button
              aria-label={t(
                isExpanded ? "diff.collapseDirectory" : "diff.expandDirectory",
                { path: node.path },
              )}
              className="diff-panel__tree-toggle"
              type="button"
              onClick={() => toggleDirectoryExpanded(node.path)}
            >
              {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </button>
            <input
              aria-label={t("diff.selectDirectory", { path: node.path })}
              checked={isChecked}
              className="diff-panel__selection-checkbox"
              data-testid={`diff-panel-select-directory-${node.path}`}
              disabled={committing}
              ref={(input) => {
                if (input) {
                  input.indeterminate = isPartiallyChecked;
                }
              }}
              type="checkbox"
              onChange={() => toggleDirectorySelection(node)}
            />
            <button
              className="diff-panel__directory-name"
              title={node.path}
              type="button"
              onClick={() => toggleDirectoryExpanded(node.path)}
            >
              <FolderIcon />
              <span className="diff-panel__tree-label">{node.name}</span>
              <span className="diff-panel__directory-count">{node.filePaths.length}</span>
            </button>
          </div>
          {isExpanded ? (
            <div className="diff-panel__tree-children" role="group">
              {renderFileTreeNodes(node.children, depth + 1)}
            </div>
          ) : null}
        </div>
      );
    }

    const isChecked = selectedPaths.has(node.path);
    const isSelected = selectedFile === node.path;
    const className = [
      "diff-panel__tree-row",
      "diff-panel__file",
      isSelected ? "diff-panel__file--selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        aria-level={depth + 1}
        className={className}
        data-file-path={node.path}
        key={`file:${node.path}`}
        role="treeitem"
        style={rowStyle}
      >
        <span className="diff-panel__tree-spacer" aria-hidden="true" />
        <input
          aria-label={t("diff.selectFile", { path: node.path })}
          checked={isChecked}
          className="diff-panel__selection-checkbox"
          data-testid={`diff-panel-select-${node.path}`}
          disabled={committing}
          type="checkbox"
          onChange={() => toggleFileSelection(node.path)}
        />
        <button
          className="diff-panel__file-name"
          title={node.path}
          type="button"
          onClick={() => setSelectedFile(node.path === selectedFile ? null : node.path)}
        >
          <span className={`diff-panel__status-dot diff-panel__status-dot--${node.file.status}`} />
          <span className="diff-panel__tree-label">{node.name}</span>
        </button>
      </div>
    );
  });

  return (
    <aside className="diff-panel">
      <div className="diff-panel__header">
        <h2 className="diff-panel__title">{t("diff.changes")}</h2>
        <div className="diff-panel__header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={refresh}
            aria-label={t("diff.refresh")}
            disabled={loading || committing}
          >
            <RefreshIcon />
          </button>
          <button
            className="diff-panel__push-trigger"
            data-testid="diff-panel-open-push"
            type="button"
            onClick={openPushDialog}
            disabled={committing || pushing}
          >
            <ArrowUpIcon />
            <span>{t("diff.push")}</span>
          </button>
        </div>
      </div>

      <form className="diff-panel__commit-form" onSubmit={handleCommit}>
        <input
          className="diff-panel__commit-message"
          data-testid="diff-panel-commit-message"
          type="text"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder={t("diff.commitMessagePlaceholder")}
          aria-label={t("diff.commitMessage")}
          disabled={committing}
        />
        <div className="diff-panel__commit-actions">
          <div className="diff-panel__selection-actions">
            <label className="diff-panel__select-all">
              <input
                ref={selectAllRef}
                data-testid="diff-panel-select-all"
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                disabled={files.length === 0 || committing}
              />
              <span>{t("diff.selectAll")}</span>
            </label>
            <button
              aria-label={t("diff.expandAll")}
              className="diff-panel__expand-all"
              data-testid="diff-panel-expand-all"
              type="button"
              onClick={expandAllDirectories}
              disabled={directoryPaths.length === 0 || allDirectoriesExpanded || committing}
            >
              <ChevronDownIcon />
              <span>{t("diff.expandAll")}</span>
            </button>
          </div>
          <button
            className="button button--primary diff-panel__commit-button"
            data-testid="diff-panel-commit"
            type="submit"
            disabled={!commitMessage.trim() || selectedPaths.size === 0 || committing}
          >
            {committing
              ? t("diff.committing")
              : t("diff.commitSelected", { count: selectedPaths.size })}
          </button>
        </div>
        {commitError ? (
          <div className="diff-panel__commit-error" role="alert">
            {commitError}
          </div>
        ) : null}
      </form>

      {files.length === 0 ? (
        <div className="diff-panel__empty">{t("diff.noChanges")}</div>
      ) : (
        <>
          <div className="diff-panel__file-list" ref={fileListRef} role="tree">
            {renderFileTreeNodes(fileTree)}
          </div>

          {selectedFile && diffText ? (
            <div className="diff-panel__viewer">
              <div className="diff-panel__viewer-header">{selectedFile}</div>
              <InlineDiff diff={diffText} language={extensionToLanguage(selectedFile)} />
            </div>
          ) : null}
        </>
      )}

      {showPushDialog ? (
        <div
          className="diff-panel__push-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closePushDialog();
            }
          }}
        >
          <div
            aria-labelledby="diff-panel-push-title"
            aria-modal="true"
            className="diff-panel__push-dialog"
            data-testid="diff-panel-push-dialog"
            role="dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closePushDialog();
              }
            }}
          >
            <div className="diff-panel__push-dialog-header">
              <h3 id="diff-panel-push-title">{t("diff.pushTitle")}</h3>
              <p>{t("diff.pushDescription")}</p>
            </div>

            <label className="diff-panel__push-field">
              <span>{t("diff.remoteBranch")}</span>
              <select
                autoFocus
                data-testid="diff-panel-push-branch"
                value={selectedRemoteBranch
                  ? JSON.stringify([selectedRemoteBranch.remote, selectedRemoteBranch.branch])
                  : ""}
                onChange={(event) => {
                  const next = remoteBranches.find(
                    (branch) => JSON.stringify([branch.remote, branch.branch]) === event.target.value,
                  );
                  setSelectedRemoteBranch(next ?? null);
                }}
                disabled={loadingRemoteBranches || pushing}
              >
                <option value="" disabled>
                  {loadingRemoteBranches
                    ? t("diff.loadingRemoteBranches")
                    : t("diff.selectRemoteBranch")}
                </option>
                {remoteBranches.map((branch) => (
                  <option
                    key={JSON.stringify([branch.remote, branch.branch])}
                    value={JSON.stringify([branch.remote, branch.branch])}
                  >
                    {branch.remote}/{branch.branch}
                  </option>
                ))}
              </select>
            </label>

            {!loadingRemoteBranches && remoteBranches.length === 0 && !pushError ? (
              <div className="diff-panel__push-empty">{t("diff.noRemoteBranches")}</div>
            ) : null}
            {pushError ? (
              <div className="diff-panel__push-error" role="alert">
                {pushError}
              </div>
            ) : null}

            <div className="diff-panel__push-dialog-actions">
              <button
                className="button button--secondary"
                type="button"
                onClick={closePushDialog}
                disabled={pushing}
              >
                {t("diff.cancel")}
              </button>
              <button
                className="button button--primary"
                data-testid="diff-panel-push-confirm"
                type="button"
                onClick={handlePush}
                disabled={!selectedRemoteBranch || loadingRemoteBranches || pushing}
              >
                {pushing ? t("diff.pushing") : t("diff.push")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
