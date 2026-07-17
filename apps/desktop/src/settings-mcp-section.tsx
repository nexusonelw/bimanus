import { useEffect, useMemo, useState } from "react";
import type { McpServerConfig, McpServerConfigInput } from "./desktop-state";
import { useI18n } from "./i18n";
import { SettingsGroup } from "./settings-utils";

interface SettingsMcpSectionProps {
  readonly servers: readonly McpServerConfig[];
  readonly onAddServer: (input: McpServerConfigInput) => Promise<string | undefined>;
  readonly onUpdateServer: (serverId: string, input: McpServerConfigInput) => Promise<string | undefined>;
  readonly onRemoveServer: (serverId: string) => Promise<string | undefined>;
  readonly onAuthorizeServer: (serverId: string) => Promise<string | undefined>;
  readonly onSetServerEnabled: (serverId: string, enabled: boolean) => Promise<string | undefined>;
}

const emptyDraft: McpServerConfigInput = {
  name: "",
  url: "",
  apiKey: "",
  oauthEnabled: false,
};

export function SettingsMcpSection({
  servers,
  onAddServer,
  onUpdateServer,
  onRemoveServer,
  onAuthorizeServer,
  onSetServerEnabled,
}: SettingsMcpSectionProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<McpServerConfigInput>(emptyDraft);
  const [editingServerId, setEditingServerId] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingForm, setPendingForm] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | undefined>();

  const editingServer = useMemo(
    () => servers.find((server) => server.id === editingServerId),
    [editingServerId, servers],
  );

  useEffect(() => {
    if (!editingServer) {
      setDraft(emptyDraft);
      setFormError(undefined);
      setPendingForm(false);
      return;
    }
    setDraft({
      name: editingServer.name,
      url: editingServer.url,
      apiKey: editingServer.apiKey ?? "",
      oauthEnabled: editingServer.oauthEnabled,
    });
    setFormError(undefined);
    setPendingForm(false);
  }, [editingServer]);

  const submitLabel = editingServer ? t("settings.mcp.save") : t("settings.mcp.add");

  const handleSubmit = async () => {
    const normalized = normalizeDraft(draft);
    const validationError = validateDraft(normalized, t);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setPendingForm(true);
    setFormError(undefined);
    const nextError = editingServer
      ? await onUpdateServer(editingServer.id, normalized)
      : await onAddServer(normalized);
    setPendingForm(false);
    if (nextError) {
      setFormError(nextError);
      return;
    }
    setEditingServerId(undefined);
    setDraft(emptyDraft);
  };

  const handleRemove = async (server: McpServerConfig) => {
    const confirmed = window.confirm(t("settings.mcp.confirmRemove", { name: server.name }));
    if (!confirmed) {
      return;
    }
    setPendingServerId(server.id);
    setFormError(undefined);
    const nextError = await onRemoveServer(server.id);
    setPendingServerId(undefined);
    if (nextError) {
      setFormError(nextError);
    }
  };

  const handleAuthorize = async (server: McpServerConfig) => {
    setPendingServerId(server.id);
    setFormError(undefined);
    const nextError = await onAuthorizeServer(server.id);
    setPendingServerId(undefined);
    if (nextError) {
      setFormError(nextError);
    }
  };

  const handleSetEnabled = async (server: McpServerConfig, enabled: boolean) => {
    setPendingServerId(server.id);
    setFormError(undefined);
    const nextError = await onSetServerEnabled(server.id, enabled);
    setPendingServerId(undefined);
    if (nextError) {
      setFormError(nextError);
    }
  };

  return (
    <>
      <SettingsGroup
        title={editingServer ? t("settings.mcp.editTitle") : t("settings.mcp.addTitle")}
        description={t("settings.mcp.description")}
      >
        <label className="settings-row">
          <span className="settings-row__label">
            <span className="settings-row__title">{t("settings.mcp.name")}</span>
            <span className="settings-row__description">{t("settings.mcp.nameDesc")}</span>
          </span>
          <span className="settings-row__control">
            <input
              aria-label={t("settings.mcp.name")}
              className="settings-search"
              disabled={pendingForm}
              placeholder={t("settings.mcp.namePlaceholder")}
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </span>
        </label>

        <label className="settings-row">
          <span className="settings-row__label">
            <span className="settings-row__title">{t("settings.mcp.url")}</span>
            <span className="settings-row__description">{t("settings.mcp.urlDesc")}</span>
          </span>
          <span className="settings-row__control">
            <input
              aria-label={t("settings.mcp.url")}
              className="settings-search"
              disabled={pendingForm}
              placeholder={t("settings.mcp.urlPlaceholder")}
              value={draft.url}
              onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
            />
          </span>
        </label>

        <label className="settings-row">
          <span className="settings-row__label">
            <span className="settings-row__title">{t("settings.mcp.apiKey")}</span>
            <span className="settings-row__description">{t("settings.mcp.apiKeyDesc")}</span>
          </span>
          <span className="settings-row__control">
            <input
              aria-label={t("settings.mcp.apiKey")}
              autoComplete="off"
              className="settings-search"
              disabled={pendingForm}
              placeholder={t("settings.mcp.apiKeyPlaceholder")}
              spellCheck={false}
              type="password"
              value={draft.apiKey ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
            />
          </span>
        </label>

        <label className="settings-row">
          <span className="settings-row__label">
            <span className="settings-row__title">{t("settings.mcp.oauth")}</span>
            <span className="settings-row__description">{t("settings.mcp.oauthDesc")}</span>
          </span>
          <span className="settings-row__control">
            <input
              aria-label={t("settings.mcp.enableOAuth")}
              checked={draft.oauthEnabled}
              disabled={pendingForm}
              type="checkbox"
              onChange={(event) => setDraft((current) => ({ ...current, oauthEnabled: event.target.checked }))}
            />
          </span>
        </label>

        {formError ? <p className="extension-dialog__body settings-warning">{formError}</p> : null}

        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">{editingServer ? t("settings.mcp.saveChanges") : t("settings.mcp.createServer")}</div>
          </div>
          <div className="settings-row__control">
            {editingServer ? (
              <button
                className="button button--secondary"
                disabled={pendingForm}
                type="button"
                onClick={() => setEditingServerId(undefined)}
              >
                {t("settings.mcp.cancel")}
              </button>
            ) : null}
            <button className="button" disabled={pendingForm} type="button" onClick={() => void handleSubmit()}>
              {pendingForm ? t("settings.mcp.saving") : submitLabel}
            </button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.mcp.configured")} description={t("settings.mcp.configuredDesc")}>
        {servers.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">{t("settings.mcp.noServers")}</span>
          </div>
        ) : (
          servers.map((server) => {
            const pending = pendingServerId === server.id;
            return (
              <div className="settings-row" key={server.id}>
                <div className="settings-row__label">
                  <div className="settings-row__title">{server.name}</div>
                  <div className="settings-row__description">
                    {server.url} · {describeEnabled(server, t)} · {describeAuthorization(server, t)} · {describeApiKey(server, t)}
                  </div>
                  {server.lastAuthError ? (
                    <div className="settings-row__description settings-warning">{server.lastAuthError}</div>
                  ) : null}
                </div>
                <div className="settings-row__control">
                  {server.oauthEnabled ? (
                    <button
                      className="button button--secondary"
                      disabled={pending}
                      type="button"
                      onClick={() => void handleAuthorize(server)}
                    >
                      {pending ? t("settings.mcp.authorizing") : server.authorized ? t("settings.mcp.reauthorize") : t("settings.mcp.authorize")}
                    </button>
                  ) : null}
                  <button
                    className="button button--secondary"
                    disabled={pending}
                    type="button"
                    onClick={() => void handleSetEnabled(server, !server.enabled)}
                  >
                    {server.enabled ? t("settings.mcp.disable") : t("settings.mcp.enable")}
                  </button>
                  <button
                    className="button button--secondary"
                    disabled={pending}
                    type="button"
                    onClick={() => setEditingServerId(server.id)}
                  >
                    {t("settings.mcp.edit")}
                  </button>
                  <button
                    className="button button--secondary"
                    disabled={pending}
                    type="button"
                    onClick={() => void handleRemove(server)}
                  >
                    {t("settings.mcp.delete")}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </SettingsGroup>
    </>
  );
}

function normalizeDraft(input: McpServerConfigInput): McpServerConfigInput {
  const apiKey = input.apiKey?.trim() ?? "";
  return {
    name: input.name.trim(),
    url: input.url.trim(),
    ...(apiKey ? { apiKey } : {}),
    oauthEnabled: Boolean(input.oauthEnabled),
  };
}

function validateDraft(input: McpServerConfigInput, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  if (!input.name) {
    return t("settings.mcp.errorName");
  }
  if (!isHttpUrl(input.url)) {
    return t("settings.mcp.errorUrl");
  }
  const knownConfigError = getKnownMcpServerConfigurationError(input.url, t);
  if (knownConfigError) {
    return knownConfigError;
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getKnownMcpServerConfigurationError(value: string, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "api.exa.ai" && parsed.pathname === "/search") {
      return t("settings.mcp.errorExa");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function describeApiKey(server: McpServerConfig, t: (key: string, params?: Record<string, string | number>) => string): string {
  return server.apiKey ? t("settings.mcp.apiKeyConfigured") : t("settings.mcp.noApiKey");
}

function describeEnabled(server: McpServerConfig, t: (key: string, params?: Record<string, string | number>) => string): string {
  return server.enabled ? t("settings.mcp.enabled") : t("settings.mcp.disabled");
}

function describeAuthorization(server: McpServerConfig, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!server.oauthEnabled) {
    return t("settings.mcp.oauthDisabled");
  }
  if (server.authorized) {
    return server.authorizedAt ? t("settings.mcp.oauthAuthorized", { date: server.authorizedAt }) : t("settings.mcp.oauthAuthorizedShort");
  }
  return t("settings.mcp.oauthNotAuthorized");
}
