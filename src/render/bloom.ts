import type { TreeNode } from "../tree/types";
import type { Complex } from "../hyperbolic/complex";
import type { RenderState } from "./renderer";
import { render } from "./renderer";

const BLOOM_DURATION_MS = 1200;
const STAGGER_PER_DEPTH_MS = 120;

interface SavedPosition {
  node: TreeNode;
  targetZ: Complex;
  targetScreenZ: Complex;
  depth: number;
}

function getDepth(node: TreeNode): number {
  let d = 0;
  let current = node.parent;
  while (current) {
    d++;
    current = current.parent;
  }
  return d;
}

export function animateBloom(renderState: RenderState): Promise<void> {
  return new Promise((resolve) => {
    const saved: SavedPosition[] = renderState.nodes.map((node) => {
      const s: SavedPosition = {
        node,
        targetZ: [...node.z] as Complex,
        targetScreenZ: [...node.screenZ] as Complex,
        depth: getDepth(node),
      };
      node.z = [0, 0];
      node.screenZ = [0, 0];
      return s;
    });

    const maxDepth = Math.max(...saved.map((s) => s.depth));
    const totalDuration = BLOOM_DURATION_MS + maxDepth * STAGGER_PER_DEPTH_MS;
    const startTime = performance.now();

    function frame(now: number) {
      const elapsed = now - startTime;

      for (const { node, targetZ, targetScreenZ, depth } of saved) {
        const delay = depth * STAGGER_PER_DEPTH_MS;
        const localElapsed = Math.max(0, elapsed - delay);
        const rawT = Math.min(localElapsed / BLOOM_DURATION_MS, 1);

        const t = rawT === 0 || rawT === 1
          ? rawT
          : Math.pow(2, -10 * rawT) * Math.sin((rawT * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;

        node.z = [
          targetZ[0] * t,
          targetZ[1] * t,
        ];
        node.screenZ = [
          targetScreenZ[0] * t,
          targetScreenZ[1] * t,
        ];
      }

      render(renderState);

      if (elapsed < totalDuration) {
        requestAnimationFrame(frame);
      } else {
        for (const { node, targetZ, targetScreenZ } of saved) {
          node.z = targetZ;
          node.screenZ = targetScreenZ;
        }
        render(renderState);
        resolve();
      }
    }

    render(renderState);
    requestAnimationFrame(frame);
  });
}
