import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState, Registries } from "../ha/types";
import { color, showTip, hideTip, flatten } from "./shared";
import { createTransform, applyWheel, screenToWorld, type ZoomTransform } from "./zoom";
import { buildTree, buildTreeByDevice } from "../tree/build";

interface FNode {
  tree: TreeNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  r: number;
}

interface Cluster {
  groupNode: TreeNode;
  nodes: FNode[];
}

interface FEdge {
  source: FNode;
  target: FNode;
}

type GroupMode = "area" | "domain";
type StructureMode = "domain" | "device";

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let settingsPanel: HTMLDivElement | null = null;
let frame = 0;
let currentStates: Map<string, HaState> = new Map();
let currentRegistries: Registries | null = null;
let fnodes: FNode[] = [];
let fedges: FEdge[] = [];
let clusters: Cluster[] = [];
let entityNodeMap: Map<string, FNode> = new Map();
let glowTimestamps: Map<FNode, number> = new Map();
let width = 0, height = 0;
let needsFit = false;
let dragNode: FNode | null = null;
let panning = false;
let panStartX = 0, panStartY = 0;
let transform: ZoomTransform = createTransform();

let showHulls = false;
let showLabels = true;
let showEntities = false;
let groupBy: GroupMode = "area";
let structureMode: StructureMode = "domain";
let hiddenAreas: Set<string> = new Set();

const REPULSION = 800;
const SPRING_LEN = 40;
const SPRING_K = 0.03;
const DAMPING = 0.85;
const ALPHA_DECAY = 0.998;
const MAX_VELOCITY = 120;
let alpha = 1;

const ENTITY_LABEL_ZOOM = 2.5;
const DOMAIN_LABEL_ZOOM = 1.5;
const GLOW_DURATION = 3000;

export function createForceViz(registries: Registries): Visualization {
  return {
    name: "Force",

    create(container, _root, states) {
      currentStates = states;
      currentRegistries = registries;
      alpha = 1;
      transform = createTransform();

      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d")!;
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      container.appendChild(canvas);

      settingsPanel = createSettings(container);

      const obs = new ResizeObserver(() => resize());
      obs.observe(container);
      (canvas as any).__obs = obs;

      const root = structureMode === "device"
        ? buildTreeByDevice(registries)
        : buildTree(registries);
      buildGraph(root);
      resize();

      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", onMouseUp);
      canvas.addEventListener("mouseleave", () => { dragNode = null; panning = false; hideTip(); });
      canvas.addEventListener("wheel", onWheel, { passive: false });

      frame = requestAnimationFrame(tick);
    },

    destroy() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (canvas) {
        (canvas as any).__obs?.disconnect();
        canvas = null;
        ctx = null;
      }
      if (settingsPanel) {
        settingsPanel.remove();
        settingsPanel = null;
      }
      fnodes = [];
      fedges = [];
      clusters = [];
      entityNodeMap = new Map();
      glowTimestamps = new Map();
      dragNode = null;
      panning = false;
    },

    updateStates(states) {
      currentStates = states;
    },

    onEntityChanged(entityId: string) {
      const fn = entityNodeMap.get(entityId);
      if (fn) {
        glowTimestamps.set(fn, performance.now());
        ensureLoop();
      }
    },
  };
}

function rebuildWithStructure(): void {
  if (!currentRegistries || !canvas) return;

  const root = structureMode === "device"
    ? buildTreeByDevice(currentRegistries)
    : buildTree(currentRegistries);

  alpha = 1;
  buildGraph(root);
  resize();
}

function createSettings(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "force-settings";
  container.appendChild(panel);

  panel.appendChild(makeToggle("Hulls", showHulls, (v) => { showHulls = v; }));
  panel.appendChild(makeToggle("Labels", showLabels, (v) => { showLabels = v; }));
  panel.appendChild(makeToggle("Entities", showEntities, (v) => {
    showEntities = v;
    rebuildWithStructure();
  }));
  panel.appendChild(makeSelect("Group", ["area", "domain"], groupBy, (v) => {
    groupBy = v as GroupMode;
    rebuildClusters();
  }));
  panel.appendChild(makeSelect("Structure", ["domain", "device"], structureMode, (v) => {
    structureMode = v as StructureMode;
    rebuildWithStructure();
  }));

  if (currentRegistries && currentRegistries.areas.length > 0) {
    panel.appendChild(makeAreaFilter(currentRegistries.areas));
  }

  return panel;
}

function makeAreaFilter(areas: { area_id: string; name: string }[]): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";

  const btn = document.createElement("button");
  btn.className = "force-area-btn";
  btn.style.cssText = `
    background: var(--bg);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.1rem 0.5rem;
    font-size: 0.7rem;
    cursor: pointer;
    outline: none;
    white-space: nowrap;
  `;
  const updateBtnLabel = () => {
    const hidden = hiddenAreas.size;
    const total = areas.length;
    btn.textContent = hidden === 0 ? `Areas (all)` : `Areas (${total - hidden}/${total})`;
  };
  updateBtnLabel();

  const dropdown = document.createElement("div");
  dropdown.style.cssText = `
    display: none;
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 0;
    min-width: 180px;
    max-height: 50vh;
    overflow-y: auto;
    z-index: 400;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  `;

  // Header row: "All" / "None" buttons
  const header = document.createElement("div");
  header.style.cssText = `display:flex; gap:4px; padding:2px 8px 6px 8px; border-bottom:1px solid var(--border); margin-bottom:2px;`;
  const allBtn = document.createElement("button");
  allBtn.textContent = "All";
  allBtn.style.cssText = `font-size:0.65rem; padding:2px 8px; background:var(--bg); color:var(--text-muted); border:1px solid var(--border); border-radius:3px; cursor:pointer; flex:1;`;
  allBtn.addEventListener("click", () => {
    hiddenAreas.clear();
    dropdown.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(cb => cb.checked = true);
    updateBtnLabel();
    rebuildWithStructure();
  });
  const noneBtn = document.createElement("button");
  noneBtn.textContent = "None";
  noneBtn.style.cssText = allBtn.style.cssText;
  noneBtn.addEventListener("click", () => {
    // Store with "area:" prefix to match tree node IDs (e.g. "area:woonkamer")
    areas.forEach(a => hiddenAreas.add(`area:${a.area_id}`));
    dropdown.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(cb => cb.checked = false);
    updateBtnLabel();
    rebuildWithStructure();
  });
  header.appendChild(allBtn);
  header.appendChild(noneBtn);
  dropdown.appendChild(header);

  for (const area of areas) {
    const item = document.createElement("label");
    item.style.cssText = `display:flex; align-items:center; gap:6px; padding:3px 10px; font-size:0.72rem; color:var(--text); cursor:pointer;`;
    item.addEventListener("mouseover", () => { item.style.background = "rgba(255,255,255,0.05)"; });
    item.addEventListener("mouseout", () => { item.style.background = ""; });

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hiddenAreas.has(area.area_id);
    cb.style.accentColor = "var(--accent)";
    cb.addEventListener("change", () => {
      // Use "area:" prefix to match tree node IDs
      if (cb.checked) {
        hiddenAreas.delete(`area:${area.area_id}`);
      } else {
        hiddenAreas.add(`area:${area.area_id}`);
      }
      updateBtnLabel();
      rebuildWithStructure();
    });

    item.appendChild(cb);
    item.appendChild(document.createTextNode(area.name));
    dropdown.appendChild(item);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = dropdown.style.display === "block";
    dropdown.style.display = open ? "none" : "block";
  });

  document.addEventListener("click", () => { dropdown.style.display = "none"; }, { capture: false });

  wrapper.appendChild(btn);
  wrapper.appendChild(dropdown);
  return wrapper as unknown as HTMLDivElement;
}

function makeToggle(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "toggle-label";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = initial;
  input.addEventListener("change", () => onChange(input.checked));
  el.appendChild(input);
  el.appendChild(document.createTextNode(label));
  return el;
}

function makeSelect(label: string, options: string[], initial: string, onChange: (v: string) => void): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "toggle-label";
  el.appendChild(document.createTextNode(label));
  const select = document.createElement("select");
  select.className = "force-select";
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = opt;
    if (opt === initial) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  el.appendChild(select);
  return el;
}

function findAncestor(n: TreeNode, kind: string): TreeNode | null {
  let cur: TreeNode | null = n;
  while (cur) {
    if (cur.kind === kind) return cur;
    cur = cur.parent;
  }
  return null;
}

function rebuildClusters(): void {
  const clusterMap = new Map<string, Cluster>();

  for (const fn of fnodes) {
    let key: string | null = null;
    let groupNode: TreeNode | null = null;

    if (groupBy === "area") {
      const area = findAncestor(fn.tree, "area");
      if (area) {
        key = area.id;
        groupNode = area;
      }
    } else {
      const domain = fn.tree.domain;
      if (domain) {
        key = domain;
        if (fn.tree.kind === "domain") {
          groupNode = fn.tree;
        } else {
          groupNode = findAncestor(fn.tree, "domain");
        }
      }
    }

    if (!key || !groupNode) continue;

    let cluster = clusterMap.get(key);
    if (!cluster) {
      cluster = { groupNode, nodes: [] };
      clusterMap.set(key, cluster);
    }
    cluster.nodes.push(fn);
  }

  clusters = Array.from(clusterMap.values()).filter((c) => c.nodes.length >= 3);
}

function buildGraph(root: TreeNode): void {
  const allNodes = flatten(root);

  // Apply area filter
  const areaFiltered = hiddenAreas.size > 0
    ? allNodes.filter((n) => {
        const area = findAncestor(n, "area");
        // Keep node if: it has no area (root etc.), its area isn't hidden, or IT IS an area node that's not hidden
        if (n.kind === "area") return !hiddenAreas.has(n.id);
        return area === null || !hiddenAreas.has(area.id);
      })
    : allNodes;

  const nodes = showEntities ? areaFiltered : areaFiltered.filter((n) => n.kind !== "entity");
  const map = new Map<TreeNode, FNode>();

  // flatten() is pre-order DFS so parents always appear before children —
  // we can safely use parent positions for initial placement.
  fnodes = nodes.map((n) => {
    const r = n.kind === "root" ? 10 : n.kind === "area" ? 8
      : (n.kind === "domain" || n.kind === "device") ? 6 : 3;

    // Place each node near its parent to avoid large initial spring forces
    const parentFn = n.parent ? map.get(n.parent) : null;
    let jitter: number;
    if (!parentFn) {
      jitter = 0; // root at center
    } else if (n.kind === "area") {
      jitter = 200;
    } else if (n.kind === "domain" || n.kind === "device") {
      jitter = 100;
    } else {
      jitter = 50; // entity
    }

    const cx = parentFn ? parentFn.x : 600;
    const cy = parentFn ? parentFn.y : 400;

    const fn: FNode = {
      tree: n,
      x: cx + (Math.random() - 0.5) * jitter,
      y: cy + (Math.random() - 0.5) * jitter,
      vx: 0, vy: 0,
      fx: null, fy: null,
      r,
    };
    map.set(n, fn);
    return fn;
  });

  fedges = [];
  for (const n of nodes) {
    if (!n.parent) continue;
    const source = map.get(n.parent);
    const target = map.get(n);
    if (source && target) fedges.push({ source, target });
  }

  entityNodeMap = new Map();
  for (const fn of fnodes) {
    if (fn.tree.entityId) {
      entityNodeMap.set(fn.tree.entityId, fn);
    }
  }

  glowTimestamps = new Map();
  rebuildClusters();
  needsFit = true;
}

function fitAll(): void {
  if (!fnodes.length || !width || !height) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of fnodes) {
    if (!isFinite(n.x) || !isFinite(n.y)) continue;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (!isFinite(minX)) return;
  const pad = 60;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  const k = Math.min(width / bw, height / bh, 2);
  transform.k = k;
  transform.x = width / 2 - k * (minX + maxX) / 2;
  transform.y = height / 2 - k * (minY + maxY) / 2;
}

function resize(): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  if (needsFit && width > 0 && height > 0) {
    fitAll();
    needsFit = false;
    ensureLoop();
  }
}

function tick(): void {
  if (!canvas) return;

  if (alpha > 0.001) {
    simulate();
    alpha *= ALPHA_DECAY;
  }

  draw();

  const needsAnimation = alpha > 0.001 || glowTimestamps.size > 0 || dragNode !== null || panning;
  if (needsAnimation) {
    frame = requestAnimationFrame(tick);
  } else {
    frame = 0;
  }
}

const GRID_CELL = 200;

function simulate(): void {
  const ra = REPULSION * alpha;

  // Spatial grid to limit repulsion to nearby nodes (O(n·k) instead of O(n²))
  const grid = new Map<number, FNode[]>();
  for (const n of fnodes) {
    if (!isFinite(n.x) || !isFinite(n.y)) continue;
    const key = Math.floor(n.x / GRID_CELL) * 1000003 + Math.floor(n.y / GRID_CELL);
    let cell = grid.get(key);
    if (!cell) { cell = []; grid.set(key, cell); }
    cell.push(n);
  }

  for (const a of fnodes) {
    if (!isFinite(a.x) || !isFinite(a.y)) continue;
    const cx = Math.floor(a.x / GRID_CELL);
    const cy = Math.floor(a.y / GRID_CELL);
    for (let ddx = -1; ddx <= 1; ddx++) {
      for (let ddy = -1; ddy <= 1; ddy++) {
        const neighbors = grid.get((cx + ddx) * 1000003 + (cy + ddy));
        if (!neighbors) continue;
        for (const b of neighbors) {
          if (b === a) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const fd = ra / (d2 * Math.sqrt(d2));
          a.vx -= dx * fd;
          a.vy -= dy * fd;
        }
      }
    }
  }

  for (const edge of fedges) {
    const dx = edge.target.x - edge.source.x;
    const dy = edge.target.y - edge.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - SPRING_LEN) * SPRING_K * alpha;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    edge.source.vx += fx;
    edge.source.vy += fy;
    edge.target.vx -= fx;
    edge.target.vy -= fy;
  }

  for (const n of fnodes) {
    n.vx += (width / 2 - n.x) * 0.001 * alpha;
    n.vy += (height / 2 - n.y) * 0.001 * alpha;
  }

  for (const n of fnodes) {
    // Recover from NaN/Infinity (shouldn't happen with clamping, but just in case)
    if (!isFinite(n.x) || !isFinite(n.y) || !isFinite(n.vx) || !isFinite(n.vy)) {
      n.x = width / 2 + (Math.random() - 0.5) * 100;
      n.y = height / 2 + (Math.random() - 0.5) * 100;
      n.vx = 0;
      n.vy = 0;
      continue;
    }

    if (n.fx !== null) {
      n.x = n.fx;
      n.vx = 0;
    } else {
      n.vx *= DAMPING;
      // Clamp velocity to prevent runaway acceleration
      if (n.vx > MAX_VELOCITY) n.vx = MAX_VELOCITY;
      else if (n.vx < -MAX_VELOCITY) n.vx = -MAX_VELOCITY;
      n.x += n.vx;
    }

    if (n.fy !== null) {
      n.y = n.fy;
      n.vy = 0;
    } else {
      n.vy *= DAMPING;
      if (n.vy > MAX_VELOCITY) n.vy = MAX_VELOCITY;
      else if (n.vy < -MAX_VELOCITY) n.vy = -MAX_VELOCITY;
      n.y += n.vy;
    }
  }
}

/** Andrew's monotone chain convex hull. Returns points in CCW order. */
function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const n = sorted.length;

  function cross(o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  const lower: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) {
      lower.pop();
    }
    lower.push(sorted[i]);
  }

  const upper: { x: number; y: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0) {
      upper.pop();
    }
    upper.push(sorted[i]);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

const HULL_PAD = 20;

function drawHull(ctx: CanvasRenderingContext2D, cluster: Cluster): void {
  const points = cluster.nodes.map((n) => ({ x: n.x, y: n.y }));
  const hull = convexHull(points);
  if (hull.length < 3) return;

  let cx = 0, cy = 0;
  for (const p of hull) { cx += p.x; cy += p.y; }
  cx /= hull.length;
  cy /= hull.length;

  const expanded = hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: p.x + (dx / len) * HULL_PAD, y: p.y + (dy / len) * HULL_PAD };
  });

  const n = expanded.length;
  ctx.beginPath();
  const startX = (expanded[n - 1].x + expanded[0].x) / 2;
  const startY = (expanded[n - 1].y + expanded[0].y) / 2;
  ctx.moveTo(startX, startY);

  for (let i = 0; i < n; i++) {
    const curr = expanded[i];
    const next = expanded[(i + 1) % n];
    const midX = (curr.x + next.x) / 2;
    const midY = (curr.y + next.y) / 2;
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  }

  ctx.closePath();

  const fillColor = color(cluster.groupNode);
  ctx.fillStyle = fillColor;
  ctx.globalAlpha = 0.08;
  ctx.fill();

  ctx.strokeStyle = fillColor;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1.5 / transform.k;
  ctx.stroke();

  ctx.globalAlpha = 1;
}

function drawLabels(ctx: CanvasRenderingContext2D): void {
  const fontSize = 10 / transform.k;
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const n of fnodes) {
    const kind = n.tree.kind;

    if (kind === "entity" && transform.k < ENTITY_LABEL_ZOOM) continue;
    if ((kind === "domain" || kind === "device") && transform.k < DOMAIN_LABEL_ZOOM) continue;

    let labelAlpha = 1;
    if (kind === "entity") {
      labelAlpha = Math.min(1, (transform.k - ENTITY_LABEL_ZOOM) / 0.5);
    } else if (kind === "domain" || kind === "device") {
      labelAlpha = Math.min(1, (transform.k - DOMAIN_LABEL_ZOOM) / 0.5);
    }

    ctx.fillStyle = kind === "entity" ? "#bbb" : "#e0e0e0";
    ctx.globalAlpha = Math.max(0.3, labelAlpha);
    ctx.fillText(n.tree.label, n.x, n.y + n.r + 2 / transform.k);
  }

  ctx.globalAlpha = 1;
}

function drawGlows(ctx: CanvasRenderingContext2D): void {
  const now = performance.now();
  const expired: FNode[] = [];

  for (const [fn, startTime] of glowTimestamps) {
    const elapsed = now - startTime;
    if (elapsed > GLOW_DURATION) {
      expired.push(fn);
      continue;
    }

    const progress = elapsed / GLOW_DURATION;
    const ease = 1 - (1 - progress) * (1 - progress);
    const ringRadius = fn.r * (1 + ease * 11);
    const opacity = 1 - progress;
    const nodeColor = color(fn.tree);

    ctx.beginPath();
    ctx.arc(fn.x, fn.y, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = nodeColor;
    ctx.globalAlpha = opacity * 0.2;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(fn.x, fn.y, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = nodeColor;
    ctx.globalAlpha = opacity * 0.9;
    ctx.lineWidth = (3 + 4 * (1 - progress)) / transform.k;
    ctx.stroke();

    if (progress < 0.4) {
      const flashOpacity = 1 - progress / 0.4;
      ctx.beginPath();
      ctx.arc(fn.x, fn.y, fn.r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = flashOpacity * 0.5;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  for (const fn of expired) {
    glowTimestamps.delete(fn);
  }
}

function draw(): void {
  if (!canvas || !ctx) return;
  const dpr = devicePixelRatio;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.setTransform(
    dpr * transform.k, 0,
    0, dpr * transform.k,
    dpr * transform.x, dpr * transform.y
  );

  if (showHulls) {
    for (const cluster of clusters) {
      drawHull(ctx, cluster);
    }
  }

  ctx.lineWidth = 0.5 / transform.k;
  ctx.strokeStyle = "#444";
  for (const e of fedges) {
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }

  for (const n of fnodes) {
    if (!isFinite(n.x) || !isFinite(n.y)) continue;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = color(n.tree);
    ctx.fill();
  }

  drawGlows(ctx);

  if (showLabels) {
    drawLabels(ctx);
  }
}

function hitTest(screenX: number, screenY: number): FNode | null {
  const world = screenToWorld(transform, screenX, screenY);
  for (let i = fnodes.length - 1; i >= 0; i--) {
    const n = fnodes[i];
    const dx = n.x - world.x;
    const dy = n.y - world.y;
    if (dx * dx + dy * dy <= (n.r + 2) * (n.r + 2)) return n;
  }
  return null;
}

function ensureLoop(): void {
  if (!frame && canvas) {
    frame = requestAnimationFrame(tick);
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (!canvas) return;
  applyWheel(transform, e, canvas.getBoundingClientRect());
  ensureLoop();
}

function onMouseDown(e: MouseEvent): void {
  const n = hitTest(e.offsetX, e.offsetY);
  if (n) {
    dragNode = n;
    n.fx = n.x;
    n.fy = n.y;
    alpha = Math.max(alpha, 0.3);
  } else {
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
  }
  ensureLoop();
}

function onMouseMove(e: MouseEvent): void {
  if (dragNode) {
    const world = screenToWorld(transform, e.offsetX, e.offsetY);
    dragNode.fx = world.x;
    dragNode.fy = world.y;
    alpha = Math.max(alpha, 0.1);
  } else if (panning) {
    transform.x += e.clientX - panStartX;
    transform.y += e.clientY - panStartY;
    panStartX = e.clientX;
    panStartY = e.clientY;
  }
  const n = hitTest(e.offsetX, e.offsetY);
  if (n) showTip(e.clientX, e.clientY, n.tree, currentStates);
  else hideTip();
}

function onMouseUp(): void {
  if (dragNode) {
    dragNode.fx = null;
    dragNode.fy = null;
    dragNode = null;
  }
  panning = false;
}
