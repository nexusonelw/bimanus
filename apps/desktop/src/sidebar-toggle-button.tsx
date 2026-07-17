import { SidebarToggleIcon } from "./icons";
import { useI18n } from "./i18n";

interface SidebarToggleButtonProps {
  readonly collapsed: boolean;
  readonly shortcutLabel: string;
  readonly onToggle: () => void;
  readonly className?: string;
}

export function SidebarToggleButton({ collapsed, shortcutLabel, onToggle, className }: SidebarToggleButtonProps) {
  const { t } = useI18n();
  const wrapperClassName = className
    ? `shortcut-tooltip-wrap sidebar-toggle ${className}`
    : "shortcut-tooltip-wrap sidebar-toggle";

  return (
    <div className={wrapperClassName}>
      <button
        aria-label={t("sidebarToggle.toggle")}
        aria-pressed={!collapsed}
        className="icon-button sidebar-toggle__button"
        data-testid="sidebar-toggle"
        type="button"
        onClick={onToggle}
      >
        <SidebarToggleIcon />
      </button>
      <span className="shortcut-tooltip sidebar-toggle__tooltip" role="tooltip">
        <span>{t("sidebarToggle.toggle")}</span>
        <kbd>{shortcutLabel}</kbd>
      </span>
    </div>
  );
}
