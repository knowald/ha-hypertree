import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { abs } from "../hyperbolic/complex";
import { geodesicArcPath } from "../hyperbolic/poincare";
import { nodeColor } from "./colors";
import { showTooltip, hideTooltip } from "./tooltip";

const LABEL_RADIUS_THRESHOLD = 0.012;
const BASE_RADIUS = 0.025;
const MIN_RADIUS = 0.003;
const CULL_DISTANCE = 0.97;

export interface RenderState {
  svg: SVGSVGElement;
  edgeGroup: SVGGElement;
  nodeGroup: SVGGElement;
  labelGroup: SVGGElement;
  nodes: TreeNode[];
  edges: [TreeNode, TreeNode][];
  states: Map<string, HaState>;
  nodeEls: SVGCircleElement[];
  edgeEls: SVGPathElement[];
  labelEls: SVGTextElement[];
  nodeVisible: boolean[];
  edgeVisible: boolean[];
}

export function nodeRadius(node: TreeNode): number {
  const d = abs(node.screenZ);
  const conformal = 1 - d * d;
  const kindScale =
    node.kind === "root" ? 2 : node.kind === "area" ? 1.5 : node.kind === "domain" ? 1.2 : 1;
  return Math.max(BASE_RADIUS * conformal * kindScale, MIN_RADIUS);
}

function truncateLabel(label: string, kind: string): string {
  const maxLen = kind === "entity" ? 20 : 16;
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + "\u2026";
}

export function createRenderer(
  container: HTMLElement,
  nodes: TreeNode[],
  edges: [TreeNode, TreeNode][]
): RenderState {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "-1.05 -1.05 2.1 2.1");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.id = "hypertree-svg";
  container.appendChild(svg);

  const disk = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  disk.setAttribute("cx", "0");
  disk.setAttribute("cy", "0");
  disk.setAttribute("r", "1");
  disk.setAttribute("class", "disk-boundary");
  svg.appendChild(disk);

  const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edgeGroup.setAttribute("class", "edges");
  svg.appendChild(edgeGroup);

  const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  nodeGroup.setAttribute("class", "nodes");
  svg.appendChild(nodeGroup);

  const labelGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelGroup.setAttribute("class", "labels");
  svg.appendChild(labelGroup);

  const edgeEls: SVGPathElement[] = [];
  for (let i = 0; i < edges.length; i++) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("class", "edge");
    el.setAttribute("stroke", nodeColor(edges[i][1].kind, edges[i][1].domain));
    el.setAttribute("display", "none");
    edgeGroup.appendChild(el);
    edgeEls.push(el);
  }

  const nodeEls: SVGCircleElement[] = [];
  const labelEls: SVGTextElement[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", `node node-${node.kind}`);
    circle.setAttribute("fill", nodeColor(node.kind, node.domain));
    circle.dataset.idx = String(i);
    circle.setAttribute("display", "none");
    nodeGroup.appendChild(circle);
    nodeEls.push(circle);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "label");
    text.setAttribute("pointer-events", "none");
    text.textContent = truncateLabel(node.label, node.kind);
    text.setAttribute("display", "none");
    labelGroup.appendChild(text);
    labelEls.push(text);
  }

  const state: RenderState = {
    svg,
    edgeGroup,
    nodeGroup,
    labelGroup,
    nodes,
    edges,
    states: new Map(),
    nodeEls,
    edgeEls,
    labelEls,
    nodeVisible: new Array(nodes.length).fill(true),
    edgeVisible: new Array(edges.length).fill(true),
  };

  nodeGroup.addEventListener("mouseenter", (event: MouseEvent) => {
    const target = event.target as SVGCircleElement;
    if (target.tagName !== "circle" || !target.dataset.idx) return;
    const node = nodes[Number(target.dataset.idx)];
    showTooltip(event.clientX, event.clientY, node.label, node.entityId, state.states);
  }, true);

  nodeGroup.addEventListener("mousemove", (event: MouseEvent) => {
    const target = event.target as SVGCircleElement;
    if (target.tagName !== "circle" || !target.dataset.idx) return;
    const node = nodes[Number(target.dataset.idx)];
    showTooltip(event.clientX, event.clientY, node.label, node.entityId, state.states);
  }, true);

  nodeGroup.addEventListener("mouseleave", (event: MouseEvent) => {
    const target = event.target as SVGCircleElement;
    if (target.tagName !== "circle") return;
    hideTooltip();
  }, true);

  return state;
}

export function render(state: RenderState): void {
  const { nodes, edges, nodeEls, edgeEls, labelEls, nodeVisible, edgeVisible } = state;

  for (let i = 0; i < edges.length; i++) {
    const el = edgeEls[i];
    if (!edgeVisible[i]) {
      el.setAttribute("display", "none");
      continue;
    }

    const [parent, child] = edges[i];
    const dist = Math.max(abs(parent.screenZ), abs(child.screenZ));

    if (dist > CULL_DISTANCE) {
      el.setAttribute("display", "none");
      continue;
    }

    el.removeAttribute("display");
    el.setAttribute("d", geodesicArcPath(parent.screenZ, child.screenZ));
    el.setAttribute("stroke-opacity", String(Math.max(0.1, 1 - dist)));
  }

  for (let i = 0; i < nodes.length; i++) {
    const el = nodeEls[i];
    const label = labelEls[i];

    if (!nodeVisible[i]) {
      el.setAttribute("display", "none");
      label.setAttribute("display", "none");
      continue;
    }

    const node = nodes[i];
    const d = abs(node.screenZ);

    if (d > CULL_DISTANCE) {
      el.setAttribute("display", "none");
      label.setAttribute("display", "none");
      continue;
    }

    el.removeAttribute("display");
    const r = nodeRadius(node);
    el.setAttribute("cx", String(node.screenZ[0]));
    el.setAttribute("cy", String(node.screenZ[1]));
    el.setAttribute("r", String(r));
    el.setAttribute("fill-opacity", String(Math.max(0.3, 1 - d * 0.7)));

    if (r > LABEL_RADIUS_THRESHOLD) {
      label.removeAttribute("display");
      label.setAttribute("x", String(node.screenZ[0]));
      label.setAttribute("y", String(node.screenZ[1] - r - 0.005));
      label.setAttribute("fill-opacity", String(Math.max(0, 1 - d * 1.5)));
    } else {
      label.setAttribute("display", "none");
    }
  }
}
