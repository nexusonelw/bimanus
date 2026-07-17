import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "./icons";
import { useI18n } from "./i18n";

interface TerminalActionsMenuProps {
  readonly children: ReactNode;
}

export function TerminalActionsMenu({ children }: TerminalActionsMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current
        && !containerRef.current.contains(e.target as Node)
        && buttonRef.current
        && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="terminal-panel__actions terminal-panel__actions--has-dropdown">
      <button
        ref={buttonRef}
        type="button"
        className={`icon-button terminal-panel__action terminal-panel__menu-toggle ${open ? "icon-button--active" : ""}`}
        title={t("terminal.moreActions")}
        aria-label={t("terminal.moreActions")}
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="terminal-panel__dropdown" ref={containerRef} role="menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}