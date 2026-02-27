import type { TreeNode } from "./types";
import { fromPolar } from "../hyperbolic/complex";
import { mobiusTranslateInv } from "../hyperbolic/poincare";
import type { Complex } from "../hyperbolic/complex";

const EDGE_LENGTH = 0.85;
const PLACE_RADIUS = Math.tanh(EDGE_LENGTH / 2);

export function layoutTree(root: TreeNode, visible?: Set<TreeNode>): void {
  recomputeLeafCounts(root, visible);

  root.z = [0, 0];
  root.screenZ = [0, 0];

  if (root.children.length === 0) return;

  layoutChildren(root, 0, 2 * Math.PI, [0, 0], visible);
}

function recomputeLeafCounts(node: TreeNode, visible?: Set<TreeNode>): number {
  const children = visible
    ? node.children.filter((c) => visible.has(c))
    : node.children;

  if (children.length === 0) {
    node.leafCount = 1;
    return 1;
  }

  let total = 0;
  for (const child of children) {
    total += recomputeLeafCounts(child, visible);
  }
  node.leafCount = total;
  return total;
}

function layoutChildren(
  parent: TreeNode,
  wedgeStart: number,
  wedgeEnd: number,
  parentGlobalZ: Complex,
  visible?: Set<TreeNode>
): void {
  const children = visible
    ? parent.children.filter((c) => visible.has(c))
    : parent.children;

  if (children.length === 0) return;

  const totalLeaves = children.reduce((s, c) => s + Math.max(c.leafCount, 1), 0);
  let currentAngle = wedgeStart;

  for (const child of children) {
    const childLeaves = Math.max(child.leafCount, 1);
    const childWedge = ((wedgeEnd - wedgeStart) * childLeaves) / totalLeaves;

    const bisectAngle = currentAngle + childWedge / 2;

    const localZ = fromPolar(PLACE_RADIUS, bisectAngle);
    const globalZ = mobiusTranslateInv(localZ, parentGlobalZ);

    child.z = globalZ;
    child.screenZ = [...globalZ];

    const grandChildren = visible
      ? child.children.filter((c) => visible.has(c))
      : child.children;

    if (grandChildren.length > 0) {
      const childWedgeStart = bisectAngle - childWedge / 2;
      const childWedgeEnd = bisectAngle + childWedge / 2;
      layoutChildren(child, childWedgeStart, childWedgeEnd, globalZ, visible);
    }

    currentAngle += childWedge;
  }

  if (visible) {
    for (const child of parent.children) {
      if (!visible.has(child)) {
        child.z = parentGlobalZ;
        child.screenZ = [...parentGlobalZ];
      }
    }
  }
}
