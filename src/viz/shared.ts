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
  states: Map<string, HaState>
): void {
  showTooltip(x, y, node.label, node.entityId, states);
}

export function hideTip(): void {
  hideTooltip();
}

export function flatten(root: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

export function leaves(root: TreeNode): TreeNode[] {
  return flatten(root).filter((n) => n.children.length === 0);
}
