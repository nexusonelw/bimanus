/**
 * ============================================================
 * SplitPanelDivider — 垂直分割条组件
 * ============================================================
 *
 * 设计依据: split-panel-ui-design.md §2.3 中间分割条
 *
 * 放置在 Sidebar 和 SplitPanel 之间的 6px 宽垂直分割条。
 * 复用 useSplitPanelResize hook 实现拖拽调整宽度。
 */

import React from "react";

export interface SplitPanelDividerProps {
  /** 是否正在拖拽 */
  readonly isDragging: boolean;

  /** 鼠标按下事件处理器 */
  readonly onMouseDown: (e: React.MouseEvent) => void;

  /** 分屏面板是否可见 */
  readonly visible: boolean;
}

/**
 * 垂直分割条组件
 *
 * 6px 宽，hover 时显示蓝色指示线。
 * 通过 onMouseDown 触发 useSplitPanelResize 的拖拽逻辑。
 */
export function SplitPanelDivider({
  isDragging,
  onMouseDown,
  visible,
}: SplitPanelDividerProps) {
  if (!visible) return null;

  const className = [
    "split-panel__divider",
    isDragging ? "split-panel__divider--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整分屏面板宽度"
      tabIndex={0}
      onKeyDown={(e) => {
        // 键盘支持：左右箭头调整宽度
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          // 这里由父组件处理键盘事件
        }
      }}
    />
  );
}
