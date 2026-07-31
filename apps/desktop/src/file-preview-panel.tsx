import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PiDesktopApi, WorkspaceFileContent } from "./ipc";
import { RefreshIcon } from "./icons";
import { useI18n } from "./i18n";
import { isElectronHost } from "./platform-env";
import { monaco } from "./monaco-setup";

export interface FilePreviewPanelProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly api: PiDesktopApi;
  /** Workspace-relative path of the file to preview, or null when nothing is open. */
  readonly filePath: string | null;
  readonly resizeHandles?: ReactNode;
}

type LoadStatus = "idle" | "loading" | "loaded" | "error";
type SaveStatus = "idle" | "saving" | "saved" | "error";
type MonacoLoadStatus = "unloaded" | "loading" | "ready" | "failed";

// ── Monaco (bundled locally) ─────────────────────────────────────────────
// Monaco is initialized with the renderer bundle instead of a dynamic import.
// In Electron's file:// renderer, Vite's dynamic CSS preloader can remain
// pending indefinitely; that left the preview panel stuck on "Loading file…".
type MonacoApi = typeof import("monaco-editor/esm/vs/editor/editor.api");
let monacoLoadPromise: Promise<MonacoApi> | null = null;

function loadMonaco(): Promise<MonacoApi> {
  if (monacoLoadPromise) {
    return monacoLoadPromise;
  }
  monacoLoadPromise = Promise.resolve(monaco).catch((error) => {
    monacoLoadPromise = null;
    throw error instanceof Error ? error : new Error("Monaco failed to initialize.");
  });
  return monacoLoadPromise;
}

const MONACO_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  sql: "sql",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  toml: "ini",
  ini: "ini",
  txt: "plaintext",
};

function monacoLanguageFor(filePath: string): string {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex < 0) {
    return "plaintext";
  }
  const ext = filePath.slice(dotIndex + 1).toLowerCase();
  return MONACO_LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

function toWorkspaceFileUrl(workspacePath: string, relativePath: string): string {
  const root = workspacePath.replace(/[\\/]+$/, "");
  const combined = `${root}/${relativePath}`.replace(/\\/g, "/");
  const isWindowsDrivePath = /^[a-zA-Z]:\//.test(combined);
  const withLeadingSlash = isWindowsDrivePath ? `/${combined}` : combined;
  return `file://${encodeURI(withLeadingSlash)}`;
}

export function FilePreviewPanel({
  workspaceId,
  workspaceName,
  workspacePath,
  api,
  filePath,
  resizeHandles,
}: FilePreviewPanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [fileContent, setFileContent] = useState<WorkspaceFileContent | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [dirty, setDirty] = useState(false);
  const [monacoStatus, setMonacoStatus] = useState<MonacoLoadStatus>("unloaded");
  const [fallbackText, setFallbackText] = useState("");

  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const currentTextRef = useRef<string>("");

  // ── Load file content whenever the target path changes ──
  useEffect(() => {
    if (!filePath) {
      setStatus("idle");
      setFileContent(null);
      setDirty(false);
      setSaveStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);
    setDirty(false);
    setSaveStatus("idle");
    void api
      .readWorkspaceFile(workspaceId, filePath)
      .then((result) => {
        if (cancelled) return;
        setFileContent(result);
        setStatus("loaded");
        currentTextRef.current = result.content ?? "";
        setFallbackText(result.content ?? "");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(t("filePreview.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [api, filePath, workspaceId, t]);

  const isEditableTextKind = fileContent?.kind === "text" || fileContent?.kind === "html";

  // ── Load Monaco lazily, once we actually need it ──
  useEffect(() => {
    if (!isEditableTextKind || monacoStatus !== "unloaded") {
      return;
    }
    setMonacoStatus("loading");
    let cancelled = false;
    void loadMonaco()
      .then((monaco) => {
        if (cancelled) return;
        monacoRef.current = monaco;
        setMonacoStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setMonacoStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [isEditableTextKind, monacoStatus]);

  const handleDirtyChange = useCallback((nextDirty: boolean) => {
    setDirty(nextDirty);
    setSaveStatus((current) => (current === "saved" || current === "error" ? "idle" : current));
  }, []);

  const handleSave = useCallback(() => {
    if (!filePath) {
      return;
    }
    const textToSave = editorRef.current ? editorRef.current.getValue() : currentTextRef.current;
    setSaveStatus("saving");
    void api
      .writeWorkspaceFile(workspaceId, filePath, textToSave)
      .then((result) => {
        if (result.saved) {
          currentTextRef.current = textToSave;
          setDirty(false);
          setSaveStatus("saved");
        } else {
          setSaveStatus("error");
        }
      })
      .catch(() => {
        setSaveStatus("error");
      });
  }, [api, filePath, workspaceId]);

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // ── Mount/update the Monaco editor instance when content is ready ──
  useEffect(() => {
    if (monacoStatus !== "ready" || !isEditableTextKind || !fileContent || !filePath) {
      return;
    }
    const monaco = monacoRef.current;
    const container = editorContainerRef.current;
    if (!monaco || !container) {
      return;
    }

    const language = monacoLanguageFor(filePath);
    const value = fileContent.content ?? "";
    currentTextRef.current = value;

    try {
      if (!editorRef.current) {
        editorRef.current = monaco.editor.create(container, {
          value,
          language,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12.5,
          scrollBeyondLastLine: false,
          wordWrap: "on",
        });
        editorRef.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          handleSaveRef.current();
        });
      } else {
        const model = editorRef.current.getModel();
        if (model) {
          monaco.editor.setModelLanguage(model, language);
          editorRef.current.setValue(value);
        }
      }

      const disposable = editorRef.current.onDidChangeModelContent(() => {
        const nextValue = editorRef.current.getValue();
        handleDirtyChange(nextValue !== currentTextRef.current || nextValue !== value);
      });

      return () => {
        disposable.dispose();
        // The preview body is replaced with a loading placeholder while the
        // next file is read. Dispose the editor before that container unmounts
        // so the next file gets a fresh editor bound to its new DOM node.
        if (editorRef.current) {
          editorRef.current.dispose();
          editorRef.current = null;
        }
      };
    } catch {
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
      setMonacoStatus("failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoStatus, isEditableTextKind, fileContent, filePath]);

  // Dispose the editor instance entirely when it's no longer needed (panel
  // closed, or switched to a non-text file) so we don't leak Monaco models.
  useEffect(() => {
    if (isEditableTextKind && monacoStatus === "ready") {
      return;
    }
    if (editorRef.current) {
      editorRef.current.dispose();
      editorRef.current = null;
    }
  }, [isEditableTextKind, monacoStatus]);

  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, []);

  const handleFallbackTextChange = useCallback(
    (nextValue: string) => {
      setFallbackText(nextValue);
      handleDirtyChange(nextValue !== (fileContent?.content ?? ""));
    },
    [fileContent, handleDirtyChange],
  );

  useEffect(() => {
    currentTextRef.current = fallbackText;
  }, [fallbackText]);

  const canSave = isEditableTextKind && status === "loaded";

  let body: ReactNode;
  if (!filePath) {
    body = <div className="file-preview-panel__empty">{t("filePreview.empty")}</div>;
  } else if (status === "loading") {
    body = <div className="file-preview-panel__loading">{t("filePreview.loading")}</div>;
  } else if (status === "error") {
    body = <div className="file-preview-panel__error" role="alert">{errorMessage}</div>;
  } else if (fileContent) {
    if (fileContent.kind === "image" && fileContent.dataUrl) {
      body = (
        <div className="file-preview-panel__media">
          <img alt={fileContent.path} src={fileContent.dataUrl} />
        </div>
      );
    } else if (fileContent.kind === "video" && fileContent.dataUrl) {
      body = (
        <div className="file-preview-panel__media">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video controls src={fileContent.dataUrl} />
        </div>
      );
    } else if (fileContent.kind === "html") {
      if (isElectronHost()) {
        body = (
          <webview
            className="file-preview-panel__html-frame"
            src={toWorkspaceFileUrl(workspacePath, fileContent.path)}
          />
        );
      } else {
        body = (
          <iframe
            className="file-preview-panel__html-frame"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            srcDoc={fileContent.content ?? ""}
            title={fileContent.path}
          />
        );
      }
    } else if (fileContent.kind === "text") {
      if (monacoStatus === "ready") {
        body = <div className="file-preview-panel__editor" ref={editorContainerRef} />;
      } else if (monacoStatus === "failed") {
        body = (
          <>
            <div className="file-preview-panel__notice" role="status">
              {t("filePreview.editorUnavailable")}
            </div>
            <textarea
              className="file-preview-panel__editor-fallback"
              spellCheck={false}
              value={fallbackText}
              onChange={(event) => handleFallbackTextChange(event.target.value)}
            />
          </>
        );
      } else {
        body = <div className="file-preview-panel__loading">{t("filePreview.loading")}</div>;
      }
    } else {
      body = (
        <div className="file-preview-panel__unsupported">
          {fileContent.truncated ? t("filePreview.tooLarge") : t("filePreview.unsupported")}
        </div>
      );
    }
  } else {
    body = <div className="file-preview-panel__empty">{t("filePreview.empty")}</div>;
  }

  return (
    <aside className="file-preview-panel" data-testid="file-preview-panel">
      {resizeHandles}
      <div className="file-preview-panel__header">
        <div className="file-preview-panel__heading">
          <h2 className="file-preview-panel__title">{t("filePreview.title")}</h2>
          <span className="file-preview-panel__path" title={filePath ?? workspaceName}>
            {filePath ?? workspaceName}
          </span>
        </div>
        <div className="file-preview-panel__header-actions">
          {dirty ? (
            <span
              aria-label={t("filePreview.unsavedChanges")}
              className="file-preview-panel__dirty-dot"
              title={t("filePreview.unsavedChanges")}
            />
          ) : null}
          {canSave ? (
            <button
              className="file-preview-panel__save"
              data-testid="file-preview-save"
              disabled={!dirty || saveStatus === "saving"}
              type="button"
              onClick={handleSave}
            >
              <RefreshIcon />
              {saveStatus === "saving" ? t("filePreview.saving") : t("filePreview.save")}
            </button>
          ) : null}
        </div>
      </div>

      {saveStatus === "saved" ? (
        <div className="file-preview-panel__notice file-preview-panel__notice--saved" role="status">
          {t("filePreview.saved")}
        </div>
      ) : null}
      {saveStatus === "error" ? (
        <div className="file-preview-panel__notice file-preview-panel__notice--error" role="alert">
          {t("filePreview.saveFailed")}
        </div>
      ) : null}

      <div className="file-preview-panel__body">{body}</div>
    </aside>
  );
}
