import type { DesktopNotificationPermissionStatus } from "./ipc";
import type { NotificationPreferences } from "./desktop-state";
import { useI18n } from "./i18n";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsNotificationsSectionProps {
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
}

export function SettingsNotificationsSection({
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  onSetNotificationPreferences,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
}: SettingsNotificationsSectionProps) {
  const { t } = useI18n();
  const statusLabel = labelForPermissionStatus(notificationPermissionStatus, t);
  const statusDescription = descriptionForPermissionStatus(notificationPermissionStatus, t);
  const showAskMacOs = notificationPermissionStatus === "default";
  const showOpenSystemSettings = notificationPermissionStatus === "denied";
  const showRecoveryActions = showAskMacOs || showOpenSystemSettings;

  return (
    <>
      <SettingsGroup title={t("settings.notifications.system")} description={t("settings.notifications.systemDesc")}>
        <SettingsRow title={t("settings.notifications.macosAccess")} description={statusDescription}>
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title={t("settings.notifications.turnOn")}
            description={
              showAskMacOs
                ? t("settings.notifications.turnOnDescActive")
                : t("settings.notifications.turnOnDescDenied")
            }
          >
            <div className="settings-row__actions">
              {showAskMacOs ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onRequestNotificationPermission}
                >
                  {t("settings.notifications.askMacos")}
                </button>
              ) : null}
              {showOpenSystemSettings ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onOpenSystemNotificationSettings}
                >
                  {t("settings.notifications.openSystemSettings")}
                </button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.notifications.inApp")} description={t("settings.notifications.inAppDesc")}>
        <SettingsRow title={t("settings.notifications.backgroundCompletion")} description={t("settings.notifications.backgroundCompletionDesc")}>
          <input
            aria-label={t("settings.notifications.backgroundCompletion")}
            checked={notificationPreferences.backgroundCompletion}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundCompletion: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.notifications.backgroundFailures")} description={t("settings.notifications.backgroundFailuresDesc")}>
          <input
            aria-label={t("settings.notifications.backgroundFailures")}
            checked={notificationPreferences.backgroundFailure}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ backgroundFailure: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.notifications.needsInput")} description={t("settings.notifications.needsInputDesc")}>
          <input
            aria-label={t("settings.notifications.needsInput")}
            checked={notificationPreferences.attentionNeeded}
            type="checkbox"
            onChange={(event) => onSetNotificationPreferences({ attentionNeeded: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function labelForPermissionStatus(
  status: DesktopNotificationPermissionStatus,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.permission.granted");
    case "denied":
      return t("settings.notifications.permission.denied");
    case "default":
      return t("settings.notifications.permission.default");
    case "unsupported":
      return t("settings.notifications.permission.unsupported");
    default:
      return t("settings.notifications.permission.unknown");
  }
}

function descriptionForPermissionStatus(
  status: DesktopNotificationPermissionStatus,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (status) {
    case "granted":
      return t("settings.notifications.desc.granted");
    case "denied":
      return t("settings.notifications.desc.denied");
    case "default":
      return t("settings.notifications.desc.default");
    case "unsupported":
      return t("settings.notifications.desc.unsupported");
    default:
      return t("settings.notifications.desc.unknown");
  }
}
