/**
 * ============================================================
 * WorkspaceBindingIndicator — 工作目录绑定指示器组件
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §5 工作目录绑定机制
 *
 * 显示当前分屏面板绑定的工作目录。
 * 两种模式:
 * - follow-workspace: 跟随左侧当前工作区（蓝色提示）
 * - manual: 手动指定的固定路径（灰色提示）
 */

import React, { useCallback } from "react";
import { useI18n } from "../i18n";
import type { CwdBindingMode } from "./types";

export interface WorkspaceBindingIndicatorProps {
  /** 当前绑定模式 */
  readonly bindingMode: CwdBindingMode;

  /** 当前工作路径（跟随模式时从左侧获取） */
  readonly currentPath: string;

  /** 是否显示详细信息 */
  readonly detailed?: boolean;

  /** 点击切换绑定模式 */
  readonly onToggleMode?: () => void;
}

/**
 * 截断路径为可读形式
 * 例如: /Users/name/projects/my-app → ~/projects/my-app
 */
function truncatePath(path: string, maxLength = 40): string {
  if (!path) return "";
  if (path.length <= maxLength) return path;

  // 尝试用 ~ 替换 home 目录
  const homeDir = typeof process !== "undefined" ? process.env.HOME : "";
  const displayPath = homeDir && path.startsWith(homeDir)
    ? `~${path.slice(homeDir.length)}`
    : path;

  if (displayPath.length <= maxLength) return displayPath;

  // 截断中间部分
  const start = displayPath.slice(0, Math.floor(maxLength / 2) - 2);
  const end = displayPath.slice(displayPath.length - Math.floor(maxLength / 2) + 2);
  return `${start}…${end}`;
}

/**
 * 工作目录绑定指示器
 */
export function WorkspaceBindingIndicator({
  bindingMode,
  currentPath,
  detailed = false,
  onToggleMode,
}: WorkspaceBindingIndicatorProps) {
  const { t } = useI18n();
  const isFollow = bindingMode.kind === "follow-workspace";
  const displayPath = isFollow ? currentPath : bindingMode.path;

  const className = [
    "split-panel__cwd-indicator",
    isFollow ? "split-panel__cwd-indicator--follow" : "split-panel__cwd-indicator--manual",
  ].join(" ");

  const handleClick = useCallback(() => {
    onToggleMode?.();
  }, [onToggleMode]);

  return (
    <div
      className={className}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      title={
        isFollow
          ? t("splitPanel.cwd.follow.tooltip", { path: displayPath })
          : t("splitPanel.cwd.fixed.tooltip", { path: displayPath })
      }
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {detailed && (
        <span className="split-panel__cwd-indicator-label">
          {isFollow ? t("splitPanel.cwd.follow") : t("splitPanel.cwd.fixed")}
        </span>
      )}
      <span className="split-panel__cwd-indicator-path">
        {truncatePath(displayPath)}
      </span>
    </div>
  );
}
