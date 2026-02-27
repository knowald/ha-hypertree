import type { TreeNode } from "../tree/types";
import type { RenderState } from "./renderer";
import { nodeColor } from "./colors";

const RIPPLE_DURATION_MS = 800;
const RIPPLE_MAX_RADIUS = 0.08;

interface Ripple {
  node: TreeNode;
  startTime: number;
  color: string;
}

const activeRipples: Ripple[] = [];
let rippleGroup: SVGGElement | null = null;
let animating = false;

export function initRipples(state: RenderState): void {
  rippleGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  rippleGroup.setAttribute("class", "ripples");
  // Insert after edges, before nodes
  state.svg.insertBefore(rippleGroup, state.nodeGroup);
}

export function spawnRipple(node: TreeNode): void {
  if (!rippleGroup) return;
  activeRipples.push({
    node,
    startTime: performance.now(),
    color: nodeColor(node.kind, node.domain),
  });
  if (!animating) {
    animating = true;
    requestAnimationFrame(animateRipples);
  }
}

function animateRipples(now: number): void {
  if (!rippleGroup) return;

  for (let i = activeRipples.length - 1; i >= 0; i--) {
    if (now - activeRipples[i].startTime > RIPPLE_DURATION_MS) {
      activeRipples.splice(i, 1);
    }
  }

  rippleGroup.innerHTML = "";

  for (const ripple of activeRipples) {
    const t = (now - ripple.startTime) / RIPPLE_DURATION_MS;
    const radius = RIPPLE_MAX_RADIUS * t;
    const opacity = 0.4 * (1 - t);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(ripple.node.screenZ[0]));
    circle.setAttribute("cy", String(ripple.node.screenZ[1]));
    circle.setAttribute("r", String(radius));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", ripple.color);
    circle.setAttribute("stroke-width", "0.003");
    circle.setAttribute("stroke-opacity", String(opacity));
    circle.setAttribute("pointer-events", "none");
    rippleGroup.appendChild(circle);
  }

  if (activeRipples.length > 0) {
    requestAnimationFrame(animateRipples);
  } else {
    animating = false;
  }
}
