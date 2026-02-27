import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { color, showTip, hideTip, flatten } from "./shared";
import { createTransform, setupSvgZoom } from "./zoom";

let svg: SVGSVGElement | null = null;
let group: SVGGElement | null = null;
let currentStates: Map<string, HaState> = new Map();
let allNodes: { el: SVGCircleElement; node: TreeNode }[] = [];
let cleanupZoom: (() => void) | null = null;

const TAU = 2 * Math.PI;

export const dendrogramViz: Visualization = {
  name: "Dendrogram",

  create(container, root, states) {
    currentStates = states;

    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.display = "block";
    container.appendChild(svg);

    group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(group);

    const transform = createTransform();
    cleanupZoom = setupSvgZoom(svg, group, transform);

    const obs = new ResizeObserver(() => layout(root));
    obs.observe(container);
    (svg as any).__obs = obs;

    layout(root);

    svg.addEventListener("mousemove", (e) => {
      const target = e.target as SVGElement;
      const idx = target.dataset.idx;
      if (idx) showTip(e.clientX, e.clientY, allNodes[Number(idx)].node, currentStates);
      else hideTip();
    });

    svg.addEventListener("mouseleave", () => hideTip());
  },

  destroy() {
    if (cleanupZoom) { cleanupZoom(); cleanupZoom = null; }
    if (svg) {
      (svg as any).__obs?.disconnect();
      svg = null;
    }
    group = null;
    allNodes = [];
  },

  updateStates(states) {
    currentStates = states;
  },
};

interface Positioned {
  node: TreeNode;
  angle: number;
  radius: number;
  x: number;
  y: number;
}

function layout(root: TreeNode): void {
  if (!svg || !group) return;
  const { width, height } = svg.getBoundingClientRect();
  if (width === 0) return;

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(cx, cy) - 30;

  const nodes = flatten(root);
  const maxDepth = Math.max(
    ...nodes.map((n) => {
      let d = 0;
      let c: TreeNode | null = n;
      while (c!.parent) { d++; c = c!.parent; }
      return d;
    }),
    1
  );

  const allLeaves = nodes.filter((n) => n.children.length === 0);
  const positions = new Map<TreeNode, Positioned>();

  allLeaves.forEach((leaf, i) => {
    const angle = (i / allLeaves.length) * TAU;
    const depth = getDepth(leaf);
    const radius = (depth / maxDepth) * maxR;
    positions.set(leaf, {
      node: leaf,
      angle,
      radius,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  for (let d = maxDepth - 1; d >= 0; d--) {
    for (const n of nodes) {
      if (getDepth(n) !== d) continue;
      if (positions.has(n)) continue;

      const childPositions = n.children
        .map((c) => positions.get(c))
        .filter(Boolean) as Positioned[];

      if (childPositions.length === 0) continue;

      const avgAngle = circularMean(childPositions.map((p) => p.angle));
      const radius = (d / maxDepth) * maxR;
      positions.set(n, {
        node: n,
        angle: avgAngle,
        radius,
        x: cx + radius * Math.cos(avgAngle),
        y: cy + radius * Math.sin(avgAngle),
      });
    }
  }

  positions.set(root, { node: root, angle: 0, radius: 0, x: cx, y: cy });

  group.innerHTML = "";
  allNodes = [];

  for (const n of nodes) {
    if (!n.parent) continue;
    const pos = positions.get(n);
    const ppos = positions.get(n.parent);
    if (!pos || !ppos) continue;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const midR = (pos.radius + ppos.radius) / 2;
    const mx = cx + midR * Math.cos(pos.angle);
    const my = cy + midR * Math.sin(pos.angle);
    path.setAttribute("d", `M ${ppos.x} ${ppos.y} Q ${mx} ${my} ${pos.x} ${pos.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color(n));
    path.setAttribute("stroke-opacity", "0.4");
    path.setAttribute("stroke-width", "1");
    group.appendChild(path);
  }

  for (const n of nodes) {
    const pos = positions.get(n);
    if (!pos) continue;

    const r = n.kind === "root" ? 6 : n.kind === "area" ? 5 : n.kind === "domain" ? 4 : 3;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(pos.x));
    circle.setAttribute("cy", String(pos.y));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", color(n));
    circle.dataset.idx = String(allNodes.length);
    circle.style.cursor = "pointer";
    group.appendChild(circle);

    allNodes.push({ el: circle, node: n });

    if (n.kind !== "entity" && pos.radius > 0) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(pos.x));
      text.setAttribute("y", String(pos.y - r - 3));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", "#e0e0e0");
      text.setAttribute("font-size", "10");
      text.setAttribute("pointer-events", "none");
      text.textContent = n.label;
      group.appendChild(text);
    }
  }
}

function getDepth(n: TreeNode): number {
  let d = 0;
  let c: TreeNode | null = n;
  while (c!.parent) { d++; c = c!.parent; }
  return d;
}

function circularMean(angles: number[]): number {
  let sx = 0, sy = 0;
  for (const a of angles) { sx += Math.cos(a); sy += Math.sin(a); }
  return Math.atan2(sy, sx);
}
