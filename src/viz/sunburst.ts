import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { color, showTip, hideTip } from "./shared";
import { createTransform, setupSvgZoom } from "./zoom";

let svg: SVGSVGElement | null = null;
let group: SVGGElement | null = null;
let currentStates: Map<string, HaState> = new Map();
let zoomTarget: TreeNode | null = null;
let allArcs: { el: SVGPathElement; node: TreeNode }[] = [];
let cleanupZoom: (() => void) | null = null;

const TAU = 2 * Math.PI;

export const sunburstViz: Visualization = {
  name: "Sunburst",

  create(container, root, states) {
    currentStates = states;
    zoomTarget = root;

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

    svg.addEventListener("click", (e) => {
      const target = e.target as SVGElement;
      const idx = target.dataset.idx;
      if (!idx) return;
      const arc = allArcs[Number(idx)];
      if (arc.node.children.length > 0) {
        zoomTarget = arc.node;
        layout(root);
      }
    });

    svg.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (zoomTarget && zoomTarget.parent) {
        zoomTarget = zoomTarget.parent;
        layout(root);
      }
    });

    svg.addEventListener("mousemove", (e) => {
      const target = e.target as SVGElement;
      const idx = target.dataset.idx;
      if (idx) showTip(e.clientX, e.clientY, allArcs[Number(idx)].node, currentStates);
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
    allArcs = [];
    zoomTarget = null;
  },

  updateStates(states) {
    currentStates = states;
  },
};

interface PartNode {
  node: TreeNode;
  depth: number;
  startAngle: number;
  endAngle: number;
}

function partition(root: TreeNode): PartNode[] {
  const out: PartNode[] = [];
  const zt = zoomTarget ?? root;

  function countLeaves(n: TreeNode): number {
    if (n.children.length === 0) return 1;
    return n.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  function getDepth(n: TreeNode): number {
    let d = 0;
    let cur: TreeNode | null = n;
    while (cur && cur !== zt) {
      d++;
      cur = cur.parent;
    }
    return cur === zt ? d : -1;
  }

  function walk(n: TreeNode, startAngle: number, endAngle: number): void {
    const depth = getDepth(n);
    if (depth < 0) return;

    out.push({ node: n, depth, startAngle, endAngle });

    if (n.children.length === 0) return;

    const total = countLeaves(n);
    let angle = startAngle;
    for (const child of n.children) {
      const fraction = countLeaves(child) / total;
      const childEnd = angle + (endAngle - startAngle) * fraction;
      walk(child, angle, childEnd);
      angle = childEnd;
    }
  }

  walk(zt, 0, TAU);
  return out;
}

function layout(root: TreeNode): void {
  if (!svg || !group) return;
  const { width, height } = svg.getBoundingClientRect();
  if (width === 0) return;

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(cx, cy) - 10;

  const parts = partition(root);
  const maxDepth = Math.max(...parts.map((p) => p.depth), 1);
  const ringWidth = maxR / (maxDepth + 1);

  group.innerHTML = "";
  allArcs = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.depth === 0 && p.node === (zoomTarget ?? root)) continue;

    const innerR = p.depth * ringWidth;
    const outerR = (p.depth + 1) * ringWidth;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", arcPath(cx, cy, innerR, outerR, p.startAngle, p.endAngle));
    path.setAttribute("fill", color(p.node));
    path.setAttribute("fill-opacity", "0.75");
    path.setAttribute("stroke", "#1e1e1e");
    path.setAttribute("stroke-width", "0.5");
    path.dataset.idx = String(allArcs.length);
    path.style.cursor = p.node.children.length > 0 ? "pointer" : "default";
    group.appendChild(path);

    const arcLen = (p.endAngle - p.startAngle) * (innerR + outerR) / 2;
    if (arcLen > 30 && (outerR - innerR) > 14) {
      const midAngle = (p.startAngle + p.endAngle) / 2;
      const midR = (innerR + outerR) / 2;
      const tx = cx + midR * Math.cos(midAngle);
      const ty = cy + midR * Math.sin(midAngle);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(tx));
      text.setAttribute("y", String(ty));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.setAttribute("fill", "#e0e0e0");
      text.setAttribute("font-size", "10");
      text.setAttribute("pointer-events", "none");

      const maxLen = Math.floor(arcLen / 7);
      const label = p.node.label.length > maxLen
        ? p.node.label.slice(0, maxLen - 1) + "\u2026"
        : p.node.label;
      text.textContent = label;

      let rot = (midAngle * 180) / Math.PI;
      if (rot > 90 && rot < 270) rot += 180;
      text.setAttribute("transform", `rotate(${rot},${tx},${ty})`);
      group.appendChild(text);
    }

    allArcs.push({ el: path, node: p.node });
  }

  const center = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  center.setAttribute("cx", String(cx));
  center.setAttribute("cy", String(cy));
  center.setAttribute("r", String(ringWidth * 0.3));
  center.setAttribute("fill", "#1e1e1e");
  center.setAttribute("stroke", "#333");
  center.setAttribute("stroke-width", "1");
  group.appendChild(center);

  const centerLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  centerLabel.setAttribute("x", String(cx));
  centerLabel.setAttribute("y", String(cy));
  centerLabel.setAttribute("text-anchor", "middle");
  centerLabel.setAttribute("dominant-baseline", "central");
  centerLabel.setAttribute("fill", "#9e9e9e");
  centerLabel.setAttribute("font-size", "11");
  centerLabel.setAttribute("pointer-events", "none");
  centerLabel.textContent = (zoomTarget ?? root).label;
  group.appendChild(centerLabel);
}

function arcPath(
  cx: number, cy: number,
  r0: number, r1: number,
  a0: number, a1: number
): string {
  const gap = 0.005;
  a0 += gap;
  a1 -= gap;
  if (a1 <= a0) return "";

  const large = a1 - a0 > Math.PI ? 1 : 0;

  const x0o = cx + r1 * Math.cos(a0);
  const y0o = cy + r1 * Math.sin(a0);
  const x1o = cx + r1 * Math.cos(a1);
  const y1o = cy + r1 * Math.sin(a1);
  const x0i = cx + r0 * Math.cos(a1);
  const y0i = cy + r0 * Math.sin(a1);
  const x1i = cx + r0 * Math.cos(a0);
  const y1i = cy + r0 * Math.sin(a0);

  return [
    `M ${x0o} ${y0o}`,
    `A ${r1} ${r1} 0 ${large} 1 ${x1o} ${y1o}`,
    `L ${x0i} ${y0i}`,
    `A ${r0} ${r0} 0 ${large} 0 ${x1i} ${y1i}`,
    "Z",
  ].join(" ");
}
