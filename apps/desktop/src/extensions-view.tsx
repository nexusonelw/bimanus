import { useMemo, useState } from "react";
import type {
  RuntimeExtensionRecord,
  RuntimePackageRecord,
  RuntimeSnapshot,
} from "@bimanus/session-driver/runtime-types";
import type { ExtensionCommandCompatibilityRecord, WorkspaceRecord } from "./desktop-state";
import { extensionScopeLabel, extensionSourceSummary } from "./extension-display";
import { RefreshIcon } from "./icons";
import { useI18n } from "./i18n";

const packageBrowserUrl = "https://pi.dev/packages";

interface ExtensionsViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly commandCompatibility?: readonly ExtensionCommandCompatibilityRecord[];
  readonly onRefresh: () => void;
  readonly onOpenExtensionFolder: (filePath: string) => void;
  readonly onToggleExtension: (filePath: string, enabled: boolean) => void;
  readonly onRemoveExtension: (filePath: string) => Promise<string | undefined>;
  readonly onInstallPackage: (source: string) => Promise<string | undefined>;
  readonly onUpdatePackage: (
    source: string,
    installScope: RuntimePackageRecord["installScope"],
  ) => Promise<string | undefined>;
  readonly onTogglePackage: (source: string, enabled: boolean) => Promise<string | undefined>;
  readonly onRemovePackage: (source: string, installScope: RuntimePackageRecord["installScope"]) => Promise<string | undefined>;
}

export function ExtensionsView({
  workspace,
  runtime,
  commandCompatibility = [],
  onRefresh,
  onOpenExtensionFolder,
  onToggleExtension,
  onRemoveExtension,
  onInstallPackage,
  onUpdatePackage,
  onTogglePackage,
  onRemovePackage,
}: ExtensionsViewProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [installPending, setInstallPending] = useState(false);
  const [packageBrowserOpen, setPackageBrowserOpen] = useState(false);
  const [packagePendingSource, setPackagePendingSource] = useState<string | undefined>();
  const [packagePendingAction, setPackagePendingAction] = useState<"update" | "toggle" | "remove" | undefined>();
  const [feedbackMessage, setFeedbackMessage] = useState<string | undefined>();
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">("success");
  const [selectedExtensionPath, setSelectedExtensionPath] = useState<string | undefined>();
  const extensions = runtime?.extensions ?? [];
  const packages = runtime?.packages ?? [];
  const filteredExtensions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return extensions;
    }

    return extensions.filter((extension) =>
      [
        extension.displayName,
        extension.path,
        extension.sourceInfo.source,
        extensionScopeLabel(extension),
        extensionSourceSummary(extension),
        extension.sourceInfo.origin,
        ...extension.commands,
        ...extension.tools,
        ...extension.flags,
        ...extension.shortcuts,
        ...extension.diagnostics.map((diagnostic) => diagnostic.message),
      ].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [extensions, query]);
  const selectedExtension =
    filteredExtensions.find((extension) => extension.path === selectedExtensionPath) ?? filteredExtensions[0];
  const selectedExtensionCanBeManaged = selectedExtension ? isManageableExtension(selectedExtension) : false;
  const associatedPackage = useMemo(() => {
    if (!selectedExtension) {
      return undefined;
    }

    return packages.find((pkg) => pkg.source === selectedExtension.sourceInfo.source);
  }, [packages, selectedExtension]);
  const selectedCompatibilityRecords = useMemo(
    () =>
      selectedExtension
        ? commandCompatibility
            .filter((record) => record.extensionPath === selectedExtension.path)
            .sort((left, right) => left.commandName.localeCompare(right.commandName))
        : [],
    [commandCompatibility, selectedExtension],
  );

  const handleInstall = async () => {
    const parsedCommand = parseInstallCommand(installCommand, t);
    if ("error" in parsedCommand) {
      setFeedbackTone("error");
      setFeedbackMessage(parsedCommand.error);
      return;
    }

    setInstallPending(true);
    setFeedbackMessage(undefined);
    try {
      const error = await onInstallPackage(parsedCommand.source);
      if (error) {
        setFeedbackTone("error");
        setFeedbackMessage(error);
        return;
      }

      setInstallCommand("");
      setFeedbackTone("success");
      setFeedbackMessage(t("extensions.installed", { source: parsedCommand.source }));
    } finally {
      setInstallPending(false);
    }
  };

  const handleUpdatePackage = async (pkg: RuntimePackageRecord) => {
    setPackagePendingSource(pkg.source);
    setPackagePendingAction("update");
    setFeedbackMessage(undefined);
    try {
      const error = await onUpdatePackage(pkg.source, pkg.installScope);
      if (error) {
        setFeedbackTone("error");
        setFeedbackMessage(error);
        return;
      }

      setFeedbackTone("success");
      setFeedbackMessage(t("extensions.updated", { name: packageDisplayName(pkg) }));
    } finally {
      setPackagePendingSource(undefined);
      setPackagePendingAction(undefined);
    }
  };

  const handleTogglePackage = async (pkg: RuntimePackageRecord) => {
    setPackagePendingSource(pkg.source);
    setPackagePendingAction("toggle");
    setFeedbackMessage(undefined);
    try {
      const error = await onTogglePackage(pkg.source, !pkg.enabled);
      if (error) {
        setFeedbackTone("error");
        setFeedbackMessage(error);
        return;
      }

      setFeedbackTone("success");
      setFeedbackMessage(t("extensions.toggled", { action: pkg.enabled ? t("extensions.disabled") : t("extensions.enabled"), name: packageDisplayName(pkg) }));
    } finally {
      setPackagePendingSource(undefined);
      setPackagePendingAction(undefined);
    }
  };

  const handleRemovePackage = async (pkg: RuntimePackageRecord) => {
    const confirmed = window.confirm(
      t("extensions.confirmUninstallPkg", { name: packageDisplayName(pkg), source: pkg.source }),
    );
    if (!confirmed) {
      return;
    }

    setPackagePendingSource(pkg.source);
    setPackagePendingAction("remove");
    setFeedbackMessage(undefined);
    try {
      const error = await onRemovePackage(pkg.source, pkg.installScope);
      if (error) {
        setFeedbackTone("error");
        setFeedbackMessage(error);
        return;
      }

      setFeedbackTone("success");
      setFeedbackMessage(t("extensions.uninstalledPkg", { name: packageDisplayName(pkg) }));
    } finally {
      setPackagePendingSource(undefined);
      setPackagePendingAction(undefined);
    }
  };

  const handleRemoveExtension = async (extension: RuntimeExtensionRecord) => {
    const confirmed = window.confirm(
      t("extensions.confirmUninstallExt", { name: extension.displayName, path: extension.path }),
    );
    if (!confirmed) {
      return;
    }

    setFeedbackMessage(undefined);
    try {
      const error = await onRemoveExtension(extension.path);
      if (error) {
        setFeedbackTone("error");
        setFeedbackMessage(error);
        return;
      }

      setFeedbackTone("success");
      setFeedbackMessage(t("extensions.uninstalledExt", { name: extension.displayName }));
    } catch (error) {
      setFeedbackTone("error");
      setFeedbackMessage(error instanceof Error ? error.message : t("extensions.uninstallFailed"));
    }
  };

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">{t("extensions.eyebrow")}</div>
          <h1>{t("extensions.selectWorkspace")}</h1>
          <p>{t("extensions.selectWorkspaceDesc")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation skills-view">
        <header className="view-header">
          <div>
            <div className="chat-header__eyebrow">{t("extensions.eyebrow")}</div>
            <h1 className="view-header__title">{t("extensions.title")}</h1>
            <p className="view-header__body">
              {t("extensions.headerBody")}
            </p>
          </div>
          <div className="view-header__actions">
            <button className="button button--secondary" type="button" onClick={onRefresh}>
              <RefreshIcon />
              <span>{t("extensions.refresh")}</span>
            </button>
          </div>
        </header>

        <div className="skills-toolbar">
          <div className="extensions-install-row">
            <input
              aria-label={t("extensions.packageInstallCmd")}
              className="skills-search extensions-install-input"
              data-testid="install-package-command"
              placeholder={t("extensions.installPlaceholder")}
              value={installCommand}
              onChange={(event) => {
                setInstallCommand(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                void handleInstall();
              }}
            />
            <button
              className="button button--primary"
              data-testid="install-package-button"
              disabled={installPending}
              type="button"
              onClick={() => {
                void handleInstall();
              }}
            >
              {installPending ? t("extensions.installing") : t("extensions.install")}
            </button>
            <button
              aria-expanded={packageBrowserOpen}
              className="button button--secondary"
              data-testid="package-browser-button"
              type="button"
              onClick={() => {
                setPackageBrowserOpen(true);
              }}
            >
              {t("extensions.browser")}
            </button>
          </div>
          {packageBrowserOpen ? (
            <div className="extensions-package-browser" data-testid="package-browser-panel">
              <div className="extensions-package-browser__header">
                <div>
                  <div className="skill-detail__meta-label">{t("extensions.packageBrowser")}</div>
                  <div className="extensions-package-browser__hint">
                    {t("extensions.browserHint")}
                  </div>
                </div>
                <button
                  className="button button--secondary"
                  data-testid="package-browser-close"
                  type="button"
                  onClick={() => {
                    setPackageBrowserOpen(false);
                  }}
                >
                  {t("extensions.close")}
                </button>
              </div>
              <webview
                allowpopups={true}
                className="extensions-package-browser__webview"
                data-testid="package-browser-webview"
                partition="persist:pi-package-browser"
                src={packageBrowserUrl}
              />
            </div>
          ) : null}
          <input
            aria-label={t("extensions.search")}
            className="skills-search"
            placeholder={t("extensions.search")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          {feedbackMessage ? (
            <div
              className={`extensions-feedback extensions-feedback--${feedbackTone}`}
              role={feedbackTone === "error" ? "alert" : "status"}
            >
              {feedbackMessage}
            </div>
          ) : null}
        </div>

        <div className="skills-layout">
          <div className="skills-grid" data-testid="extensions-list">
            {filteredExtensions.length === 0 ? (
              <ExtensionsEmptyState message={t("extensions.emptyRefresh")} />
            ) : (
              filteredExtensions.map((extension) => (
                <button
                  className={`skill-card ${selectedExtension?.path === extension.path ? "skill-card--active" : ""}`}
                  key={extension.path}
                  type="button"
                  onClick={() => {
                    setSelectedExtensionPath(extension.path);
                  }}
                >
                  <span className="skill-card__title-row">
                    <span className="skill-card__title">{extension.displayName}</span>
                    <span className={`skill-card__badge ${extension.enabled ? "skill-card__badge--enabled" : ""}`}>
                      {extension.enabled ? t("extensions.enabled") : t("extensions.disabled")}
                    </span>
                  </span>
                  <span className="skill-card__description">
                    {extensionSourceSummary(extension)}
                  </span>
                  <span className="skill-card__meta">
                    <span>{extension.sourceInfo.source}</span>
                    {extension.commands.length > 0 ? <span>{t("extensions.commands", { count: extension.commands.length })}</span> : null}
                    {extension.tools.length > 0 ? <span>{t("extensions.tools", { count: extension.tools.length })}</span> : null}
                    {extension.diagnostics.length > 0 ? <span>{t("extensions.issues", { count: extension.diagnostics.length })}</span> : null}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="skill-detail">
            {selectedExtension ? (
              <>
                <div className="skill-detail__header">
                  <div>
                    <h2>{selectedExtension.displayName}</h2>
                    <div className="skill-detail__slash">{selectedExtension.sourceInfo.source}</div>
                  </div>
                  <span className={`skill-detail__status ${selectedExtension.enabled ? "skill-detail__status--enabled" : ""}`}>
                    {selectedExtension.enabled ? t("extensions.enabled") : t("extensions.disabled")}
                  </span>
                </div>
                <div className="skill-detail__meta-list">
                  <DetailItem label={t("extensions.scope")} value={extensionScopeLabel(selectedExtension)} />
                  <DetailItem label={t("extensions.origin")} value={selectedExtension.sourceInfo.origin} />
                  <DetailItem label={t("extensions.path")} value={selectedExtension.path} mono />
                  {selectedExtension.sourceInfo.baseDir ? (
                    <DetailItem label={t("extensions.baseDir")} value={selectedExtension.sourceInfo.baseDir} mono />
                  ) : null}
                </div>
                {selectedExtensionCanBeManaged ? (
                  <div className="skill-detail__actions">
                    <button className="button button--secondary" type="button" onClick={() => onOpenExtensionFolder(selectedExtension.path)}>
                      {t("extensions.openFolder")}
                    </button>
                    {associatedPackage ? (
                      <>
                        <button
                          className="button button--secondary"
                          data-testid="update-package-button"
                          disabled={packagePendingSource === associatedPackage.source || associatedPackage.sourceType === "local"}
                          title={associatedPackage.sourceType === "local" ? t("extensions.localPathHint") : undefined}
                          type="button"
                          onClick={() => {
                            void handleUpdatePackage(associatedPackage);
                          }}
                        >
                          {packagePendingSource === associatedPackage.source && packagePendingAction === "update" ? t("extensions.updating") : t("extensions.update")}
                        </button>
                        <button
                          className="button button--secondary"
                          disabled={packagePendingSource === associatedPackage.source}
                          type="button"
                          onClick={() => {
                            void handleTogglePackage(associatedPackage);
                          }}
                        >
                          {packagePendingSource === associatedPackage.source && packagePendingAction === "toggle"
                            ? associatedPackage.enabled
                              ? t("extensions.disabling")
                              : t("extensions.enabling")
                            : associatedPackage.enabled
                              ? t("extensions.disable")
                              : t("extensions.enable")}
                        </button>
                        <button
                          className="button button--danger"
                          disabled={packagePendingSource === associatedPackage.source}
                          type="button"
                          onClick={() => {
                            void handleRemovePackage(associatedPackage);
                          }}
                        >
                          {packagePendingSource === associatedPackage.source && packagePendingAction === "remove" ? t("extensions.uninstalling") : t("extensions.uninstall")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => onToggleExtension(selectedExtension.path, !selectedExtension.enabled)}
                      >
                        {selectedExtension.enabled ? t("extensions.disable") : t("extensions.enable")}
                      </button>
                    )}
                    {selectedExtension.sourceInfo.origin === "top-level" && !associatedPackage ? (
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => {
                          void handleRemoveExtension(selectedExtension);
                        }}
                      >
                        {t("extensions.uninstall")}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <ExtensionContributionSection title={t("extensions.commandsTitle")} items={selectedExtension.commands} emptyLabel={t("extensions.noCommands")} />
                <ExtensionCompatibilitySection
                  commands={selectedExtension.commands}
                  compatibilityRecords={selectedCompatibilityRecords}
                />
                <ExtensionContributionSection title={t("extensions.toolsTitle")} items={selectedExtension.tools} emptyLabel={t("extensions.noTools")} />
                <ExtensionContributionSection title={t("extensions.flags")} items={selectedExtension.flags} emptyLabel={t("extensions.noFlags")} />
                <ExtensionContributionSection title={t("extensions.shortcuts")} items={selectedExtension.shortcuts} emptyLabel={t("extensions.noShortcuts")} />
                <ExtensionDiagnostics diagnostics={selectedExtension.diagnostics} />
              </>
            ) : (
              <ExtensionsEmptyState message={t("extensions.emptyRefreshRuntime")} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function isManageableExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.origin === "top-level" || extension.sourceInfo.scope === "project" || extension.sourceInfo.scope === "user";
}

function DetailItem({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div>
      <div className="skill-detail__meta-label">{label}</div>
      <div className={mono ? "skill-detail__path" : "skill-detail__description"}>{value}</div>
    </div>
  );
}

function ExtensionContributionSection({
  title,
  items,
  emptyLabel,
}: {
  readonly title: string;
  readonly items: readonly string[];
  readonly emptyLabel: string;
}) {
  return (
    <div className="skill-detail__meta-list">
      <div>
        <div className="skill-detail__meta-label">{title}</div>
        {items.length > 0 ? (
          <div className="extension-detail__tokens">
            {items.map((item) => (
              <span className="slash-menu__skill-badge" key={item}>
                {item}
              </span>
            ))}
          </div>
        ) : (
          <div className="skill-detail__description">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function ExtensionDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: RuntimeExtensionRecord["diagnostics"];
}) {
  const { t } = useI18n();
  return (
    <div className="skill-detail__meta-list">
      <div>
        <div className="skill-detail__meta-label">{t("extensions.diagnostics")}</div>
        {diagnostics.length > 0 ? (
          <div className="extension-detail__diagnostics">
            {diagnostics.map((diagnostic, index) => (
              <div className={`activity-item activity-item--${diagnostic.type === "error" ? "error" : "info"}`} key={`${diagnostic.message}:${index}`}>
                <div className="activity-item__text">{diagnostic.message}</div>
                {diagnostic.path ? <div className="activity-item__meta">{diagnostic.path}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="skill-detail__description">{t("extensions.noDiagnostics")}</div>
        )}
      </div>
    </div>
  );
}

function ExtensionCompatibilitySection({
  commands,
  compatibilityRecords,
}: {
  readonly commands: readonly string[];
  readonly compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[];
}) {
  const { t } = useI18n();
  const supported = compatibilityRecords.filter((record) => record.status === "supported");
  const terminalOnly = compatibilityRecords.filter((record) => record.status === "terminal-only");
  const unknown = commands.filter((commandName) =>
    compatibilityRecords.every(
      (record) => record.commandName !== commandName && !record.commandName.startsWith(`${commandName}:`),
    ),
  );

  return (
    <div className="skill-detail__meta-list">
      <div>
        <div className="skill-detail__meta-label">{t("extensions.compatibility")}</div>
        <div className="skill-detail__description">
          {t("extensions.compatibilityDesc")}
        </div>
        <div className="extension-detail__tokens">
          {supported.map((record) => (
            <span className="slash-menu__skill-badge" key={`supported:${record.commandName}`}>
              {record.commandName} · {t("extensions.guiCompatible")}
            </span>
          ))}
          {terminalOnly.map((record) => (
            <span className="slash-menu__skill-badge slash-menu__skill-badge--warning" key={`terminal:${record.commandName}`}>
              {record.commandName} · {t("extensions.terminalOnly")}
            </span>
          ))}
          {unknown.map((commandName) => (
            <span className="slash-menu__skill-badge" key={`unknown:${commandName}`}>
              {commandName} · {t("extensions.unknown")}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExtensionsEmptyState({ message }: { readonly message: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state">
      <h2>{t("extensions.noExtensions")}</h2>
      <p>{message}</p>
    </div>
  );
}

function parseInstallCommand(command: string, t: (key: string, params?: Record<string, string | number>) => string): { source: string } | { error: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { error: t("extensions.errorPasteFirst") };
  }

  const prefixMatch = trimmed.match(/^pi\s+install\b/i);
  if (!prefixMatch) {
    return { error: t("extensions.errorFullCommand") };
  }

  const remainder = trimmed.slice(prefixMatch[0].length).trim();
  if (!remainder) {
    return { error: t("extensions.errorAddSource") };
  }

  if (
    remainder === "-l" ||
    remainder.startsWith("-l ") ||
    remainder === "--local" ||
    remainder.startsWith("--local ")
  ) {
    return { error: t("extensions.errorGlobalOnly") };
  }

  const source = stripWrappingQuotes(remainder);
  if (!source) {
    return { error: t("extensions.errorAddSource") };
  }

  return { source };
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function packageDisplayName(pkg: RuntimePackageRecord): string {
  if (pkg.sourceType === "npm") {
    const match = pkg.source.match(/^npm:((?:@[^/@]+\/)?[^@]+)(?:@.+)?$/);
    if (match?.[1]) {
      return match[1];
    }
  }

  if (pkg.sourceType === "local") {
    const normalized = pkg.source.replace(/\/+$/, "");
    const segments = normalized.split(/[\\/]/);
    return segments[segments.length - 1] || pkg.source;
  }

  const trimmed = pkg.source.replace(/^git:/, "").replace(/\/+$/, "");
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? pkg.source;
}

function packageSourceTypeLabel(pkg: RuntimePackageRecord): string {
  if (pkg.sourceType === "npm") {
    return "npm";
  }

  if (pkg.sourceType === "git") {
    return "git";
  }

  return "local path";
}
