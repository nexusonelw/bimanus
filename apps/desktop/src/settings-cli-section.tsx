import { useCallback, useEffect, useMemo, useState } from "react";
import { CLI_CATALOG, isCliEnabled, type CliEnablementMap } from "./cli-enablement";
import { CliBrandIcon, getCliBrandColor } from "./cli-icons";
import { useI18n } from "./i18n";
import type { CliDetectionMap, CliDetectionResult } from "./ipc";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsCliSectionProps {
  readonly cliEnablement: CliEnablementMap;
  readonly onSetCliEnabled: (cliType: string, enabled: boolean) => Promise<string | undefined>;
  readonly detectAllCli: () => Promise<CliDetectionMap>;
}

function formatDetectionStatus(
  result: CliDetectionResult | undefined,
  detecting: boolean,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (detecting && !result) {
    return t("settings.cli.detecting");
  }
  if (!result) {
    return t("settings.cli.notChecked");
  }
  if (result.installed) {
    const version = result.version ? ` · ${result.version}` : "";
    const pathHint = result.binaryPath ? ` · ${result.binaryPath}` : "";
    return t("settings.cli.installed", { version, pathHint });
  }
  if (result.error) {
    return t("settings.cli.notInstalledError", { error: result.error });
  }
  return t("settings.cli.notInstalled");
}

export function SettingsCliSection({
  cliEnablement,
  onSetCliEnabled,
  detectAllCli,
}: SettingsCliSectionProps) {
  const { t } = useI18n();
  const [detections, setDetections] = useState<CliDetectionMap>({});
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | undefined>();
  const [pendingCliType, setPendingCliType] = useState<string | undefined>();
  const [toggleError, setToggleError] = useState<string | undefined>();

  const runDetection = useCallback(async () => {
    setDetecting(true);
    setDetectError(undefined);
    try {
      const map = await detectAllCli();
      setDetections(map);
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetecting(false);
    }
  }, [detectAllCli]);

  useEffect(() => {
    void runDetection();
  }, [runDetection]);

  const rows = useMemo(
    () =>
      CLI_CATALOG.map((entry) => ({
        ...entry,
        enabled: isCliEnabled(cliEnablement, entry.type),
        detection: detections[entry.type],
      })),
    [cliEnablement, detections],
  );

  const handleToggle = async (cliType: string, enabled: boolean) => {
    setPendingCliType(cliType);
    setToggleError(undefined);
    const nextError = await onSetCliEnabled(cliType, enabled);
    setPendingCliType(undefined);
    if (nextError) {
      setToggleError(nextError);
    }
  };

  return (
    <>
      <SettingsGroup
        title={t("settings.cli.detection")}
        description={t("settings.cli.detectionDesc")}
      >
        <SettingsRow
          title={t("settings.cli.refresh")}
          description={t("settings.cli.refreshDesc")}
        >
          <button
            className="button button--secondary"
            disabled={detecting}
            type="button"
            onClick={() => void runDetection()}
          >
            {detecting ? t("settings.cli.detecting") : t("settings.cli.detectNow")}
          </button>
        </SettingsRow>
        {detectError ? <p className="extension-dialog__body settings-warning">{detectError}</p> : null}
        {toggleError ? <p className="extension-dialog__body settings-warning">{toggleError}</p> : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings.cli.supportedClis")} description={t("settings.cli.supportedClisDesc")}>
        {rows.map((row) => {
          const pending = pendingCliType === row.type;
          return (
            <div className="settings-row" key={row.type}>
              <div className="settings-row__label">
                <div className="settings-row__title settings-row__title--with-icon">
                  <span
                    className="settings-cli-icon"
                    style={{ color: getCliBrandColor(row.type) }}
                    aria-hidden="true"
                  >
                    <CliBrandIcon cliType={row.type} />
                  </span>
                  <span>{row.label}</span>
                </div>
                <div className="settings-row__description">
                  {row.description} · {formatDetectionStatus(row.detection, detecting, t)}
                </div>
              </div>
              <div className="settings-row__control">
                <label className="settings-row__actions" style={{ alignItems: "center", gap: "8px" }}>
                  <span className="settings-row__description">{row.enabled ? t("settings.cli.enabled") : t("settings.cli.disabled")}</span>
                  <input
                    aria-label={`${row.label} enabled`}
                    checked={row.enabled}
                    disabled={pending}
                    type="checkbox"
                    onChange={(event) => void handleToggle(row.type, event.target.checked)}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </SettingsGroup>
    </>
  );
}
