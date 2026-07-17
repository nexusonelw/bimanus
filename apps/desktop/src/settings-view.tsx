import type { RuntimeSettingsSnapshot, RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import type { CliEnablementMap } from "./cli-enablement";
import type { LocaleSetting, McpServerConfig, McpServerConfigInput, NotificationPreferences, RemoteUiStatus, WorkspaceRecord } from "./desktop-state";
import type { CliDetectionMap, DesktopNotificationPermissionStatus } from "./ipc";
import { useI18n } from "./i18n";
import { SettingsAppearanceSection } from "./settings-appearance-section";
import { SettingsCliSection } from "./settings-cli-section";
import { SettingsGeneralSection } from "./settings-general-section";
import { SettingsModelsSection } from "./settings-models-section";
import { SettingsMcpSection } from "./settings-mcp-section";
import { SettingsNotificationsSection } from "./settings-notifications-section";
import { SettingsProvidersSection } from "./settings-providers-section";
import { type SettingsSection, sectionTitle, sectionDescription } from "./settings-utils";

export type { SettingsSection } from "./settings-utils";

interface SettingsViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly section: SettingsSection;
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly integratedTerminalShell: string;
  readonly tuiTabLimit: number;
  readonly remoteUiPort: number;
  readonly remoteUiToken: string;
  readonly remoteUiStatus: RemoteUiStatus;
  readonly themeMode: "system" | "light" | "dark";
  readonly enableTransparency: boolean;
  readonly tuiBgColor: string;
  readonly splitPanelBgColor: string;
  readonly locale: LocaleSetting;
  readonly mcpServers: readonly McpServerConfig[];
  readonly cliEnablement: CliEnablementMap;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onSetProviderApiKey: (providerId: string, apiKey: string) => Promise<string | undefined>;
  readonly onRemoveProviderApiKey: (providerId: string) => Promise<string | undefined>;
  readonly onAddMcpServer: (input: McpServerConfigInput) => Promise<string | undefined>;
  readonly onUpdateMcpServer: (serverId: string, input: McpServerConfigInput) => Promise<string | undefined>;
  readonly onRemoveMcpServer: (serverId: string) => Promise<string | undefined>;
  readonly onAuthorizeMcpServer: (serverId: string) => Promise<string | undefined>;
  readonly onSetMcpServerEnabled: (serverId: string, enabled: boolean) => Promise<string | undefined>;
  readonly onSetCliEnabled: (cliType: string, enabled: boolean) => Promise<string | undefined>;
  readonly onDetectAllCli: () => Promise<CliDetectionMap>;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onSetTuiTabLimit: (limit: number) => void;
  readonly onSetRemoteUiPort: (port: number) => void;
  readonly onSetRemoteUiToken: (token: string) => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
  readonly onSetThemeMode: (mode: "system" | "light" | "dark") => void;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
  readonly onSetTuiBgColor: (color: string) => void;
  readonly onSetSplitPanelBgColor: (color: string) => void;
  readonly onSetLocale: (locale: LocaleSetting) => void;
}

export function SettingsView({
  workspace,
  runtime,
  section,
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  integratedTerminalShell,
  tuiTabLimit,
  remoteUiPort,
  remoteUiToken,
  remoteUiStatus,
  themeMode,
  enableTransparency,
  tuiBgColor,
  splitPanelBgColor,
  locale,
  mcpServers,
  cliEnablement,
  onSetDefaultModel,
  onSetThinkingLevel,
  onToggleSkillCommands,
  onSetScopedModelPatterns,
  onLoginProvider,
  onLogoutProvider,
  onSetProviderApiKey,
  onRemoveProviderApiKey,
  onAddMcpServer,
  onUpdateMcpServer,
  onRemoveMcpServer,
  onAuthorizeMcpServer,
  onSetMcpServerEnabled,
  onSetCliEnabled,
  onDetectAllCli,
  onSetNotificationPreferences,
  onSetIntegratedTerminalShell,
  onSetTuiTabLimit,
  onSetRemoteUiPort,
  onSetRemoteUiToken,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
  onSetThemeMode,
  onSetEnableTransparency,
  onSetTuiBgColor,
  onSetSplitPanelBgColor,
  onSetLocale,
}: SettingsViewProps) {
  const { t } = useI18n();
  if (
    !workspace &&
    section !== "general" &&
    section !== "notifications" &&
    section !== "appearance" &&
    section !== "providers" &&
    section !== "models" &&
    section !== "mcp" &&
    section !== "cli"
  ) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">{t("settings.title")}</div>
          <h1>{t("settings.selectWorkspace")}</h1>
          <p>{t("settings.selectWorkspaceBody")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation settings-view">
        <header className="view-header">
          <div>
            <div className="chat-header__eyebrow">{t("settings.title")}</div>
            <h1 className="view-header__title">{sectionTitle(section, t)}</h1>
            <p className="view-header__body">
              {sectionDescription(section, workspace?.name ?? t("settings.globalSettings"), t)}
            </p>
          </div>
        </header>

        <div className="settings-grid">
          {section === "appearance" ? (
            <SettingsAppearanceSection
              themeMode={themeMode}
              onSetThemeMode={onSetThemeMode}
              enableTransparency={enableTransparency}
              onSetEnableTransparency={onSetEnableTransparency}
              tuiBgColor={tuiBgColor}
              onSetTuiBgColor={onSetTuiBgColor}
              splitPanelBgColor={splitPanelBgColor}
              onSetSplitPanelBgColor={onSetSplitPanelBgColor}
              locale={locale}
              onSetLocale={onSetLocale}
            />
          ) : null}

          {section === "general" ? (
            <SettingsGeneralSection
              runtime={runtime}
              integratedTerminalShell={integratedTerminalShell}
              tuiTabLimit={tuiTabLimit}
              remoteUiPort={remoteUiPort}
              remoteUiToken={remoteUiToken}
              remoteUiStatus={remoteUiStatus}
              onSetIntegratedTerminalShell={onSetIntegratedTerminalShell}
              onSetTuiTabLimit={onSetTuiTabLimit}
              onSetRemoteUiPort={onSetRemoteUiPort}
              onSetRemoteUiToken={onSetRemoteUiToken}
              onToggleSkillCommands={onToggleSkillCommands}
            />
          ) : null}

          {section === "providers" ? (
            <SettingsProvidersSection
              runtime={runtime}
              onLoginProvider={onLoginProvider}
              onLogoutProvider={onLogoutProvider}
              onSetProviderApiKey={onSetProviderApiKey}
              onRemoveProviderApiKey={onRemoveProviderApiKey}
            />
          ) : null}

          {section === "models" ? (
            <SettingsModelsSection
              runtime={runtime}
              onSetDefaultModel={onSetDefaultModel}
              onSetScopedModelPatterns={onSetScopedModelPatterns}
              onSetThinkingLevel={onSetThinkingLevel}
            />
          ) : null}

          {section === "mcp" ? (
            <SettingsMcpSection
              servers={mcpServers}
              onAddServer={onAddMcpServer}
              onUpdateServer={onUpdateMcpServer}
              onRemoveServer={onRemoveMcpServer}
              onAuthorizeServer={onAuthorizeMcpServer}
              onSetServerEnabled={onSetMcpServerEnabled}
            />
          ) : null}

          {section === "cli" ? (
            <SettingsCliSection
              cliEnablement={cliEnablement}
              onSetCliEnabled={onSetCliEnabled}
              detectAllCli={onDetectAllCli}
            />
          ) : null}

          {section === "notifications" ? (
            <SettingsNotificationsSection
              notificationPreferences={notificationPreferences}
              notificationPermissionStatus={notificationPermissionStatus}
              notificationPermissionPending={notificationPermissionPending}
              onSetNotificationPreferences={onSetNotificationPreferences}
              onRequestNotificationPermission={onRequestNotificationPermission}
              onOpenSystemNotificationSettings={onOpenSystemNotificationSettings}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
