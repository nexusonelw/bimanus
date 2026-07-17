/**
 * ============================================================
 * SplitPanelToolbar — 分屏面板工具栏组件
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §3 Tab 管理系统
 *
 * 职责:
 * - 渲染 Tab 标签条
 * - 新建会话按钮（下拉选择 CLI 类型）
 * - 布局切换按钮（single/dual/quad/grid4）
 * - Tab 关闭按钮
 * - 分屏关闭按钮
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { CLI_CATALOG, isCliEnabled, type CliEnablementMap } from "../cli-enablement";
import { CliBrandIcon, getCliBrandColor } from "../cli-icons";
import { useI18n } from "../i18n";
import type { CliType, SplitLayout, SplitPanelTab } from "./types";

// ── CLI 类型显示配置 ──

interface CliOption {
  readonly type: CliType;
  readonly label: string;
  readonly description: string;
}

const CLI_OPTIONS: readonly CliOption[] = CLI_CATALOG.map((entry) => ({
  type: entry.type,
  label: entry.label,
  description: entry.description,
}));

// ── 布局配置 ──

interface LayoutOption {
  readonly layout: SplitLayout;
  readonly labelKey: string;
  readonly icon: React.ReactNode;
  readonly tooltipKey: string;
}

const LAYOUT_OPTIONS: readonly LayoutOption[] = [
  {
    layout: "single",
    labelKey: "splitPanel.layout.single",
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
    tooltipKey: "splitPanel.layout.single.tooltip",
  },
  {
    layout: "dual",
    labelKey: "splitPanel.layout.dual",
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="2" width="4.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="8" y="2" width="4.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
    tooltipKey: "splitPanel.layout.dual.tooltip",
  },
  {
    layout: "quad",
    labelKey: "splitPanel.layout.dual2",
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="2" width="4.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="8" y="2" width="4.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
    tooltipKey: "splitPanel.layout.dual2.tooltip",
  },
  {
    layout: "grid4",
    labelKey: "splitPanel.layout.grid4",
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="8" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    ),
    tooltipKey: "splitPanel.layout.grid4.tooltip",
  },
];

// ── 组件 Props ──

export interface SplitPanelToolbarProps {
  /** 所有 Tab */
  readonly tabs: readonly SplitPanelTab[];

  /** 当前激活的 Tab ID */
  readonly activeTabId: string | null;

  /** 当前布局模式 */
  readonly layout: SplitLayout;

  /** 是否可以显示布局切换按钮（有多个 Tab 时） */
  readonly canChangeLayout: boolean;

  /** CLI enablement map; disabled entries are hidden from the new-session menu */
  readonly cliEnablement?: CliEnablementMap;

  // ── 回调 ──

  /** 激活 Tab */
  readonly onActivateTab: (tabId: string) => void;

  /** 关闭 Tab */
  readonly onCloseTab: (tabId: string) => void;

  /** 关闭所有 Tab */
  readonly onCloseAllTabs: () => void;

  /** 新建 CLI 会话 */
  readonly onCreateSession: (cliType: CliType) => void;

  /** 切换布局 */
  readonly onChangeLayout: (layout: SplitLayout) => void;

  /** 关闭分屏面板 */
  readonly onClosePanel: () => void;

  /**
   * 重启当前激活 Tab 的终端会话 — 由内嵌 TerminalPanel 经注册表
   * 暴露的 restartTerminal 函数触发。
   */
  readonly onRestartActive?: () => void;
}

/**
 * 分屏面板工具栏组件
 *
 * 包含：
 * 1. Tab 标签条（滚动）
 * 2. 新建会话按钮（下拉菜单）
 * 3. 布局切换按钮
 * 4. 关闭面板按钮
 */
export function SplitPanelToolbar({
  tabs,
  activeTabId,
  layout,
  canChangeLayout,
  cliEnablement,
  onActivateTab,
  onCloseTab,
  onCloseAllTabs,
  onCreateSession,
  onChangeLayout,
  onClosePanel,
  onRestartActive,
}: SplitPanelToolbarProps) {
  const { t } = useI18n();
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const sessionButtonRef = useRef<HTMLButtonElement>(null);
  const layoutButtonRef = useRef<HTMLButtonElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);

  const visibleCliOptions = useMemo(
    () => CLI_OPTIONS.filter((option) => isCliEnabled(cliEnablement, option.type)),
    [cliEnablement],
  );
  const layoutMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showSessionSelector && selectorRef.current && !selectorRef.current.contains(e.target as Node) && !sessionButtonRef.current?.contains(e.target as Node)) {
        setShowSessionSelector(false);
      }
      if (showLayoutMenu && layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node) && !layoutButtonRef.current?.contains(e.target as Node)) {
        setShowLayoutMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSessionSelector, showLayoutMenu]);

  // 新建会话按钮点击
  const handleNewSessionClick = useCallback(() => {
    setShowSessionSelector((prev) => !prev);
    setShowLayoutMenu(false);
  }, []);

  // 选择 CLI 类型
  const handleSelectCliType = useCallback(
    (cliType: CliType) => {
      onCreateSession(cliType);
      setShowSessionSelector(false);
    },
    [onCreateSession],
  );

  // 布局切换按钮点击
  const handleLayoutClick = useCallback(() => {
    setShowLayoutMenu((prev) => !prev);
    setShowSessionSelector(false);
  }, []);

  // 布局选项点击
  const handleLayoutSelect = useCallback(
    (newLayout: SplitLayout) => {
      onChangeLayout(newLayout);
      setShowLayoutMenu(false);
    },
    [onChangeLayout],
  );

  // 关闭面板
  const handleClosePanel = useCallback(() => {
    onClosePanel();
  }, [onClosePanel]);

  // 重启当前激活 Tab 的终端
  const handleRestartActive = useCallback(() => {
    onRestartActive?.();
  }, [onRestartActive]);

  return (
    <div className="split-panel__toolbar">
      {/* Tab 标签条 */}
      <div className="split-panel__toolbar-tabs">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          const tabClassName = [
            "split-panel__tab",
            isActive ? "split-panel__tab--active" : "",
            tab.status === "pending" || tab.status === "starting" ? "split-panel__tab--pending" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={tab.id}
              className={tabClassName}
              onClick={() => onActivateTab(tab.id)}
              title={`${tab.title} [${tab.cwd || t("splitPanel.noCwd")}]`}
              type="button"
            >
              <span
                className="split-panel__tab-icon"
                style={{ color: getCliBrandColor(tab.cliType) }}
                aria-hidden="true"
              >
                <CliBrandIcon cliType={tab.cliType} />
              </span>
              <span className="split-panel__tab-title">{tab.title}</span>
              <span
                className="split-panel__tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={t("splitPanel.closeTab", { name: tab.title })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }
                }}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      {/* 工具栏右侧操作区 */}
      <div className="split-panel__toolbar-actions">
        {/* 新建 Tab 按钮 */}
        <div style={{ position: "relative" }}>
          <button
            ref={sessionButtonRef}
            className={`split-panel__toolbar-button ${showSessionSelector ? "split-panel__toolbar-button--active" : ""}`}
            onClick={handleNewSessionClick}
            title={t("splitPanel.newSession")}
            type="button"
            aria-label={t("splitPanel.newSession")}
            aria-expanded={showSessionSelector}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>

          {/* 新建会话下拉菜单 */}
          {showSessionSelector && (
            <div className="split-panel__session-selector" ref={selectorRef}>
              {visibleCliOptions.length === 0 ? (
                <div className="split-panel__session-option" style={{ opacity: 0.7, cursor: "default" }}>
                  <span>{t("splitPanel.noEnabledClis")}</span>
                </div>
              ) : (
                visibleCliOptions.map((option) => (
                  <button
                    key={option.type}
                    className="split-panel__session-option"
                    onClick={() => handleSelectCliType(option.type)}
                    type="button"
                  >
                    <span
                      className="split-panel__session-option-icon"
                      style={{ color: getCliBrandColor(option.type) }}
                      aria-hidden="true"
                    >
                      <CliBrandIcon cliType={option.type} />
                    </span>
                    <span>{option.label}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* 布局切换按钮 - 有多个 Tab 或 Pane 时才可切换 */}
        {canChangeLayout && (
          <div style={{ position: "relative" }}>
            <button
              ref={layoutButtonRef}
              className={`split-panel__toolbar-button ${showLayoutMenu ? "split-panel__toolbar-button--active" : ""}`}
              onClick={handleLayoutClick}
              title={t("splitPanel.switchLayout")}
              type="button"
              aria-label={t("splitPanel.switchLayout")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="8" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>

            {/* 布局选择菜单 */}
            {showLayoutMenu && (
              <div className="split-panel__session-selector" ref={layoutMenuRef} style={{ minWidth: "140px" }}>
                {LAYOUT_OPTIONS.map((option) => (
                  <button
                    key={option.layout}
                    className={`split-panel__session-option ${layout === option.layout ? "split-panel__toolbar-button--active" : ""}`}
                    onClick={() => handleLayoutSelect(option.layout)}
                    type="button"
                    title={t(option.tooltipKey)}
                  >
                    <span style={{ width: 16, height: 16, display: "grid", placeItems: "center" }}>
                      {option.icon}
                    </span>
                    <span>{t(option.labelKey)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 关闭面板按钮 */}
        <button
          className="split-panel__toolbar-button"
          onClick={handleClosePanel}
          title={t("splitPanel.closePanel")}
          type="button"
          aria-label={t("splitPanel.closePanel")}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </button>

        {/* 重启终端按钮 — 从嵌入 TerminalPanel 工具栏迁入 */}
        <button
          className="split-panel__toolbar-button"
          onClick={handleRestartActive}
          title={t("splitPanel.restartTerminal")}
          type="button"
          aria-label={t("splitPanel.restartTerminal")}
          disabled={!activeTabId}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11.2 6.1A4.2 4.2 0 1 0 11.1 9.6M11.4 3.7v2.8H8.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}


