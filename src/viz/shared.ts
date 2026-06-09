import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { nodeColor } from "../render/colors";
import { showTooltip, hideTooltip } from "../render/tooltip";

export function color(node: TreeNode): string {
  return nodeColor(node.kind, node.domain);
}

export function showTip(
  x: number,
  y: number,
  node: TreeNode,
  states: Map<string, HaState>,
  extraHtml?: string,
): void {
  showTooltip(x, y, node.label, node.entityId, states, extraHtml);
}

export function hideTip(): void {
  hideTooltip();
}
