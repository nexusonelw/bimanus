import type { ReactNode } from "react";
import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import { useI18n } from "./i18n";

export type SettingsSection = "appearance" | "general" | "providers" | "models" | "mcp" | "cli" | "notifications";

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export const THINKING_LEVELS: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export function settingsPill(active: boolean): string {
  return `settings-pill${active ? " settings-pill--active" : ""}`;
}

export function labelForThinking(
  level: NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  t?: TranslateFn,
): string {
  if (level === "xhigh") {
    return t ? t("thinking.xhigh") : "Extra High";
  }
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function sectionTitle(section: SettingsSection, t?: TranslateFn): string {
  switch (section) {
    case "appearance":
      return t ? t("settings.section.appearance.title") : "Appearance";
    case "providers":
      return t ? t("settings.section.providers.title") : "Providers";
    case "models":
      return t ? t("settings.section.models.title") : "Models";
    case "mcp":
      return t ? t("settings.section.mcp.title") : "MCP";
    case "cli":
      return t ? t("settings.section.cli.title") : "CLI";
    case "notifications":
      return t ? t("settings.section.notifications.title") : "Notifications";
    default:
      return t ? t("settings.section.general.title") : "General";
  }
}

export function sectionDescription(section: SettingsSection, workspaceName: string, t?: TranslateFn): string {
  switch (section) {
    case "appearance":
      return t ? t("settings.section.appearance.description") : "Choose theme, soft Chinese-color surfaces for TUI/split panel, and window transparency.";
    case "providers":
      if (t) {
        return workspaceName === t("settings.globalSettings")
          ? t("settings.section.providers.description.global")
          : t("settings.section.providers.description.workspace", { workspace: workspaceName });
      }
      return workspaceName === "global settings"
        ? "Connect providers and manage global authentication for all workspaces."
        : `Connect providers and manage auth for ${workspaceName}.`;
    case "models":
      return t ? t("settings.section.models.description") : "Choose the default model and which models appear in pickers.";
    case "mcp":
      return t ? t("settings.section.mcp.description") : "Configure global HTTP MCP servers and OAuth authorization.";
    case "cli":
      return t ? t("settings.section.cli.description") : "Detect installed coding CLIs and choose which ones are available in session menus and remote calls.";
    case "notifications":
      return t ? t("settings.section.notifications.description") : "Manage both macOS notification access and which background events should alert you.";
    default:
      return t ? t("settings.section.general.description") : "Keep the high-value app and runtime controls close to hand.";
  }
}

export function filterProviders(
  providers: readonly RuntimeSnapshot["providers"][number][],
  query: string,
): readonly RuntimeSnapshot["providers"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return providers;
  }
  return providers.filter((provider) =>
    [provider.id, provider.name, provider.authType].some((value) => value.toLowerCase().includes(normalized)),
  );
}

export function filterModels(
  models: readonly RuntimeSnapshot["models"][number][],
  query: string,
): readonly RuntimeSnapshot["models"][number][] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }
  return models.filter((model) =>
    [model.providerId, model.providerName, model.modelId, model.label].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

/* ── Layout components ────────────────────────────────── */

export function SettingsGroup({
  title,
  description,
  children,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-section">
      {(title || description) ? (
        <div className="settings-section__header">
          {title ? <h3 className="settings-section__title">{title}</h3> : null}
          {description ? <p className="settings-section__description">{description}</p> : null}
        </div>
      ) : null}
      <div className="settings-group">{children}</div>
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{title}</div>
        {description ? <div className="settings-row__description">{description}</div> : null}
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}

export function SettingsInfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{label}</div>
      </div>
      <div className="settings-row__control">
        <span className="settings-row__value">{value}</span>
      </div>
    </div>
  );
}

export function ProviderRow({
  provider,
  onLoginProvider,
  onLogoutProvider,
  onConfigureApiKey,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void;
}) {
  const { t } = useI18n();
  const action = resolveProviderAction(provider, onLoginProvider, onLogoutProvider, onConfigureApiKey, t);
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <div className="settings-row__title">{provider.name}</div>
        <div className="settings-row__description">{describeProviderStatus(provider, t)}</div>
      </div>
      <div className="settings-row__control">
        <button
          className="button button--secondary"
          disabled={action.disabled}
          type="button"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}

function describeProviderStatus(provider: RuntimeSnapshot["providers"][number], t: TranslateFn): string {
  switch (provider.authSource) {
    case "oauth":
      return t("settings.provider.status.oauthConnected");
    case "auth_file":
      return t("settings.provider.status.apiKeyConnected");
    case "env":
      return t("settings.provider.status.envConnected");
    case "external":
      return provider.hasAuth ? t("settings.provider.status.externalConnected") : t("settings.provider.status.configureExternally");
    default:
      if (provider.oauthSupported) {
        return t("settings.provider.status.oauth");
      }
      if (provider.apiKeySetupSupported) {
        return t("settings.provider.status.apiKey");
      }
      return provider.authType === "api_key" ? t("settings.provider.status.apiKey") : t("settings.provider.status.builtIn");
  }
}

function resolveProviderAction(
  provider: RuntimeSnapshot["providers"][number],
  onLoginProvider: (providerId: string) => void,
  onLogoutProvider: (providerId: string) => void,
  onConfigureApiKey: (provider: RuntimeSnapshot["providers"][number]) => void,
  t: TranslateFn,
): {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick?: () => void;
} {
  if (provider.authSource === "oauth") {
    return {
      disabled: false,
      label: t("settings.provider.action.logout"),
      onClick: () => onLogoutProvider(provider.id),
    };
  }

  if (provider.oauthSupported && provider.authSource === "none") {
    return {
      disabled: false,
      label: t("settings.provider.action.login"),
      onClick: () => onLoginProvider(provider.id),
    };
  }

  if (
    provider.apiKeySetupSupported &&
    (provider.authSource === "none" ||
      provider.authSource === "auth_file" ||
      provider.authSource === "env" ||
      provider.authSource === "external")
  ) {
    return {
      disabled: false,
      label: provider.authSource === "auth_file" ? t("settings.provider.action.manage") : t("settings.provider.action.setApiKey"),
      onClick: () => onConfigureApiKey(provider),
    };
  }

  return {
    disabled: true,
    label: provider.authSource === "env" || provider.authSource === "external" ? t("settings.provider.action.managedExternally") : t("settings.provider.action.configureExternally"),
  };
}
