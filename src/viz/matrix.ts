import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { color, showTip, hideTip, flatten } from "./shared";
import { createTransform, applyWheel, screenToWorld, type ZoomTransform } from "./zoom";

let canvas: HTMLCanvasElement | null = null;
let currentStates: Map<string, HaState> = new Map();
let domains: { node: TreeNode; entities: TreeNode[] }[] = [];
let width = 0, height = 0;
let transform: ZoomTransform = createTransform();
let panning = false;
let panStartX = 0, panStartY = 0;

export const matrixViz: Visualization = {
  name: "Matrix",

  create(container, root, states) {
    currentStates = states;
    transform = createTransform();

    canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas);

    const obs = new ResizeObserver(() => { resize(); draw(); });
    obs.observe(container);
    (canvas as any).__obs = obs;

    buildMatrix(root);
    resize();
    draw();

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", () => { panning = false; hideTip(); });
    canvas.addEventListener("wheel", onWheel, { passive: false });
  },

  destroy() {
    if (canvas) {
      (canvas as any).__obs?.disconnect();
      canvas = null;
    }
    domains = [];
    panning = false;
  },

  updateStates(states) {
    currentStates = states;
    draw();
  },
};

function buildMatrix(root: TreeNode): void {
  const allNodes = flatten(root);
  const domainMap = new Map<string, { node: TreeNode; entities: TreeNode[] }>();

  for (const node of allNodes) {
    if (node.kind === "domain" && node.domain) {
      domainMap.set(node.domain, { node, entities: [] });
    }
  }

  for (const node of allNodes) {
    if (node.kind === "entity" && node.domain) {
      const domain = domainMap.get(node.domain);
      if (domain) domain.entities.push(node);
    }
  }

  domains = Array.from(domainMap.values())
    .filter((d) => d.entities.length > 0)
    .sort((a, b) => b.entities.length - a.entities.length);
}

function resize(): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
}

const LABEL_WIDTH = 100;
const HEADER_HEIGHT = 20;
const BASE_CELL_SIZE = 10;
const ROW_HEIGHT = 16;

function draw(): void {
  if (!canvas || domains.length === 0) return;
  const ctx = canvas.getContext("2d")!;
  const dpr = devicePixelRatio;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.setTransform(
    dpr * transform.k, 0,
    0, dpr * transform.k,
    dpr * transform.x, dpr * transform.y
  );

  const cellSize = BASE_CELL_SIZE;
  const rowH = ROW_HEIGHT;

  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(-transform.x / transform.k, -transform.y / transform.k, width / transform.k, HEADER_HEIGHT);

  for (let di = 0; di < domains.length; di++) {
    const d = domains[di];
    const y = HEADER_HEIGHT + di * rowH;

    ctx.fillStyle = "#9e9e9e";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    const labelText = d.node.label.length > 14
      ? d.node.label.slice(0, 13) + "\u2026"
      : d.node.label;
    ctx.fillText(labelText, LABEL_WIDTH - 8, y + rowH / 2 + 3);

    if (di % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(LABEL_WIDTH, y, d.entities.length * cellSize, rowH);
    }

    for (let ei = 0; ei < d.entities.length; ei++) {
      const entity = d.entities[ei];
      const ex = LABEL_WIDTH + ei * cellSize;
      const ey = y + 1;
      const cw = cellSize - 1;
      const ch = rowH - 2;

      let fillColor = color(entity);
      let opacity = 0.4;

      if (entity.entityId) {
        const state = currentStates.get(entity.entityId);
        if (state) {
          if (state.state === "on" || state.state === "home" || state.state === "playing") {
            opacity = 1;
          } else if (state.state === "off" || state.state === "not_home" || state.state === "idle") {
            opacity = 0.2;
          } else if (state.state === "unavailable" || state.state === "unknown") {
            fillColor = "#333";
            opacity = 0.5;
          } else {
            opacity = 0.6;
          }
        }
      }

      ctx.fillStyle = fillColor;
      ctx.globalAlpha = opacity;
      ctx.fillRect(ex, ey, cw, ch);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = "#666";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(String(d.entities.length), LABEL_WIDTH + d.entities.length * cellSize + 4, y + rowH / 2 + 3);
  }
}

function hitTestEntity(screenX: number, screenY: number): TreeNode | null {
  const world = screenToWorld(transform, screenX, screenY);
  const rowH = ROW_HEIGHT;

  for (let di = 0; di < domains.length; di++) {
    const d = domains[di];
    const y = HEADER_HEIGHT + di * rowH;

    if (world.y < y || world.y > y + rowH) continue;
    if (world.x < LABEL_WIDTH) return d.node;

    const ei = Math.floor((world.x - LABEL_WIDTH) / BASE_CELL_SIZE);
    if (ei >= 0 && ei < d.entities.length) {
      return d.entities[ei];
    }
    return null;
  }
  return null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (!canvas) return;
  applyWheel(transform, e, canvas.getBoundingClientRect());
  draw();
}

function onMouseDown(e: MouseEvent): void {
  panning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
}

function onMouseMove(e: MouseEvent): void {
  if (panning) {
    transform.x += e.clientX - panStartX;
    transform.y += e.clientY - panStartY;
    panStartX = e.clientX;
    panStartY = e.clientY;
    draw();
  }

  const entity = hitTestEntity(e.offsetX, e.offsetY);
  if (entity) showTip(e.clientX, e.clientY, entity, currentStates);
  else hideTip();
}

function onMouseUp(): void {
  panning = false;
}
