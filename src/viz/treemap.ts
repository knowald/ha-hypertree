import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { color, showTip, hideTip } from "./shared";
import { createTransform, setupSvgZoom } from "./zoom";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: TreeNode;
}

let rects: Rect[] = [];
let svg: SVGSVGElement | null = null;
let group: SVGGElement | null = null;
let currentStates: Map<string, HaState> = new Map();
let zoomStack: TreeNode[] = [];
let cleanupZoom: (() => void) | null = null;

export const treemapViz: Visualization = {
  name: "Treemap",

  create(container, root, states) {
    currentStates = states;
    zoomStack = [root];

    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.display = "block";
    container.appendChild(svg);

    group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(group);

    const transform = createTransform();
    cleanupZoom = setupSvgZoom(svg, group, transform);

    const obs = new ResizeObserver(() => layout());
    obs.observe(container);
    (svg as any).__obs = obs;

    layout();

    svg.addEventListener("click", (e) => {
      const target = e.target as SVGElement;
      const idx = target.dataset.idx;
      if (!idx) return;
      const rect = rects[Number(idx)];
      if (rect.node.children.length > 0) {
        zoomStack.push(rect.node);
        layout();
      }
    });

    svg.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (zoomStack.length > 1) {
        zoomStack.pop();
        layout();
      }
    });

    svg.addEventListener("mousemove", (e) => {
      const target = e.target as SVGElement;
      const idx = target.dataset.idx;
      if (idx) {
        showTip(e.clientX, e.clientY, rects[Number(idx)].node, currentStates);
      } else {
        hideTip();
      }
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
    rects = [];
    zoomStack = [];
  },

  updateStates(states) {
    currentStates = states;
  },
};

function layout(): void {
  if (!svg || !group) return;
  const { width, height } = svg.getBoundingClientRect();
  if (width === 0 || height === 0) return;

  const root = zoomStack[zoomStack.length - 1];
  rects = [];
  squarify(root, 0, 0, width, height);

  group.innerHTML = "";
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(r.x));
    rect.setAttribute("y", String(r.y));
    rect.setAttribute("width", String(Math.max(0, r.w - 1)));
    rect.setAttribute("height", String(Math.max(0, r.h - 1)));
    rect.setAttribute("fill", color(r.node));
    rect.setAttribute("fill-opacity", r.node.kind === "entity" ? "0.8" : "0.3");
    rect.setAttribute("stroke", "#1e1e1e");
    rect.setAttribute("stroke-width", r.node.kind === "entity" ? "0.5" : "1.5");
    rect.dataset.idx = String(i);
    rect.style.cursor = r.node.children.length > 0 ? "pointer" : "default";
    g.appendChild(rect);

    if (r.w > 40 && r.h > 16) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(r.x + 4));
      text.setAttribute("y", String(r.y + 14));
      text.setAttribute("fill", "#e0e0e0");
      text.setAttribute("font-size", r.node.kind === "entity" ? "10" : "12");
      text.setAttribute("font-weight", r.node.kind === "entity" ? "normal" : "bold");
      text.setAttribute("pointer-events", "none");
      const maxChars = Math.floor(r.w / 7);
      const label = r.node.label.length > maxChars
        ? r.node.label.slice(0, maxChars - 1) + "\u2026"
        : r.node.label;
      text.textContent = label;
      g.appendChild(text);
    }

    group.appendChild(g);
  }
}

function leafCount(node: TreeNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((s, c) => s + leafCount(c), 0);
}

function squarify(node: TreeNode, x: number, y: number, w: number, h: number): void {
  rects.push({ x, y, w, h, node });

  if (node.children.length === 0 || w < 2 || h < 2) return;

  const pad = node.kind === "root" ? 0 : node.kind === "entity" ? 0 : 20;
  const ix = x + 1;
  const iy = y + (pad > 0 ? pad : 1);
  const iw = w - 2;
  const ih = h - (pad > 0 ? pad + 1 : 2);

  if (iw < 2 || ih < 2) return;

  const children = node.children
    .map((c) => ({ node: c, value: leafCount(c) }))
    .sort((a, b) => b.value - a.value);

  const total = children.reduce((s, c) => s + c.value, 0);

  sliceLayout(children, total, ix, iy, iw, ih);
}

function sliceLayout(
  items: { node: TreeNode; value: number }[],
  total: number,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  if (items.length === 0) return;

  const vertical = h > w;
  let offset = 0;

  for (const item of items) {
    const fraction = item.value / total;
    if (vertical) {
      const ch = h * fraction;
      squarify(item.node, x, y + offset, w, ch);
      offset += ch;
    } else {
      const cw = w * fraction;
      squarify(item.node, x + offset, y, cw, h);
      offset += cw;
    }
  }
}
