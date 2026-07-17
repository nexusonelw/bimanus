import {
  DEFAULT_SURFACE_BG_COLOR,
  SURFACE_BG_COLOR_OPTIONS,
  type LocaleSetting,
  type ThemeMode,
} from "./desktop-state";
import { useI18n } from "./i18n";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
  readonly enableTransparency: boolean;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
  readonly tuiBgColor: string;
  readonly onSetTuiBgColor: (color: string) => void;
  readonly splitPanelBgColor: string;
  readonly onSetSplitPanelBgColor: (color: string) => void;
  readonly locale: LocaleSetting;
  readonly onSetLocale: (locale: LocaleSetting) => void;
}

function SurfaceBgColorPicker({
  label,
  description,
  value,
  onChange,
  name,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (color: string) => void;
  readonly name: string;
}) {
  const normalized = value.trim().toUpperCase() || DEFAULT_SURFACE_BG_COLOR;
  return (
    <SettingsRow title={label} description={description}>
      <div className="settings-color-swatches" role="radiogroup" aria-label={label}>
        {SURFACE_BG_COLOR_OPTIONS.map((option) => {
          const selected = option.value.toUpperCase() === normalized;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} ${option.description}`}
              title={`${option.label} · ${option.description}`}
              className={`settings-color-swatch${selected ? " settings-color-swatch--selected" : ""}`}
              style={{ backgroundColor: option.value }}
              data-color={option.value}
              data-testid={`${name}-${option.id}`}
              onClick={() => onChange(option.value)}
            >
              <span className="settings-color-swatch__label">{option.label}</span>
            </button>
          );
        })}
      </div>
    </SettingsRow>
  );
}

export function SettingsAppearanceSection({
  themeMode,
  onSetThemeMode,
  enableTransparency,
  onSetEnableTransparency,
  tuiBgColor,
  onSetTuiBgColor,
  splitPanelBgColor,
  onSetSplitPanelBgColor,
  locale,
  onSetLocale,
}: SettingsAppearanceSectionProps) {
  const { t } = useI18n();

  const themeOptions: { mode: ThemeMode; label: string; description: string }[] = [
    { mode: "system", label: t("settings.appearance.theme.system"), description: t("settings.appearance.theme.system.description") },
    { mode: "light", label: t("settings.appearance.theme.light"), description: t("settings.appearance.theme.light.description") },
    { mode: "dark", label: t("settings.appearance.theme.dark"), description: t("settings.appearance.theme.dark.description") },
  ];

  const localeOptions: { setting: LocaleSetting; label: string; description: string }[] = [
    { setting: "auto", label: t("settings.appearance.language.auto"), description: t("settings.appearance.language.auto.description") },
    { setting: "en", label: t("settings.appearance.language.en"), description: t("settings.appearance.language.en.description") },
    { setting: "zh", label: t("settings.appearance.language.zh"), description: t("settings.appearance.language.zh.description") },
  ];

  return (
    <>
      <SettingsGroup title={t("settings.appearance.theme")}>
        {themeOptions.map((option) => (
          <SettingsRow key={option.mode} title={option.label} description={option.description}>
            <input
              checked={themeMode === option.mode}
              name="theme"
              type="radio"
              onChange={() => onSetThemeMode(option.mode)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.language")}>
        {localeOptions.map((option) => (
          <SettingsRow key={option.setting} title={option.label} description={option.description}>
            <input
              checked={locale === option.setting}
              name="locale"
              type="radio"
              onChange={() => onSetLocale(option.setting)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.appearance.surfaces")}
        description={t("settings.appearance.surfaces.description")}
      >
        <SurfaceBgColorPicker
          name="tui-bg-color"
          label={t("settings.appearance.surfaces.tuiBg")}
          description={t("settings.appearance.surfaces.tuiBg.description")}
          value={tuiBgColor}
          onChange={onSetTuiBgColor}
        />
        <SurfaceBgColorPicker
          name="split-panel-bg-color"
          label={t("settings.appearance.surfaces.splitBg")}
          description={t("settings.appearance.surfaces.splitBg.description")}
          value={splitPanelBgColor}
          onChange={onSetSplitPanelBgColor}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.visuals")}>
        <SettingsRow
          title={t("settings.appearance.visuals.transparency")}
          description={t("settings.appearance.visuals.transparency.description")}
        >
          <input
            aria-label={t("settings.appearance.visuals.transparency")}
            type="checkbox"
            checked={enableTransparency}
            onChange={(event) => onSetEnableTransparency(event.currentTarget.checked)}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}