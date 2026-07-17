import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import {
  MAX_REMOTE_UI_PORT,
  MAX_TUI_TAB_LIMIT,
  MIN_REMOTE_UI_PORT,
  MIN_TUI_TAB_LIMIT,
  normalizeRemoteUiPort,
  normalizeTuiTabLimit,
  type RemoteUiStatus,
} from "./desktop-state";
import { useI18n } from "./i18n";
import { SettingsGroup, SettingsInfoRow, SettingsRow } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly integratedTerminalShell: string;
  readonly tuiTabLimit: number;
  readonly remoteUiPort: number;
  readonly remoteUiToken: string;
  readonly remoteUiStatus: RemoteUiStatus;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onSetTuiTabLimit: (limit: number) => void;
  readonly onSetRemoteUiPort: (port: number) => void;
  readonly onSetRemoteUiToken: (token: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  integratedTerminalShell,
  tuiTabLimit,
  remoteUiPort,
  remoteUiToken,
  remoteUiStatus,
  onSetIntegratedTerminalShell,
  onSetTuiTabLimit,
  onSetRemoteUiPort,
  onSetRemoteUiToken,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  const { t } = useI18n();
  const connectedCount = runtime?.providers.filter((p) => p.hasAuth).length ?? 0;
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);
  const [tuiTabLimitDraft, setTuiTabLimitDraft] = useState(String(normalizeTuiTabLimit(tuiTabLimit)));
  const [remoteUiPortDraft, setRemoteUiPortDraft] = useState(String(normalizeRemoteUiPort(remoteUiPort)));
  const [remoteUiTokenDraft, setRemoteUiTokenDraft] = useState(remoteUiToken);

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  useEffect(() => {
    setTuiTabLimitDraft(String(normalizeTuiTabLimit(tuiTabLimit)));
  }, [tuiTabLimit]);

  useEffect(() => {
    setRemoteUiPortDraft(String(normalizeRemoteUiPort(remoteUiPort)));
  }, [remoteUiPort]);

  useEffect(() => {
    setRemoteUiTokenDraft(remoteUiToken);
  }, [remoteUiToken]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  const commitTuiTabLimitDraft = () => {
    const nextLimit = normalizeTuiTabLimit(tuiTabLimitDraft);
    setTuiTabLimitDraft(String(nextLimit));
    if (nextLimit !== normalizeTuiTabLimit(tuiTabLimit)) {
      onSetTuiTabLimit(nextLimit);
    }
  };

  const commitRemoteUiPortDraft = () => {
    const nextPort = normalizeRemoteUiPort(remoteUiPortDraft);
    setRemoteUiPortDraft(String(nextPort));
    if (nextPort !== normalizeRemoteUiPort(remoteUiPort)) {
      onSetRemoteUiPort(nextPort);
    }
  };

  const commitRemoteUiTokenDraft = () => {
    if (remoteUiTokenDraft !== remoteUiToken) {
      onSetRemoteUiToken(remoteUiTokenDraft);
    }
  };

  const remoteUiStatusLabel = (() => {
    switch (remoteUiStatus.state) {
      case "disabled":
        return t("settings.general.remoteUi.disabled");
      case "stopped":
        return t("settings.general.remoteUi.stopped");
      case "starting":
        return t("settings.general.remoteUi.starting");
      case "running":
        return remoteUiStatus.url ? t("settings.general.remoteUi.running", { url: remoteUiStatus.url }) : t("settings.general.remoteUi.runningShort");
      case "error":
        return remoteUiStatus.error ? t("settings.general.remoteUi.error", { error: remoteUiStatus.error }) : t("settings.general.remoteUi.errorShort");
      default:
        return remoteUiStatus.state;
    }
  })();

  return (
    <>
      <SettingsGroup title={t("settings.general.group")}>
        <SettingsInfoRow
          label={t("settings.general.connectedProviders")}
          value={connectedCount > 0 ? String(connectedCount) : t("settings.general.none")}
        />
        <SettingsInfoRow label={t("settings.general.discoveredSkills")} value={String(runtime?.skills.length ?? 0)} />
        <SettingsRow title={t("settings.general.enableSkillSlash")} description={t("settings.general.enableSkillSlashDesc")}>
          <input
            aria-label={t("settings.general.enableSkillSlash")}
            checked={runtime?.settings.enableSkillCommands ?? true}
            type="checkbox"
            onChange={(event) => onToggleSkillCommands(event.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.general.shell")} description={t("settings.general.shellDesc")}>
          <input
            aria-label={t("settings.general.shell")}
            className="settings-text-input"
            placeholder={t("settings.general.shellPlaceholder")}
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.general.maxTuiTabs")} description={t("settings.general.maxTuiTabsDesc", { min: MIN_TUI_TAB_LIMIT, max: MAX_TUI_TAB_LIMIT })}>
          <input
            aria-label={t("settings.general.maxTuiTabs")}
            className="settings-text-input"
            inputMode="numeric"
            max={MAX_TUI_TAB_LIMIT}
            min={MIN_TUI_TAB_LIMIT}
            type="number"
            value={tuiTabLimitDraft}
            onBlur={commitTuiTabLimitDraft}
            onChange={(event) => setTuiTabLimitDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsInfoRow label={t("settings.general.remoteUiStatus")} value={remoteUiStatusLabel} />
        <SettingsRow title={t("settings.general.remoteUiPort")} description={t("settings.general.remoteUiPortDesc")}>
          <input
            aria-label={t("settings.general.remoteUiPort")}
            className="settings-text-input"
            inputMode="numeric"
            max={MAX_REMOTE_UI_PORT}
            min={MIN_REMOTE_UI_PORT}
            type="number"
            value={remoteUiPortDraft}
            onBlur={commitRemoteUiPortDraft}
            onChange={(event) => setRemoteUiPortDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.general.remoteUiPassword")} description={t("settings.general.remoteUiPasswordDesc")}>
          <input
            aria-label={t("settings.general.remoteUiPassword")}
            className="settings-text-input"
            placeholder={t("settings.general.remoteUiPasswordPlaceholder")}
            spellCheck={false}
            type="password"
            value={remoteUiTokenDraft}
            onBlur={commitRemoteUiTokenDraft}
            onChange={(event) => setRemoteUiTokenDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.shortcuts")}>
        <SettingsInfoRow label={t("settings.general.shortcut.newThread")} value="Cmd+Shift+O" />
        <SettingsInfoRow label={t("settings.general.shortcut.openSettings")} value="Cmd+," />
        <SettingsInfoRow label={t("settings.general.shortcut.toggleTerminal")} value="Cmd+J" />
        <SettingsInfoRow label={t("settings.general.shortcut.newTerminalTab")} value="Cmd+T" />
        <SettingsInfoRow label={t("settings.general.shortcut.sendMessage")} value="Enter" />
        <SettingsInfoRow label={t("settings.general.shortcut.newLine")} value="Shift+Enter" />
      </SettingsGroup>
    </>
  );
}
