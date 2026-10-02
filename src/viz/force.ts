import type { Connection } from "home-assistant-js-websocket";
import type { TreeNode } from "../tree/types";
import type { HaState, Registries } from "../ha/types";
import { showTooltip, hideTooltip } from "../render/tooltip";
import { nodeColor, randomizeColors, resetColors, getDomainColors, setDomainColors, setDomainColor, domainList } from "../render/colors";
import { getEntityIconName, getCachedIcon, requestIcon, setIconResolveCallback } from "../render/icons";
import { createTransform, applyWheel, zoomAt, screenToWorld, fitTransform, type ZoomTransform } from "./zoom";
import { limitStep as limitStepVec, needsRescue } from "./stability";
import { t, optionLabel, domainLabel, domainTitle } from "../i18n";
import { buildTree, buildTreeByDevice, flattenTree } from "../tree/build";
import { loadCredentials, saveCredentials } from "../login";
import { getRootElement } from "../rootElement";
import { updateFps, markFpsIdle, debugLog } from "../debug";
import { fetchAutomationEdges, type AutomationEdge, type AutomationRelation } from "../ha/automation";
import {
  settings, saveSettings, applySettings,
  type StarEffect, type UnavailableMode, type InitialLayout, type GroupMode, type StructureMode,
} from "./settings";

interface FNode {
  tree: TreeNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  r: number;
  phase: number;
}

interface Cluster {
  groupNode: TreeNode;
  nodes: FNode[];
}

interface FEdge {
  source: FNode;
  target: FNode;
}


let canvas: HTMLCanvasElement | null = null;
let glassLabels: HTMLDivElement[] = [];
let glassContainer: HTMLDivElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let settingsPanel: { toolbar: HTMLDivElement } | null = null;
let frame = 0;
let currentStates: Map<string, HaState> = new Map();
let currentRegistries: Registries | null = null;
let panelHaUrl = "";
let reconnectCallback: ((creds: { url: string; token: string }) => void) | null = null;
let fnodes: FNode[] = [];
let fedges: FEdge[] = [];
let clusters: Cluster[] = [];
let entityNodeMap: Map<string, FNode> = new Map();
let glowTimestamps: Map<FNode, number> = new Map();
let nodeCluster: Map<FNode, Cluster> = new Map();
let parentFNode: Map<FNode, FNode> = new Map();
let childFNodes: Map<FNode, FNode[]> = new Map();
let width = 0, height = 0;
let dragNode: FNode | null = null;
let panning = false;
let panStartX = 0, panStartY = 0;
// Pan inertia: velocity in screen px/ms, carried after release and decayed per frame.
let panVelocityX = 0, panVelocityY = 0;
let lastPanMoveTime = 0;
let lastInertiaFrame = 0;
const PAN_INERTIA_DECAY_MS = 325;
const PAN_INERTIA_MIN_SPEED = 0.02;
const PAN_RELEASE_IDLE_MS = 60;
let transform: ZoomTransform = createTransform();

let hoveredNode: FNode | null = null;
let hoverStartTime = 0;
let searchQuery = "";
let didDrag = false;
let contextMenu: HTMLElement | null = null;
let contextMenuDismiss: ((ev: MouseEvent) => void) | null = null;
let contextMenuDismissTimer: number | null = null;
let onMouseLeave: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

const ALPHA_DECAY = 0.998;
let alpha = 1;

let revealedNodes: Set<string> = new Set();
let stateChangeCounts: Map<string, number> = new Map();
let allTreeNodesById: Map<string, TreeNode> = new Map();
let allEntityTreeNodes: Map<string, TreeNode> = new Map();
let pendingReveals: string[] = [];
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let collapsedNodes: Set<string> = new Set();

let haConnection: Connection | null = null;
let automationEdges: AutomationEdge[] = [];
let automationEdgesByEntity: Map<string, AutomationEdge[]> = new Map();
let automationLoading = false;
let automationLoaded = false;
let onAutomationLoaded: (() => void) | null = null;

const GLOW_DURATION = 3000;

// Star sprite cache: pre-rendered gradient stars keyed by "color|sizeCategory|glowParam"
const spriteCache = new Map<string, StarSprite>();
let lastSpriteParams = "";

function getSpriteParams(): string {
  return `${settings.glowIntensity}|${settings.parentGlowIntensity}`;
}

function invalidateSpriteCache(): void {
  const params = getSpriteParams();
  if (params !== lastSpriteParams) {
    spriteCache.clear();
    lastSpriteParams = params;
  }
}

let centroidCache: { x: number; y: number }[] | null = null;
let centroidEdgeCache: [number, number][] = [];
let centroidCacheClusters: Cluster[] | null = null;

// World-space viewport bounds, refreshed at the start of every draw().
let viewMinX = 0, viewMaxX = 0, viewMinY = 0, viewMaxY = 0;

function updateViewBounds(): void {
  viewMinX = -transform.x / transform.k;
  viewMinY = -transform.y / transform.k;
  viewMaxX = (width - transform.x) / transform.k;
  viewMaxY = (height - transform.y) / transform.k;
}

function inView(x: number, y: number, margin: number): boolean {
  return x >= viewMinX - margin && x <= viewMaxX + margin &&
    y >= viewMinY - margin && y <= viewMaxY + margin;
}

function segmentInView(x1: number, y1: number, x2: number, y2: number, margin: number): boolean {
  return Math.max(x1, x2) >= viewMinX - margin && Math.min(x1, x2) <= viewMaxX + margin &&
    Math.max(y1, y2) >= viewMinY - margin && Math.min(y1, y2) <= viewMaxY + margin;
}

// Radial gradients are not GPU-accelerated in Firefox; creating one per frame
// drops that draw to a software path. Render each glow once into a sprite and
// stamp it with drawImage, which stays on the GPU texture cache.
type GlowSpriteProfile = "blast" | "head" | "core" | "soft" | "ring3" | "ring25";

const GLOW_SPRITE_SIZE = 128;
const glowSpriteCache = new Map<string, OffscreenCanvas>();

function getGlowSprite(profile: GlowSpriteProfile, glowColor: string): OffscreenCanvas {
  const key = `${profile}|${glowColor}`;
  let sprite = glowSpriteCache.get(key);
  if (sprite) return sprite;

  sprite = new OffscreenCanvas(GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
  const sctx = sprite.getContext("2d")!;
  const center = GLOW_SPRITE_SIZE / 2;
  const inner = profile === "ring3" ? center / 3 : profile === "ring25" ? center / 2.5 : 0;
  const grad = sctx.createRadialGradient(center, center, inner, center, center, center);
  switch (profile) {
    case "blast":
      grad.addColorStop(0, "#fff");
      grad.addColorStop(0.15, glowColor);
      break;
    case "head":
      grad.addColorStop(0, "#fff");
      grad.addColorStop(0.3, glowColor);
      break;
    case "core":
      grad.addColorStop(0, "#fff");
      grad.addColorStop(0.5, glowColor);
      break;
    case "soft":
    case "ring3":
    case "ring25":
      grad.addColorStop(0, glowColor);
      break;
  }
  grad.addColorStop(1, transparent(glowColor));
  sctx.fillStyle = grad;
  sctx.beginPath();
  sctx.arc(center, center, center, 0, Math.PI * 2);
  sctx.fill();
  glowSpriteCache.set(key, sprite);
  return sprite;
}

// CJK faces are listed before the generic fallback so Chinese labels and
// settings text resolve to a real CJK font instead of a browser-chosen one.
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif";

// Cache measureText results, which are costly per label per frame. Metrics do
// NOT scale linearly with font size on macOS (San Francisco applies
// size-dependent tracking), so quantize the size into the key and measure at
// that size; re-measuring then only happens while the zoom level changes.
interface LabelMetrics {
  width: number;
  ascent: number;
  descent: number;
}
const labelMetricsCache = new Map<string, LabelMetrics>();

// Webfonts (Roboto in the HA panel) may activate after the first frame;
// metrics measured against the fallback font would stay wrong forever.
document.fonts?.ready.then(() => labelMetricsCache.clear());

function measureLabel(ctx: CanvasRenderingContext2D, label: string, weight: number, fontSize: number): LabelMetrics {
  const bucket = Math.max(0.25, Math.round(fontSize * 4) / 4);
  const key = `${weight}|${bucket}|${label}`;
  let cached = labelMetricsCache.get(key);
  if (!cached) {
    if (labelMetricsCache.size > 20000) labelMetricsCache.clear();
    const previousFont = ctx.font;
    ctx.font = `${weight} ${bucket}px ${FONT_FAMILY}`;
    const m = ctx.measureText(label);
    cached = {
      width: m.width,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
    };
    labelMetricsCache.set(key, cached);
    ctx.font = previousFont;
  }
  return cached;
}

interface StarSprite {
  halo: OffscreenCanvas;
  core: OffscreenCanvas;
  size: number;
}

function getStarSprite(nodeCol: string, intensity: number): StarSprite {
  const key = `${nodeCol}|${intensity}|${settings.haloFalloff}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const spritePixels = 256;
  const center = spritePixels / 2;
  const haloR = center;
  const innerR = (center / 8) * 3 * intensity;
  const coreR = (center / 8) * 0.6;
  const spikeLen = (center / 8) * 3;

  const haloCanvas = new OffscreenCanvas(spritePixels, spritePixels);
  const hctx = haloCanvas.getContext("2d")!;

  const sigma = 0.15 + 0.55 * settings.haloFalloff;
  const baseline = Math.exp(-(1 / sigma) * (1 / sigma));
  const norm = 1 / (1 - baseline);
  const stops = 12;
  const outerGlow = hctx.createRadialGradient(center, center, 0, center, center, haloR);
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    const raw = Math.exp(-(t / sigma) * (t / sigma));
    const a = Math.max(0, (raw - baseline) * norm);
    const whiten = Math.min(1, a * 1.4) * 0.3;
    outerGlow.addColorStop(t, rgbaFromHex(nodeCol, a, whiten));
  }
  hctx.globalAlpha = 0.7 * intensity;
  hctx.fillStyle = outerGlow;
  hctx.beginPath();
  hctx.arc(center, center, haloR, 0, Math.PI * 2);
  hctx.fill();

  const coreCanvas = new OffscreenCanvas(spritePixels, spritePixels);
  const cctx = coreCanvas.getContext("2d")!;

  const innerGlow = cctx.createRadialGradient(center, center, 0, center, center, innerR);
  innerGlow.addColorStop(0, "#fff");
  innerGlow.addColorStop(0.2, "#fff");
  innerGlow.addColorStop(0.5, nodeCol);
  innerGlow.addColorStop(1, transparent(nodeCol));
  cctx.globalAlpha = 0.9 * intensity;
  cctx.fillStyle = innerGlow;
  cctx.beginPath();
  cctx.arc(center, center, innerR, 0, Math.PI * 2);
  cctx.fill();

  cctx.globalAlpha = 1;
  cctx.fillStyle = "#fff";
  cctx.beginPath();
  cctx.arc(center, center, coreR * 1.8, 0, Math.PI * 2);
  cctx.fill();

  const spikeGrad = cctx.createLinearGradient(center - spikeLen, center, center + spikeLen, center);
  spikeGrad.addColorStop(0, transparent(nodeCol));
  spikeGrad.addColorStop(0.3, nodeCol);
  spikeGrad.addColorStop(0.5, "#fff");
  spikeGrad.addColorStop(0.7, nodeCol);
  spikeGrad.addColorStop(1, transparent(nodeCol));
  cctx.strokeStyle = spikeGrad;
  cctx.globalAlpha = 0.8;
  cctx.lineWidth = 1.5;
  cctx.beginPath();
  cctx.moveTo(center - spikeLen, center);
  cctx.lineTo(center + spikeLen, center);
  cctx.stroke();

  const vSpikeGrad = cctx.createLinearGradient(center, center - spikeLen, center, center + spikeLen);
  vSpikeGrad.addColorStop(0, transparent(nodeCol));
  vSpikeGrad.addColorStop(0.3, nodeCol);
  vSpikeGrad.addColorStop(0.5, "#fff");
  vSpikeGrad.addColorStop(0.7, nodeCol);
  vSpikeGrad.addColorStop(1, transparent(nodeCol));
  cctx.strokeStyle = vSpikeGrad;
  cctx.beginPath();
  cctx.moveTo(center, center - spikeLen);
  cctx.lineTo(center, center + spikeLen);
  cctx.stroke();

  const entry: StarSprite = { halo: haloCanvas, core: coreCanvas, size: spritePixels };
  spriteCache.set(key, entry);
  return entry;
}

export function createForceViz(registries: Registries, haUrl?: string, connection?: Connection, onReconnect?: (creds: { url: string; token: string }) => void) {
  panelHaUrl = haUrl ?? "";
  haConnection = connection ?? null;
  reconnectCallback = onReconnect ?? null;
  return {
    create(container: HTMLElement, states: Map<string, HaState>) {
      currentStates = states;
      currentRegistries = registries;
      alpha = 1;
      transform = createTransform();

      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d")!;
      canvas.style.display = "block";
      canvas.style.touchAction = "none";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      container.appendChild(canvas);

      glassContainer = document.createElement("div");
      glassContainer.className = "glass-label-container";
      container.appendChild(glassContainer);

      settingsPanel = createSettings(container);

      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(container);

      buildGraph(buildCurrentTree());
      resize();
      if (settings.showAutomationEdges || settings.automationOnly) loadAutomationEdges();

      setIconResolveCallback(() => ensureLoop());

      onMouseLeave = () => { dragNode = null; panning = false; hoveredNode = null; hideTooltip(); };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointerleave", onMouseLeave);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);

      frame = requestAnimationFrame(tick);
    },

    destroy() {
      cancelAnimationFrame(frame);
      frame = 0;
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (canvas) {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        if (onMouseLeave) canvas.removeEventListener("pointerleave", onMouseLeave);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas = null;
        ctx = null;
      }
      onMouseLeave = null;
      if (glassContainer) {
        glassContainer.remove();
        glassContainer = null;
        glassLabels = [];
      }
      removeSettings();
      fnodes = [];
      fedges = [];
      clusters = [];
      entityNodeMap = new Map();
      glowTimestamps = new Map();
      pulseWaveFields.clear();
      centroidCache = null;
      labelMetricsCache.clear();
      clearColorCaches();
      resetAutomationState();
      automationLoading = false;
      onAutomationLoaded = null;
      resetReveals();
      collapsedNodes.clear();
      stateChangeCounts.clear();
      allTreeNodesById = new Map();
      allEntityTreeNodes = new Map();
      dismissContextMenu();
      setIconResolveCallback(null);
      dragNode = null;
      panning = false;
    },

    updateStates(states: Map<string, HaState>) {
      currentStates = states;
    },

    onEntityChanged(entityId: string, oldValue?: string) {
      stateChangeCounts.set(entityId, (stateChangeCounts.get(entityId) ?? 0) + 1);

      if (settings.appearOnChange && allEntityTreeNodes.has(entityId)) {
        if (!settings.automationOnly || automationEdgesByEntity.has(entityId)) {
          revealAncestorChain(entityId);
        }
      }

      if (settings.changedOnly && oldValue !== undefined) {
        const current = currentStates.get(entityId);
        if (current && current.state === oldValue) return;
      }
      const fn = entityNodeMap.get(entityId);
      if (fn) {
        glowTimestamps.set(fn, performance.now());
        ensureLoop();
      }
    },
  };
}

function buildCurrentTree(): TreeNode {
  return settings.structureMode === "device"
    ? buildTreeByDevice(currentRegistries!)
    : buildTree(currentRegistries!);
}

function rebuildGraph(): void {
  if (!currentRegistries || !canvas) return;
  alpha = 1;
  buildGraph(buildCurrentTree());
  ensureLoop();
}

function rebuildWithStructure(): void {
  rebuildGraph();
  resetAutomationState();
  if (settings.showAutomationEdges || settings.automationOnly) loadAutomationEdges();
}

function resetAutomationState(): void {
  automationEdges = [];
  automationEdgesByEntity = new Map();
  automationLoaded = false;
}

function clearColorCaches(): void {
  spriteCache.clear();
  glowSpriteCache.clear();
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const REVEAL_STAGGER_MS = 120;

function resetReveals(): void {
  revealedNodes.clear();
  pendingReveals = [];
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
}

function revealAncestorChain(entityId: string): void {
  const treeNode = allEntityTreeNodes.get(entityId);
  if (!treeNode) return;

  // Walk up from entity to root, collect ancestors that aren't yet revealed
  const chain: TreeNode[] = [];
  let cur: TreeNode | null = treeNode;
  while (cur && cur.kind !== "root") {
    if (!revealedNodes.has(cur.id)) chain.push(cur);
    cur = cur.parent;
  }

  if (chain.length === 0) return;

  // Reverse so ancestors come first: area -> domain/device -> entity
  chain.reverse();

  // Queue nodes that aren't already pending
  const queued = new Set(pendingReveals);
  for (const node of chain) {
    if (queued.has(node.id)) continue;
    pendingReveals.push(node.id);
    queued.add(node.id);
  }

  if (!revealTimer) processNextReveal();
}

function processNextReveal(): void {
  if (pendingReveals.length === 0) {
    revealTimer = null;
    return;
  }

  const nextId = pendingReveals.shift()!;

  if (revealedNodes.has(nextId)) {
    processNextReveal();
    return;
  }

  revealedNodes.add(nextId);
  insertRevealedNode(nextId);

  if (pendingReveals.length > 0) {
    revealTimer = setTimeout(processNextReveal, REVEAL_STAGGER_MS);
  } else {
    revealTimer = null;
  }
}

function insertRevealedNode(nodeId: string, skipGlow = false): void {
  const treeNode = allTreeNodesById.get(nodeId);
  if (!treeNode) return;

  // Already in the graph
  if (treeNode.entityId && entityNodeMap.has(treeNode.entityId)) return;
  for (const existing of fnodes) {
    if (existing.tree === treeNode) return;
  }

  const fn = createFNode(treeNode, 0, 0);

  // Position near parent if it exists in the graph
  if (treeNode.parent) {
    for (const existing of fnodes) {
      if (existing.tree === treeNode.parent) {
        fn.x = existing.x + (Math.random() - 0.5) * 30;
        fn.y = existing.y + (Math.random() - 0.5) * 30;
        parentFNode.set(fn, existing);
        fedges.push({ source: existing, target: fn });
        const children = childFNodes.get(existing);
        if (children) children.push(fn);
        break;
      }
    }
  }

  if (fn.x === 0 && fn.y === 0) {
    fn.x = width / 2 + (Math.random() - 0.5) * 100;
    fn.y = height / 2 + (Math.random() - 0.5) * 100;
  }

  fnodes.push(fn);
  childFNodes.set(fn, []);
  if (treeNode.entityId) entityNodeMap.set(treeNode.entityId, fn);
  pulseWaveFields.clear();

  if (!skipGlow) glowTimestamps.set(fn, performance.now());
  alpha = Math.max(alpha, 0.3);
  ensureLoop();
}

function isCollapsible(node: TreeNode): boolean {
  return (node.kind === "device" || node.kind === "area") && node.children.length > 0;
}

function toggleCollapse(fnode: FNode): void {
  const node = fnode.tree;
  if (!isCollapsible(node)) return;

  const isCollapsed = collapsedNodes.has(node.id);
  if (isCollapsed) {
    collapsedNodes.delete(node.id);
    // Re-insert direct children (recursively inserts their children too,
    // unless those are themselves collapsed)
    const queue = [...node.children];
    while (queue.length > 0) {
      const child = queue.shift()!;
      insertRevealedNode(child.id, true);
      if (!collapsedNodes.has(child.id)) {
        queue.push(...child.children);
      }
    }
  } else {
    collapsedNodes.add(node.id);
    const toRemove = new Set<FNode>();
    function collectDescendants(fn: FNode): void {
      const children = childFNodes.get(fn);
      if (!children) return;
      for (const child of children) {
        toRemove.add(child);
        collectDescendants(child);
      }
    }
    collectDescendants(fnode);

    for (const fn of toRemove) {
      if (fn.tree.entityId) entityNodeMap.delete(fn.tree.entityId);
      childFNodes.delete(fn);
      parentFNode.delete(fn);
    }
    fnodes = fnodes.filter((fn) => !toRemove.has(fn));
    fedges = fedges.filter((e) => !toRemove.has(e.source) && !toRemove.has(e.target));
    childFNodes.set(fnode, []);
    for (const fn of toRemove) glowTimestamps.delete(fn);
  }

  pulseWaveFields.clear();
  alpha = Math.max(alpha, 0.3);
  ensureLoop();
}

function reheat(): void {
  alpha = Math.max(alpha, 0.5);
  ensureLoop();
}

interface Section {
  el: HTMLDivElement;
  body: HTMLDivElement;
}

function makeSection(label: string, startOpen = true): Section {
  const section = document.createElement("div");
  section.className = "force-section";

  const header = document.createElement("button");
  header.className = "force-section-header";
  header.type = "button";

  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("viewBox", "0 0 10 10");
  arrow.setAttribute("class", "force-section-arrow");
  if (startOpen) arrow.classList.add("open");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 2l4 3-4 3z");
  path.setAttribute("fill", "currentColor");
  arrow.appendChild(path);
  header.appendChild(arrow);
  header.appendChild(document.createTextNode(label));

  const body = document.createElement("div");
  body.className = "force-section-body";
  if (!startOpen) body.hidden = true;

  header.addEventListener("click", () => {
    body.hidden = !body.hidden;
    arrow.classList.toggle("open", !body.hidden);
  });

  section.appendChild(header);
  section.appendChild(body);
  return { el: section, body };
}

function removeSettings(): void {
  if (settingsPanel) {
    settingsPanel.toolbar.remove();
    settingsPanel = null;
  }
}

interface SettingsControls {
  entitiesToggle: HTMLLabelElement;
  unavailableSelect: HTMLLabelElement;
  changedOnlyToggle: HTMLLabelElement;
  appearOnChangeToggle: HTMLLabelElement;
  autoOnlyToggle: HTMLLabelElement;
}

interface SettingsContext {
  container: HTMLElement;
  searchInput: HTMLInputElement;
  // Filled in by the section builders; read only from event handlers after createSettings returns.
  controls: SettingsControls;
  syncColorSwatches: () => void;
}

function setDisabled(el: HTMLElement, disabled: boolean): void {
  el.style.opacity = disabled ? "0.4" : "";
  const input = el.querySelector("input");
  const select = el.querySelector("select");
  if (input) input.disabled = disabled;
  if (select) select.disabled = disabled;
}

function syncSettingsState(controls: SettingsControls): void {
  const entitiesOff = !settings.showEntities;
  const aocOn = settings.appearOnChange;
  setDisabled(controls.entitiesToggle, aocOn);
  setDisabled(controls.unavailableSelect, entitiesOff || aocOn);
  setDisabled(controls.changedOnlyToggle, entitiesOff);
  setDisabled(controls.appearOnChangeToggle, entitiesOff);
  setDisabled(controls.autoOnlyToggle, entitiesOff || !automationLoaded || !settings.showAutomationEdges);
}

function createSettings(container: HTMLElement): { toolbar: HTMLDivElement } {
  const { toolbar, searchInput, settingsDropdown, filterDropdown } = buildToolbar(container);
  const [viewTab, styleTab, advancedTab] = buildTabs(settingsDropdown, [t("View"), t("Style"), t("Advanced")]);

  const context: SettingsContext = {
    container,
    searchInput,
    controls: {} as SettingsControls,
    syncColorSwatches: () => {},
  };

  buildViewTab(viewTab, context);
  buildFilterPanel(filterDropdown);
  buildStyleTab(styleTab, context);
  syncSettingsState(context.controls);
  buildAdvancedTab(advancedTab, context);

  return { toolbar };
}

function buildToolbar(container: HTMLElement): {
  toolbar: HTMLDivElement;
  searchInput: HTMLInputElement;
  settingsDropdown: HTMLDivElement;
  filterDropdown: HTMLDivElement;
} {
  const toolbar = document.createElement("div");
  toolbar.className = "canvas-toolbar";
  container.appendChild(toolbar);

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "canvas-toolbar-search";
  searchInput.placeholder = t("Search entities...");
  searchInput.value = searchQuery;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase();
    if (settings.searchAsFilter) {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => rebuildGraph(), 150);
    } else {
      ensureLoop();
    }
  });
  toolbar.appendChild(searchInput);

  const filterBtn = document.createElement("button");
  filterBtn.className = "canvas-toolbar-btn";
  filterBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 2.5A.5.5 0 0 1 1.5 2h13a.5.5 0 0 1 .4.8L10 9v4.5a.5.5 0 0 1-.7.4L7 12.5V9L1.1 2.8A.5.5 0 0 1 1 2.5z"/></svg>';
  filterBtn.title = t("Filters");
  toolbar.appendChild(filterBtn);

  const resetPosBtn = document.createElement("button");
  resetPosBtn.className = "canvas-toolbar-btn";
  resetPosBtn.textContent = "\u21bb";
  resetPosBtn.title = t("Reset positions");
  resetPosBtn.addEventListener("click", () => rebuildGraph());
  toolbar.appendChild(resetPosBtn);

  // The escape hatch for a lost view: the layout can settle outside the
  // viewport, and neither Reset positions nor a zoom limit gets it back.
  const fitBtn = document.createElement("button");
  fitBtn.className = "canvas-toolbar-btn";
  fitBtn.title = t("Fit view to graph");
  fitBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5.5v-4h4"/><path d="M14.5 5.5v-4h-4"/><path d="M1.5 10.5v4h4"/><path d="M14.5 10.5v4h-4"/></svg>';
  fitBtn.addEventListener("click", () => fitAll());
  toolbar.appendChild(fitBtn);

  const gearBtn = document.createElement("button");
  gearBtn.className = "canvas-toolbar-btn";
  gearBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="1" y="2.5" width="14" height="1.5" rx="0.75"/><rect x="1" y="7.25" width="14" height="1.5" rx="0.75"/><rect x="1" y="12" width="14" height="1.5" rx="0.75"/><circle cx="5" cy="3.25" r="2" fill="var(--surface)" stroke="currentColor" stroke-width="1.2"/><circle cx="11" cy="8" r="2" fill="var(--surface)" stroke="currentColor" stroke-width="1.2"/><circle cx="6.5" cy="12.75" r="2" fill="var(--surface)" stroke="currentColor" stroke-width="1.2"/></svg>';
  gearBtn.title = t("Settings");
  toolbar.appendChild(gearBtn);

  const settingsDropdown = document.createElement("div");
  settingsDropdown.className = "settings-panel";
  toolbar.appendChild(settingsDropdown);

  const filterDropdown = document.createElement("div");
  filterDropdown.className = "settings-panel filter-panel-dropdown";
  toolbar.appendChild(filterDropdown);

  gearBtn.addEventListener("click", () => {
    const opening = !settingsDropdown.classList.contains("open");
    filterDropdown.classList.remove("open");
    filterBtn.classList.remove("active");
    settingsDropdown.classList.toggle("open", opening);
    gearBtn.classList.toggle("active", opening);
  });

  filterBtn.addEventListener("click", () => {
    const opening = !filterDropdown.classList.contains("open");
    settingsDropdown.classList.remove("open");
    gearBtn.classList.remove("active");
    filterDropdown.classList.toggle("open", opening);
    filterBtn.classList.toggle("active", opening);
  });

  return { toolbar, searchInput, settingsDropdown, filterDropdown };
}

function buildTabs(parent: HTMLDivElement, names: string[]): HTMLDivElement[] {
  const tabBar = document.createElement("div");
  tabBar.className = "settings-tabs";
  const tabBtns: HTMLButtonElement[] = [];
  const tabPanels: HTMLDivElement[] = [];

  for (const name of names) {
    const btn = document.createElement("button");
    btn.className = "settings-tab";
    btn.textContent = name;
    btn.type = "button";
    tabBar.appendChild(btn);
    tabBtns.push(btn);
  }
  parent.appendChild(tabBar);

  const body = document.createElement("div");
  body.className = "settings-body";
  parent.appendChild(body);

  for (let i = 0; i < names.length; i++) {
    const tabContent = document.createElement("div");
    tabContent.className = "settings-tab-content";
    body.appendChild(tabContent);
    tabPanels.push(tabContent);
  }

  function activateTab(index: number): void {
    for (let i = 0; i < tabBtns.length; i++) {
      tabBtns[i].classList.toggle("active", i === index);
      tabPanels[i].classList.toggle("active", i === index);
    }
  }

  for (let i = 0; i < tabBtns.length; i++) {
    tabBtns[i].addEventListener("click", () => activateTab(i));
  }
  activateTab(0);

  return tabPanels;
}

function makeSubOptions(hidden: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "force-sub-options";
  el.hidden = hidden;
  return el;
}

function buildViewTab(tab: HTMLDivElement, context: SettingsContext): void {
  const controls = context.controls;

  tab.appendChild(makeSegmented(t("Structure"), ["domain", "device"], settings.structureMode, (v) => {
    settings.structureMode = v as StructureMode;
    rebuildWithStructure();
    saveSettings();
  }));

  tab.appendChild(makeSegmented(t("Layout"), ["tree", "scatter"], settings.initialLayout, (v) => {
    settings.initialLayout = v as InitialLayout;
    rebuildGraph();
    saveSettings();
  }, t("Initial node positions: tree (structured) or scatter (random)")));

  const styleGroup = document.createElement("div");
  styleGroup.className = "visual-mode-group";
  const constellationSubOptions = makeSubOptions(!settings.constellation);

  styleGroup.appendChild(makeSegmented(t("Style"), ["dots", "stars"], settings.constellation ? "stars" : "dots", (v) => {
    settings.constellation = v === "stars";
    constellationSubOptions.hidden = !settings.constellation;
    saveSettings();
  }, t("Render nodes as plain dots or glowing stars")));
  styleGroup.appendChild(constellationSubOptions);
  tab.appendChild(styleGroup);

  const visualModeGroup = document.createElement("div");
  visualModeGroup.className = "visual-mode-group";

  const currentVisualMode = settings.showAutomationEdges ? "automations" : settings.showHulls ? "hulls" : "default";
  const visualModes = ["default", "hulls", "automations"] as const;

  const hullSubOptions = makeSubOptions(currentVisualMode !== "hulls");
  const automationSubOptions = makeSubOptions(currentVisualMode !== "automations");

  function applyVisualMode(mode: string): void {
    settings.showHulls = mode === "hulls";
    settings.showAutomationEdges = mode === "automations";
    hullSubOptions.hidden = mode !== "hulls";
    automationSubOptions.hidden = mode !== "automations";
    if (mode === "automations" && !automationLoaded && !automationLoading) loadAutomationEdges();
    if (mode !== "automations" && settings.automationOnly) {
      settings.automationOnly = false;
      controls.autoOnlyToggle.querySelector("input")!.checked = false;
      rebuildGraph();
    }
    syncSettingsState(controls);
    ensureLoop();
    saveSettings();
  }

  for (const mode of visualModes) {
    const label = document.createElement("label");
    label.className = "visual-mode-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "visual-mode";
    radio.value = mode;
    radio.checked = mode === currentVisualMode;
    radio.addEventListener("change", () => applyVisualMode(mode));
    label.appendChild(radio);
    label.appendChild(document.createTextNode(optionLabel(mode)));
    visualModeGroup.appendChild(label);

    if (mode === "hulls") visualModeGroup.appendChild(hullSubOptions);
    if (mode === "automations") visualModeGroup.appendChild(automationSubOptions);
  }

  constellationSubOptions.appendChild(makeSlider(t("Brightness"), 0, 3, settings.glowBrightness, 0.1, (v) => { settings.glowBrightness = v; saveSettings(); }, t("Overall star and edge opacity")));
  constellationSubOptions.appendChild(makeSlider(t("Star size"), 0.2, 3, settings.starSize, 0.1, (v) => { settings.starSize = v; saveSettings(); }));
  constellationSubOptions.appendChild(makeSlider(t("Halo intensity"), 0.2, 3, settings.glowIntensity, 0.1, (v) => { settings.glowIntensity = v; saveSettings(); }, t("Glow gradient spread and strength")));
  constellationSubOptions.appendChild(makeSlider(t("Halo size"), 2, 16, settings.glowSize, 0.5, (v) => { settings.glowSize = v; saveSettings(); }, t("Base glow radius around stars")));
  constellationSubOptions.appendChild(makeSlider(t("Parent halo"), 0.2, 5, settings.parentGlowIntensity, 0.1, (v) => { settings.parentGlowIntensity = v; saveSettings(); }, t("Halo for area, domain, and device nodes")));
  constellationSubOptions.appendChild(makeSlider(t("Effect scale"), 0.5, 5, settings.effectScale, 0.1, (v) => { settings.effectScale = v; saveSettings(); }, t("Size of state-change effects")));
  constellationSubOptions.appendChild(makeSlider(t("Twinkle speed"), 0, 5, settings.twinkleSpeed, 0.1, (v) => { settings.twinkleSpeed = v; saveSettings(); }));
  constellationSubOptions.appendChild(makeSlider(t("Twinkle size"), 0, 1, settings.twinkleSize, 0.05, (v) => { settings.twinkleSize = v; saveSettings(); }, t("Halo radius pulsing with twinkle")));
  constellationSubOptions.appendChild(makeSlider(t("Twinkle floor"), 0, 1, settings.twinkleMin, 0.05, (v) => { settings.twinkleMin = v; saveSettings(); }, t("Minimum brightness during twinkle dip")));
  constellationSubOptions.appendChild(makeSlider(t("Halo spread"), 0, 1, settings.haloFalloff, 0.05, (v) => { settings.haloFalloff = v; saveSettings(); }, t("Gaussian halo width: low = tight bright peak, high = broad soft glow")));
  constellationSubOptions.appendChild(makeSelect(t("Effect"),
    ["supernova", "shooting-star", "flare", "pulse-wave", "color-shift"],
    settings.starEffect, (v) => { settings.starEffect = v as StarEffect; saveSettings(); }, t("Animation on entity state change")));

  hullSubOptions.appendChild(makeSegmented(t("Grouping"), ["area", "domain"], settings.groupBy, (v) => {
    settings.groupBy = v as GroupMode;
    rebuildClusters();
    saveSettings();
  }));

  controls.autoOnlyToggle = makeToggle(t("Automation entities only"), settings.automationOnly, (v) => {
    settings.automationOnly = v;
    saveSettings();
    if (v && !automationLoaded && !automationLoading) {
      loadAutomationEdges();
    } else {
      rebuildGraph();
    }
  }, t("Hide entities not referenced by any automation"));
  automationSubOptions.appendChild(controls.autoOnlyToggle);

  onAutomationLoaded = () => {
    syncSettingsState(controls);
    if (settings.automationOnly) rebuildGraph();
  };

  tab.appendChild(visualModeGroup);

  const entitiesSubOptions = makeSubOptions(!settings.showEntities);

  controls.entitiesToggle = makeToggle(t("Entities"), settings.showEntities, (v) => {
    settings.showEntities = v;
    entitiesSubOptions.hidden = !v;
    if (!v) {
      if (settings.appearOnChange) {
        settings.appearOnChange = false;
        controls.appearOnChangeToggle.querySelector("input")!.checked = false;
        resetReveals();
      }
      if (settings.automationOnly) {
        settings.automationOnly = false;
        controls.autoOnlyToggle.querySelector("input")!.checked = false;
      }
    }
    syncSettingsState(controls);
    rebuildGraph();
    saveSettings();
  });
  tab.appendChild(controls.entitiesToggle);

  controls.unavailableSelect = makeSelect(t("Unavailable"), ["normal", "pulse", "ring", "hidden", "only"], settings.unavailableMode, (v) => {
    const prev = settings.unavailableMode;
    settings.unavailableMode = v as UnavailableMode;
    if (v === "hidden" || prev === "hidden" || v === "only" || prev === "only") rebuildGraph();
    ensureLoop();
    saveSettings();
  });
  entitiesSubOptions.appendChild(controls.unavailableSelect);

  controls.appearOnChangeToggle = makeToggle(t("Appear on change"), settings.appearOnChange, (v) => {
    settings.appearOnChange = v;
    if (v) {
      settings.showEntities = true;
      controls.entitiesToggle.querySelector("input")!.checked = true;
    } else {
      resetReveals();
    }
    syncSettingsState(controls);
    rebuildGraph();
    saveSettings();
  }, t("Nodes start hidden and appear as state changes arrive"));
  entitiesSubOptions.appendChild(controls.appearOnChangeToggle);
  tab.appendChild(entitiesSubOptions);
}

function buildFilterPanel(dropdown: HTMLDivElement): void {
  const filterBody = document.createElement("div");
  filterBody.className = "settings-body";
  dropdown.appendChild(filterBody);

  filterBody.appendChild(makeToggle(t("Search hides non-matching"), settings.searchAsFilter, (v) => {
    settings.searchAsFilter = v;
    saveSettings();
    if (searchQuery) rebuildGraph();
  }, t("When enabled, the search bar hides nodes instead of highlighting them")));

  const domains = domainList();
  filterBody.appendChild(makeFilterSection(
    t("Domains"),
    // Sort by the rendered label so the Chinese list is in pinyin order, but
    // keep `id` as the raw domain - that is what hiddenDomains stores.
    domains
      .map((d) => ({ id: d, label: domainLabel(d) }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    () => settings.hiddenDomains,
    (ids) => { settings.hiddenDomains = ids; },
  ));

  const areas = buildCurrentTree().children
    .filter((c) => c.kind === "area")
    .sort((a, b) => a.label.localeCompare(b.label));
  filterBody.appendChild(makeFilterSection(
    t("Areas"),
    areas.map((a) => ({ id: a.id.replace(/^area:/, ""), label: a.label })),
    () => settings.hiddenAreas,
    (ids) => { settings.hiddenAreas = ids; },
  ));

  const stateSection = makeSection(t("State"));

  const stateInputWrap = document.createElement("div");
  stateInputWrap.style.cssText = "position:relative";
  const stateInput = document.createElement("input");
  stateInput.type = "text";
  stateInput.className = "force-search";
  stateInput.placeholder = t("Filter by state (e.g. on, off)");
  stateInput.value = settings.stateFilter;
  const stateClearBtn = document.createElement("button");
  stateClearBtn.textContent = "\u00d7";
  stateClearBtn.style.cssText = "position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;padding:0 4px;display:" + (settings.stateFilter ? "block" : "none");
  stateClearBtn.addEventListener("click", () => {
    settings.stateFilter = "";
    stateInput.value = "";
    stateClearBtn.style.display = "none";
    saveSettings();
    rebuildGraph();
  });
  let stateDebounce: ReturnType<typeof setTimeout> | null = null;
  stateInput.addEventListener("input", () => {
    settings.stateFilter = stateInput.value.trim();
    stateClearBtn.style.display = settings.stateFilter ? "block" : "none";
    if (stateDebounce) clearTimeout(stateDebounce);
    stateDebounce = setTimeout(() => {
      saveSettings();
      rebuildGraph();
    }, 150);
  });
  stateInputWrap.appendChild(stateInput);
  stateInputWrap.appendChild(stateClearBtn);
  stateSection.body.appendChild(stateInputWrap);
  filterBody.appendChild(stateSection.el);
}

function makeFilterSection(
  title: string,
  items: { id: string; label: string }[],
  getHidden: () => string[],
  setHidden: (ids: string[]) => void,
): HTMLDivElement {
  const section = makeSection(title);

  const actions = document.createElement("div");
  actions.className = "filter-actions";
  const allBtn = document.createElement("button");
  allBtn.className = "force-reset-btn";
  allBtn.textContent = t("All");
  allBtn.style.cssText = "flex:1;padding:0.2rem 0";
  const noneBtn = document.createElement("button");
  noneBtn.className = "force-reset-btn";
  noneBtn.textContent = t("None");
  noneBtn.style.cssText = "flex:1;padding:0.2rem 0";
  actions.appendChild(allBtn);
  actions.appendChild(noneBtn);
  section.body.appendChild(actions);

  const grid = document.createElement("div");
  grid.className = "filter-grid";
  section.body.appendChild(grid);

  const checkboxes: HTMLInputElement[] = [];
  for (const { id, label } of items) {
    const item = document.createElement("label");
    item.className = "filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !getHidden().includes(id);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        setHidden(getHidden().filter((x) => x !== id));
      } else {
        setHidden([...getHidden(), id]);
      }
      saveSettings();
      rebuildGraph();
    });
    const text = document.createElement("span");
    text.className = "filter-domain";
    text.textContent = label;
    item.appendChild(cb);
    item.appendChild(text);
    grid.appendChild(item);
    checkboxes.push(cb);
  }

  allBtn.addEventListener("click", () => {
    setHidden([]);
    for (const cb of checkboxes) cb.checked = true;
    saveSettings();
    rebuildGraph();
  });
  noneBtn.addEventListener("click", () => {
    setHidden(items.map((i) => i.id));
    for (const cb of checkboxes) cb.checked = false;
    saveSettings();
    rebuildGraph();
  });

  return section.el;
}

function buildStyleTab(tab: HTMLDivElement, context: SettingsContext): void {
  tab.appendChild(makeToggle(t("Labels"), settings.showLabels, (v) => { settings.showLabels = v; saveSettings(); }));
  tab.appendChild(makeToggle(
    t("Structure labels"),
    settings.showStructureLabels,
    (v) => { settings.showStructureLabels = v; saveSettings(); },
    t("Show labels on grouping nodes (domains in domain mode, devices in device mode)")
  ));
  tab.appendChild(makeToggle(
    t("Entity icons"),
    settings.showIcons,
    (v) => { settings.showIcons = v; saveSettings(); },
    t("Render Material Design Icons on entity nodes (resolved from Home Assistant)")
  ));
  context.controls.changedOnlyToggle = makeToggle(t("Skip unchanged"), settings.changedOnly, (v) => {
    settings.changedOnly = v;
    saveSettings();
  }, t("Skip glow when state value hasn't changed"));
  tab.appendChild(context.controls.changedOnlyToggle);

  tab.appendChild(makeSlider(t("Label size"), 4, 24, settings.labelSize, 1, (v) => { settings.labelSize = v; saveSettings(); }));
  tab.appendChild(makeSlider(t("Entity label zoom"), 0.5, 5, settings.entityLabelZoom, 0.1, (v) => { settings.entityLabelZoom = v; saveSettings(); }, t("Zoom level to show entity labels")));
  tab.appendChild(makeSlider(t("Entity dot size"), 1, 16, settings.entityDotSize, 0.5, (v) => {
    settings.entityDotSize = v;
    for (const fn of fnodes) {
      if (fn.tree.kind === "entity") fn.r = v;
    }
    saveSettings();
  }));
  tab.appendChild(makeSlider(t("Connection brightness"), 0, 3, settings.lineGlow, 0.1, (v) => { settings.lineGlow = v; saveSettings(); }, t("Opacity of parent-child connection lines")));

  const colorsSection = makeSection(t("Colors"));

  const bgSwatch = document.createElement("label");
  bgSwatch.className = "force-color-swatch";
  bgSwatch.title = t("Background");
  const bgDot = document.createElement("span");
  bgDot.className = "force-color-dot";
  bgDot.style.background = settings.backgroundColor;
  const bgInput = document.createElement("input");
  bgInput.type = "color";
  bgInput.value = settings.backgroundColor;
  bgInput.addEventListener("input", () => {
    settings.backgroundColor = bgInput.value;
    bgDot.style.background = bgInput.value;
    saveSettings();
    ensureLoop();
  });
  const bgName = document.createElement("span");
  bgName.className = "force-color-name";
  bgName.textContent = t("background");
  bgSwatch.appendChild(bgDot);
  bgSwatch.appendChild(bgName);
  bgSwatch.appendChild(bgInput);
  colorsSection.body.appendChild(bgSwatch);

  const colorGrid = document.createElement("div");
  colorGrid.className = "force-color-grid";
  for (const domain of domainList().sort((a, b) => domainLabel(a).localeCompare(domainLabel(b), "zh-CN"))) {
    const swatch = document.createElement("label");
    swatch.className = "force-color-swatch";
    // The raw domain is the colour-map key, so it must not live in `title`
    // any more - that is now the human-readable tooltip.
    swatch.dataset.domain = domain;
    swatch.title = domainTitle(domain);

    const dot = document.createElement("span");
    dot.className = "force-color-dot";
    dot.style.background = getDomainColors()[domain];

    const input = document.createElement("input");
    input.type = "color";
    input.value = getDomainColors()[domain];
    input.addEventListener("input", () => {
      dot.style.background = input.value;
      setDomainColor(domain, input.value);
      clearColorCaches();
      ensureLoop();
    });

    const name = document.createElement("span");
    name.className = "force-color-name";
    name.textContent = domainLabel(domain);

    swatch.appendChild(dot);
    swatch.appendChild(name);
    swatch.appendChild(input);
    colorGrid.appendChild(swatch);
  }
  colorsSection.body.appendChild(colorGrid);

  context.syncColorSwatches = () => {
    const colors = getDomainColors();
    for (const swatch of colorGrid.children) {
      const el = swatch as HTMLLabelElement;
      const d = el.dataset.domain ?? "";
      const dot = el.querySelector(".force-color-dot") as HTMLSpanElement;
      const inp = el.querySelector("input") as HTMLInputElement;
      if (dot && inp && d in colors) {
        dot.style.background = colors[d];
        inp.value = colors[d];
      }
    }
  };

  tab.appendChild(colorsSection.el);
}

function buildAdvancedTab(tab: HTMLDivElement, context: SettingsContext): void {
  const { container } = context;

  const physicsSection = makeSection(t("Physics"));
  physicsSection.body.appendChild(makeSlider(t("Repulsion"), 100, 3000, settings.repulsion, 10, (v) => { settings.repulsion = v; reheat(); saveSettings(); }));
  physicsSection.body.appendChild(makeSlider(t("Spring length"), 10, 120, settings.springLen, 1, (v) => { settings.springLen = v; reheat(); saveSettings(); }));
  physicsSection.body.appendChild(makeSlider(t("Spring stiffness"), 0.005, 0.15, settings.springK, 0.005, (v) => { settings.springK = v; reheat(); saveSettings(); }, t("Pull strength between connected nodes")));
  physicsSection.body.appendChild(makeSlider(t("Damping"), 0.5, 0.99, settings.damping, 0.01, (v) => { settings.damping = v; reheat(); saveSettings(); }, t("Velocity decay per frame")));
  tab.appendChild(physicsSection.el);

  const buttons = document.createElement("div");
  buttons.className = "force-buttons";

  const randomColorBtn = document.createElement("button");
  randomColorBtn.className = "force-reset-btn";
  randomColorBtn.textContent = t("Randomize colors");
  randomColorBtn.addEventListener("click", () => {
    randomizeColors();
    clearColorCaches();
    context.syncColorSwatches();
    ensureLoop();
  });
  buttons.appendChild(randomColorBtn);

  const resetAllBtn = document.createElement("button");
  resetAllBtn.className = "force-reset-btn";
  resetAllBtn.textContent = t("Reset all settings");
  resetAllBtn.addEventListener("click", () => {
    resetColors();
    clearColorCaches();
    applySettings({});
    resetReveals();
    collapsedNodes.clear();
    stateChangeCounts.clear();
    searchQuery = "";
    context.searchInput.value = "";
    resetAutomationState();
    automationLoading = false;
    transform = createTransform();
    saveSettings();
    removeSettings();
    settingsPanel = createSettings(container);
    rebuildWithStructure();
  });
  buttons.appendChild(resetAllBtn);

  const exportBtn = document.createElement("button");
  exportBtn.className = "force-reset-btn";
  exportBtn.textContent = t("Export settings");
  exportBtn.addEventListener("click", () => {
    const data = { settings, colors: getDomainColors() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hypertree-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast(t("Settings exported"));
  });
  buttons.appendChild(exportBtn);

  const importBtn = document.createElement("button");
  importBtn.className = "force-reset-btn";
  importBtn.textContent = t("Import settings");
  importBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          const data = JSON.parse(text);
          if (data.settings) applySettings(data.settings);
          if (data.colors) setDomainColors(data.colors);
          clearColorCaches();
          removeSettings();
          settingsPanel = createSettings(container);
          rebuildWithStructure();
          showToast(t("Settings imported"));
        } catch {
          showToast(t("Invalid settings file"));
        }
      });
    });
    input.click();
  });
  buttons.appendChild(importBtn);

  tab.appendChild(buttons);

  if (reconnectCallback) tab.appendChild(buildConnectionSection());
}

function buildConnectionSection(): HTMLDivElement {
  const connectionSection = makeSection(t("Connection"));
  const savedCreds = loadCredentials();

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.className = "force-search";
  urlInput.placeholder = "https://homeassistant.local:8123";
  urlInput.value = savedCreds?.url ?? "";
  connectionSection.body.appendChild(urlInput);

  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.className = "force-search";
  tokenInput.placeholder = t("Long-lived access token");
  tokenInput.value = savedCreds?.token ?? "";
  connectionSection.body.appendChild(tokenInput);

  const reconnectBtn = document.createElement("button");
  reconnectBtn.className = "force-reset-btn";
  reconnectBtn.textContent = t("Reconnect");
  reconnectBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    if (!url || !token) return;
    saveCredentials({ url, token });
    reconnectCallback!({ url, token });
  });
  connectionSection.body.appendChild(reconnectBtn);

  return connectionSection.el;
}

function makeToggle(label: string, initial: boolean, onChange: (v: boolean) => void, tooltip?: string): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "toggle-label";
  if (tooltip) el.title = tooltip;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = initial;
  input.addEventListener("change", () => { onChange(input.checked); ensureLoop(); });
  el.appendChild(input);
  el.appendChild(document.createTextNode(label));
  return el;
}

function makeSelect(label: string, options: string[], initial: string, onChange: (v: string) => void, tooltip?: string): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "toggle-label";
  if (tooltip) el.title = tooltip;
  el.appendChild(document.createTextNode(label));
  const select = document.createElement("select");
  select.className = "force-select";
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = optionLabel(opt);
    if (opt === initial) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => { onChange(select.value); ensureLoop(); });
  el.appendChild(select);
  return el;
}

function makeSegmented(label: string, options: string[], initial: string, onChange: (v: string) => void, tooltip?: string): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "toggle-label";
  if (tooltip) el.title = tooltip;
  el.appendChild(document.createTextNode(label));
  const wrap = document.createElement("div");
  wrap.className = "force-segmented";
  const buttons: HTMLButtonElement[] = [];
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "force-segmented-btn";
    btn.textContent = optionLabel(opt);
    if (opt === initial) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      for (const b of buttons) b.classList.remove("active");
      btn.classList.add("active");
      onChange(opt);
      ensureLoop();
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  el.appendChild(wrap);
  return el;
}

function makeSlider(
  label: string, min: number, max: number, initial: number, step: number,
  onChange: (v: number) => void, tooltip?: string,
): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "force-slider-label";
  if (tooltip) el.title = tooltip;
  const nameSpan = document.createElement("span");
  nameSpan.textContent = label;
  const valueSpan = document.createElement("span");
  valueSpan.className = "force-slider-value";
  valueSpan.textContent = String(initial);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initial);
  input.className = "force-slider";
  input.addEventListener("input", () => {
    const v = Number(input.value);
    valueSpan.textContent = step < 0.1 ? v.toFixed(3) : String(v);
    onChange(v);
    ensureLoop();
  });
  el.append(nameSpan, input, valueSpan);
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

    if (settings.groupBy === "area") {
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

  nodeCluster = new Map();
  for (const cluster of clusters) {
    for (const fn of cluster.nodes) {
      nodeCluster.set(fn, cluster);
    }
  }
}

const AUTOMATION_COLORS: Record<AutomationRelation, string> = {
  trigger: "#7e57c2",
  condition: "#ffca28",
  action: "#42a5f5",
};

const AUTOMATION_DASHES: Record<AutomationRelation, number[]> = {
  trigger: [],
  condition: [6, 4],
  action: [2, 3],
};

async function loadAutomationEdges(): Promise<void> {
  if (!haConnection || automationLoading) return;
  automationLoading = true;

  const automationEntityIds: string[] = [];
  for (const id of allEntityTreeNodes.keys()) {
    if (id.startsWith("automation.")) automationEntityIds.push(id);
  }

  debugLog(t("system"), t("Automation: found {n} automation entities in registry", { n: automationEntityIds.length }));

  const knownEntityIds = new Set(allEntityTreeNodes.keys());

  try {
    automationEdges = await fetchAutomationEdges(haConnection, automationEntityIds, knownEntityIds);
    debugLog(t("system"), t("Automation: fetched {n} edges", { n: automationEdges.length }));
  } catch (err) {
    debugLog(t("system"), t("Automation: fetch failed"), String(err));
    automationEdges = [];
  }

  automationEdgesByEntity = new Map();
  for (const edge of automationEdges) {
    pushToMap(automationEdgesByEntity, edge.automationEntityId, edge);
    pushToMap(automationEdgesByEntity, edge.targetEntityId, edge);
  }

  automationLoaded = true;
  automationLoading = false;
  if (onAutomationLoaded) onAutomationLoaded();
  ensureLoop();
}

function drawAutomationEdges(drawCtx: CanvasRenderingContext2D): void {
  if (!settings.showAutomationEdges || automationEdges.length === 0) return;

  const invK = 1 / transform.k;
  const hoveredEntityId = hoveredNode?.tree.entityId;
  const hoveredEdges = hoveredEntityId ? automationEdgesByEntity.get(hoveredEntityId) : undefined;
  const hasHoveredEdges = hoveredEdges && hoveredEdges.length > 0;

  // relation x highlight state is a tiny style space; batch segments per style
  // so each frame strokes a handful of paths instead of one per edge.
  const batches = new Map<string, { relation: AutomationRelation; alpha: number; width: number; segments: number[] }>();

  for (const edge of automationEdges) {
    const sourceNode = entityNodeMap.get(edge.automationEntityId);
    const targetNode = entityNodeMap.get(edge.targetEntityId);
    if (!sourceNode || !targetNode) continue;
    if (!segmentInView(sourceNode.x, sourceNode.y, targetNode.x, targetNode.y, 4)) continue;

    const isConnected = hasHoveredEdges && (
      edge.automationEntityId === hoveredEntityId || edge.targetEntityId === hoveredEntityId
    );

    const lineAlpha = hasHoveredEdges ? (isConnected ? 0.85 : 0.15) : 0.5;
    const lineWidth = (hasHoveredEdges && isConnected ? 2.5 : 1.5) * invK;

    const key = `${edge.relation}|${lineAlpha}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { relation: edge.relation, alpha: lineAlpha, width: lineWidth, segments: [] };
      batches.set(key, batch);
    }
    batch.segments.push(sourceNode.x, sourceNode.y, targetNode.x, targetNode.y);
  }

  for (const batch of batches.values()) {
    drawCtx.globalAlpha = batch.alpha;
    drawCtx.strokeStyle = AUTOMATION_COLORS[batch.relation];
    drawCtx.lineWidth = batch.width;
    drawCtx.setLineDash(AUTOMATION_DASHES[batch.relation].map((v) => v * invK));
    drawCtx.beginPath();
    const s = batch.segments;
    for (let i = 0; i < s.length; i += 4) {
      drawCtx.moveTo(s[i], s[i + 1]);
      drawCtx.lineTo(s[i + 2], s[i + 3]);
    }
    drawCtx.stroke();
  }

  drawCtx.setLineDash([]);
  drawCtx.globalAlpha = 1;
}

function getAutomationTooltipHtml(entityId: string): string {
  const edges = automationEdgesByEntity.get(entityId);
  if (!edges || edges.length === 0) return "";

  const isAutomation = entityId.startsWith("automation.");

  if (isAutomation) {
    const byRelation = new Map<AutomationRelation, string[]>();
    for (const edge of edges) {
      if (edge.automationEntityId !== entityId) continue;
      pushToMap(byRelation, edge.relation, edge.targetEntityId);
    }

    if (byRelation.size === 0) return "";

    let html = `<br><span style="color:#9e9e9e;font-size:0.7rem">${t("References:")}</span>`;
    for (const [relation, ids] of byRelation) {
      const colorHex = AUTOMATION_COLORS[relation];
      html += `<br><span style="color:${colorHex};font-size:0.7rem">${optionLabel(relation)}：</span> `;
      html += `<span style="color:#bbb;font-size:0.7rem">${ids.join(", ")}</span>`;
    }
    return html;
  }

  // Target entity: show which automations reference it
  const byAutomation = new Map<string, AutomationRelation[]>();
  for (const edge of edges) {
    if (edge.targetEntityId !== entityId) continue;
    pushToMap(byAutomation, edge.automationEntityId, edge.relation);
  }

  if (byAutomation.size === 0) return "";

  let html = `<br><span style="color:#9e9e9e;font-size:0.7rem">${t("Used by automations:")}</span>`;
  for (const [autoId, relations] of byAutomation) {
    const state = currentStates.get(autoId);
    const name = state?.attributes.friendly_name ?? autoId;
    const relLabels = relations.map((r) =>
      `<span style="color:${AUTOMATION_COLORS[r]}">${optionLabel(r)}</span>`
    ).join(", ");
    html += `<br><span style="font-size:0.7rem">${t("{rel} in {name}", { rel: relLabels, name })}</span>`;
  }
  return html;
}

function pruneEmptyBranches(nodes: TreeNode[]): TreeNode[] {
  const hasDescendant = new Set<TreeNode>();

  for (const n of nodes) {
    if (n.kind === "entity") {
      let cur = n.parent;
      while (cur && !hasDescendant.has(cur)) {
        hasDescendant.add(cur);
        cur = cur.parent;
      }
    }
  }

  return nodes.filter((n) => n.kind === "entity" || n.kind === "root" || hasDescendant.has(n));
}

function filterNodes(allNodes: TreeNode[]): TreeNode[] {
  let nodes: TreeNode[];
  if (!settings.showEntities) {
    nodes = allNodes.filter((n) => n.kind !== "entity");
  } else if (settings.unavailableMode === "hidden") {
    nodes = allNodes.filter((n) => n.kind !== "entity" || !isTreeUnavailable(n));
  } else if (settings.unavailableMode === "only") {
    nodes = allNodes.filter((n) => n.kind !== "entity" || isTreeUnavailable(n));
  } else {
    nodes = allNodes;
  }

  if (settings.appearOnChange) {
    nodes = nodes.filter((n) => {
      if (n.kind === "root") return true;
      return revealedNodes.has(n.id);
    });
  }

  if (settings.automationOnly) {
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity") return true;
      return n.entityId !== undefined && automationEdgesByEntity.has(n.entityId);
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (settings.hiddenDomains.length > 0) {
    const hidden = new Set(settings.hiddenDomains);
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity" || !n.domain) return true;
      return !hidden.has(n.domain);
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (settings.hiddenAreas.length > 0) {
    const hidden = new Set(settings.hiddenAreas.map((a) => `area:${a}`));
    nodes = nodes.filter((n) => {
      if (n.kind === "area") return !hidden.has(n.id);
      let cur = n.parent;
      while (cur) {
        if (cur.kind === "area" && hidden.has(cur.id)) return false;
        cur = cur.parent;
      }
      return true;
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (settings.stateFilter !== "") {
    const filter = settings.stateFilter.toLowerCase();
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity" || !n.entityId) return true;
      const state = currentStates.get(n.entityId);
      return state !== undefined && state.state.toLowerCase() === filter;
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (settings.searchAsFilter && searchQuery) {
    nodes = nodes.filter((n) => n.kind !== "entity" || treeMatchesSearch(n));
    nodes = pruneEmptyBranches(nodes);
  }

  if (collapsedNodes.size > 0) {
    nodes = nodes.filter((n) => {
      let cur = n.parent;
      while (cur) {
        if (collapsedNodes.has(cur.id)) return false;
        cur = cur.parent;
      }
      return true;
    });
  }

  return nodes;
}

function radialLayout(nodes: TreeNode[], cx: number, cy: number): Map<TreeNode, { x: number; y: number }> {
  const positions = new Map<TreeNode, { x: number; y: number }>();
  const nodeSet = new Set(nodes);
  function place(node: TreeNode, x: number, y: number, angleStart: number, angleSpan: number, depth: number): void {
    positions.set(node, { x, y });
    const children = node.children.filter((c) => nodeSet.has(c));
    if (children.length === 0) return;
    const radius = settings.springLen * (depth === 0 ? 1.5 : 1);
    let offset = angleStart;
    const totalLeaves = children.reduce((s, c) => s + Math.max(1, c.leafCount), 0);
    for (const child of children) {
      const share = (Math.max(1, child.leafCount) / totalLeaves) * angleSpan;
      const angle = offset + share / 2;
      place(child, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, offset, share, depth + 1);
      offset += share;
    }
  }
  const rootNode = nodes.find((n) => n.kind === "root");
  if (rootNode) place(rootNode, cx, cy, 0, Math.PI * 2, 0);
  return positions;
}

function createFNode(tree: TreeNode, x: number, y: number): FNode {
  const r = tree.kind === "root" ? 10 : tree.kind === "area" ? 8
    : (tree.kind === "domain" || tree.kind === "device") ? 6 : settings.entityDotSize;
  let hash = 0;
  for (let i = 0; i < tree.id.length; i++) hash = ((hash << 5) - hash + tree.id.charCodeAt(i)) | 0;
  return {
    tree,
    x, y,
    vx: 0, vy: 0,
    fx: null, fy: null,
    r,
    phase: (hash & 0xffff) / 0xffff * Math.PI * 2,
  };
}

function buildGraph(root: TreeNode): void {
  const allNodes = flattenTree(root);

  allTreeNodesById = new Map();
  allEntityTreeNodes = new Map();
  for (const n of allNodes) {
    allTreeNodesById.set(n.id, n);
    if (n.kind === "entity" && n.entityId) {
      allEntityTreeNodes.set(n.entityId, n);
    }
  }

  const nodes = filterNodes(allNodes);

  const map = new Map<TreeNode, FNode>();
  const cx = width / 2 || 400;
  const cy = height / 2 || 300;
  const positions = settings.initialLayout === "tree" ? radialLayout(nodes, cx, cy) : new Map<TreeNode, { x: number; y: number }>();

  fnodes = nodes.map((n) => {
    const pos = positions.get(n);
    const fn = createFNode(
      n,
      pos ? pos.x : cx + (Math.random() - 0.5) * 600,
      pos ? pos.y : cy + (Math.random() - 0.5) * 400,
    );
    map.set(n, fn);
    return fn;
  });

  fedges = [];
  parentFNode = new Map();
  childFNodes = new Map();
  for (const fn of fnodes) childFNodes.set(fn, []);
  for (const n of nodes) {
    if (!n.parent) continue;
    const source = map.get(n.parent);
    const target = map.get(n);
    if (source && target) {
      fedges.push({ source, target });
      parentFNode.set(target, source);
      childFNodes.get(source)!.push(target);
    }
  }

  entityNodeMap = new Map();
  for (const fn of fnodes) {
    if (fn.tree.entityId) {
      entityNodeMap.set(fn.tree.entityId, fn);
    }
  }

  glowTimestamps = new Map();
  pulseWaveFields.clear();
  centroidCache = null;
  rebuildClusters();

  if (settings.initialLayout === "tree") {
    // Warm-up is a synchronous block on the main thread, so a fixed tick count
    // turns into a visible freeze that grows with the instance: 150 ticks cost
    // ~0.6s at 3.7k nodes, ~4s at 20k and ~14s at 50k. Spend a wall-clock
    // budget instead, and let the render loop carry on settling afterwards -
    // alpha is still well above the cutoff, so nothing is left half-baked.
    const warmupStart = performance.now();
    for (let i = 0; i < WARMUP_TICKS; i++) {
      simulate();
      alpha *= ALPHA_DECAY;
      if (performance.now() - warmupStart > WARMUP_BUDGET_MS) break;
    }
  }
  // The default transform is the identity, which cannot frame a graph that is
  // wider than the viewport. Arm the fit so resize() frames it once the
  // container has a real size.
  pendingFit = true;
}

function renderScale(): number {
  // Backing-store cost grows with DPR squared; above 2 the sharpness gain is
  // marginal and large windows can exceed Firefox's accelerated-canvas size cap.
  return Math.min(devicePixelRatio, 2);
}

function resize(): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const dpr = renderScale();
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  // Setting canvas.width clears the bitmap, so repaint even when idle.
  ensureLoop();
  // Frame the graph only right after it was (re)built, never on an ordinary
  // window resize - that would throw away the user's pan and zoom.
  if (pendingFit) fitAll();
}

function tick(): void {
  if (!canvas) return;

  updateFps(performance.now());
  applyPanInertia(performance.now());

  if (alpha > 0.001) {
    simulate();
    alpha *= ALPHA_DECAY;
  }

  draw();

  // Constellation only animates per-frame when twinkle is on; otherwise the
  // settled graph is static and the loop stops until ensureLoop() wakes it.
  const hoverAnimating = hoveredNode !== null && performance.now() - hoverStartTime < 150;
  const needsAnimation = alpha > 0.001 || glowTimestamps.size > 0 || dragNode !== null || panning || panVelocityX !== 0 || panVelocityY !== 0 ||
    (settings.constellation && settings.twinkleSpeed > 0) ||
    settings.unavailableMode === "pulse" || hoverAnimating;
  if (needsAnimation) {
    frame = requestAnimationFrame(tick);
  } else {
    frame = 0;
    markFpsIdle();
  }
}

// Barnes-Hut quadtree with fixed spatial bounds
interface QuadNode {
  x0: number; y0: number; // spatial bounds min
  x1: number; y1: number; // spatial bounds max
  cx: number; cy: number; // center of mass
  count: number;
  body: FNode | null;     // leaf body (null for internal / empty)
  nw: QuadNode | null;
  ne: QuadNode | null;
  sw: QuadNode | null;
  se: QuadNode | null;
}

function quadCreate(x0: number, y0: number, x1: number, y1: number): QuadNode {
  return { x0, y0, x1, y1, cx: 0, cy: 0, count: 0, body: null, nw: null, ne: null, sw: null, se: null };
}

const QUAD_MAX_DEPTH = 40;

function quadInsert(quad: QuadNode, fn: FNode, depth = 0): void {
  if (quad.count === 0) {
    quad.body = fn;
    quad.cx = fn.x;
    quad.cy = fn.y;
    quad.count = 1;
    return;
  }

  // Update center of mass
  const total = quad.count + 1;
  quad.cx = (quad.cx * quad.count + fn.x) / total;
  quad.cy = (quad.cy * quad.count + fn.y) / total;
  quad.count = total;

  if (depth >= QUAD_MAX_DEPTH) return;

  // If leaf with existing body, push it down then insert new
  if (quad.body) {
    const existing = quad.body;
    quad.body = null;
    quadPush(quad, existing, depth);
  }
  quadPush(quad, fn, depth);
}

function quadPush(quad: QuadNode, fn: FNode, depth: number): void {
  const mx = (quad.x0 + quad.x1) / 2;
  const my = (quad.y0 + quad.y1) / 2;
  const east = fn.x >= mx;
  const south = fn.y >= my;

  let child: QuadNode | null;
  if (east) {
    if (south) {
      child = quad.se;
      if (!child) { child = quadCreate(mx, my, quad.x1, quad.y1); quad.se = child; }
    } else {
      child = quad.ne;
      if (!child) { child = quadCreate(mx, quad.y0, quad.x1, my); quad.ne = child; }
    }
  } else {
    if (south) {
      child = quad.sw;
      if (!child) { child = quadCreate(quad.x0, my, mx, quad.y1); quad.sw = child; }
    } else {
      child = quad.nw;
      if (!child) { child = quadCreate(quad.x0, quad.y0, mx, my); quad.nw = child; }
    }
  }

  quadInsert(child, fn, depth + 1);
}

const BH_THETA = 0.9;

// Set when the graph was rebuilt and the view has not been framed yet.
let pendingFit = true;

const WARMUP_TICKS = 150;
// Wall-clock ceiling for the synchronous pre-render warm-up. Small instances
// never reach it and still get all 150 ticks; large ones stop early instead of
// freezing the tab, and carry on settling in the render loop - alpha is still
// far above the cutoff when the budget runs out.
const WARMUP_BUDGET_MS = 1200;

/** Apply the per-tick step cap in place. */
function limitStep(n: FNode): void {
  const v = limitStepVec(n.vx, n.vy);
  n.vx = v.vx;
  n.vy = v.vy;
}

/** Put a node that overflowed to float back on the leash. */
function rescueNode(n: FNode): void {
  n.x = width / 2 || 400;
  n.y = height / 2 || 300;
  n.vx = 0;
  n.vy = 0;
}


/** World-space bounding box of every laid-out node. */
function graphBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of fnodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Frame the whole graph. Also the manual recovery path when the view is lost. */
function fitAll(): void {
  if (fnodes.length === 0) return;
  const box = graphBounds();
  // Stay armed if the fit did not take: a panel that is still 0x0 (not yet
  // laid out, or hidden) would otherwise consume the pending fit and leave the
  // view unframed forever.
  if (!fitTransform(transform, box, width, height)) return;
  pendingFit = false;
  updateViewBounds();
  debugLog(t("system"), t("Fit view: k={k} for {n} nodes", { k: transform.k.toFixed(3), n: fnodes.length }));
  ensureLoop();
}

function quadRepulse(quad: QuadNode, fn: FNode, ra: number): void {
  if (quad.count === 0) return;

  const dx = quad.cx - fn.x;
  const dy = quad.cy - fn.y;
  const d2 = dx * dx + dy * dy;

  if (quad.count === 1 && quad.body) {
    if (quad.body === fn) return;
    const dist2 = Math.max(d2, 1);
    const fd = ra / (dist2 * Math.sqrt(dist2));
    fn.vx -= dx * fd;
    fn.vy -= dy * fd;
    return;
  }

  // Barnes-Hut criterion: cell width / distance < theta -> approximate
  const s = quad.x1 - quad.x0;
  if (s * s < BH_THETA * BH_THETA * d2) {
    const dist2 = Math.max(d2, 1);
    const fd = (ra * quad.count) / (dist2 * Math.sqrt(dist2));
    fn.vx -= dx * fd;
    fn.vy -= dy * fd;
    return;
  }

  if (quad.nw) quadRepulse(quad.nw, fn, ra);
  if (quad.ne) quadRepulse(quad.ne, fn, ra);
  if (quad.sw) quadRepulse(quad.sw, fn, ra);
  if (quad.se) quadRepulse(quad.se, fn, ra);
}

function simulate(): void {
  const ra = settings.repulsion * alpha;

  // Compute bounding box for quadtree
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fn of fnodes) {
    if (fn.x < minX) minX = fn.x;
    if (fn.y < minY) minY = fn.y;
    if (fn.x > maxX) maxX = fn.x;
    if (fn.y > maxY) maxY = fn.y;
  }
  // Pad slightly and make square for even subdivision
  const pad = 10;
  const side = Math.max(maxX - minX, maxY - minY) + pad * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const root = quadCreate(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2);

  for (const fn of fnodes) quadInsert(root, fn);
  for (const fn of fnodes) quadRepulse(root, fn, ra);

  for (const edge of fedges) {
    const dx = edge.target.x - edge.source.x;
    const dy = edge.target.y - edge.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - settings.springLen) * settings.springK * alpha;
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
    if (n.fx !== null) { n.x = n.fx; n.vx = 0; }
    else { n.vx *= settings.damping; limitStep(n); n.x += n.vx; }
    if (n.fy !== null) { n.y = n.fy; n.vy = 0; }
    else { n.vy *= settings.damping; limitStep(n); n.y += n.vy; }
    // A node the user is dragging has fx/fy pinned and a zero velocity, so it
    // can never trip either guard below.
    if (needsRescue(n.x, n.y)) rescueNode(n);
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

  const fillColor = nodeColor(cluster.groupNode.kind, cluster.groupNode.domain);
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
  const entityFontSize = settings.labelSize / transform.k;
  const parentFontSize = (settings.labelSize * 1.4) / transform.k;
  const pad = 3 / transform.k;
  const radius = 3 / transform.k;
  const middleFontSize = settings.labelSize * 1.15;
  const middlePad = 3;
  const middleRadius = 3;
  const middleGap = 2;
  const cullMargin = Math.max(600, entityFontSize * 30);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  let glassIndex = 0;

  for (const n of fnodes) {
    const kind = n.tree.kind;
    const isEntity = kind === "entity";
    const isArea = kind === "area";
    const isMiddle = kind === "domain" || kind === "device";
    const isGlass = kind === "root" || isArea;

    if (isEntity && transform.k < settings.entityLabelZoom) continue;
    if (isMiddle && !settings.showStructureLabels) continue;
    // Entity font grows as 1/k in world units, so scale the margin with it or
    // long labels clip at screen edges under extreme slider settings.
    if (!inView(n.x, n.y, cullMargin)) continue;

    const zoomFade = isEntity ? Math.min(1, (transform.k - settings.entityLabelZoom) / 0.5) : 1;
    const labelAlpha = Math.max(0.3, zoomFade);

    let fontSize: number;
    let weight: number;
    if (kind === "root") {
      fontSize = parentFontSize * 1.2;
      weight = 700;
    } else if (isArea) {
      fontSize = parentFontSize;
      weight = 600;
    } else if (isMiddle) {
      fontSize = middleFontSize;
      weight = 500;
    } else {
      fontSize = entityFontSize;
      weight = 400;
    }
    const gap = isMiddle ? middleGap : 2 / transform.k;
    const metrics = measureLabel(ctx, n.tree.label, weight, fontSize);
    const textY = n.y + n.r + gap + metrics.ascent;

    if (isGlass && glassContainer) {
      // Position glass overlay div for root/area labels
      if (glassIndex >= glassLabels.length) {
        const div = document.createElement("div");
        div.className = "glass-label";
        glassContainer.appendChild(div);
        glassLabels.push(div);
      }
      const div = glassLabels[glassIndex++];
      const screenX = n.x * transform.k + transform.x;
      const screenY = textY * transform.k + transform.y;
      const baseFontSize = kind === "root" ? settings.labelSize * 1.4 * 1.2 : settings.labelSize * 1.4;
      const screenFontSize = baseFontSize * transform.k;
      const padY = 2 * transform.k;
      const padX = 8 * transform.k;
      const glassWeight = kind === "root" ? "700" : "600";
      div.textContent = n.tree.label;
      div.style.left = `${screenX}px`;
      div.style.top = `${screenY}px`;
      div.style.fontSize = `${screenFontSize}px`;
      div.style.padding = `${padY}px ${padX}px`;
      div.style.fontWeight = glassWeight;
      div.style.opacity = String(labelAlpha);
      div.style.display = "";
    } else {
      const labelPad = isMiddle ? middlePad : pad;
      const labelRadius = isMiddle ? middleRadius : radius;
      ctx.font = `${weight} ${fontSize}px ${FONT_FAMILY}`;
      ctx.globalAlpha = labelAlpha * 0.5;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.roundRect(
        n.x - metrics.width / 2 - labelPad,
        textY - metrics.ascent - labelPad,
        metrics.width + labelPad * 2,
        metrics.ascent + metrics.descent + labelPad * 2,
        labelRadius
      );
      ctx.fill();

      ctx.globalAlpha = labelAlpha;
      ctx.fillStyle = isEntity ? "#bbb" : "#e0e0e0";
      ctx.fillText(n.tree.label, n.x, textY);
    }
  }

  // Hide unused glass labels
  for (let i = glassIndex; i < glassLabels.length; i++) {
    glassLabels[i].style.display = "none";
  }

  ctx.globalAlpha = 1;
}

function transparent(hex: string): string {
  return expandHex(hex) + "00";
}

function expandHex(hex: string): string {
  if (hex.length === 4) {
    return "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex;
}

function rgbaFromHex(hex: string, alpha: number, whiten = 0): string {
  const h = expandHex(hex);
  let r = parseInt(h.slice(1, 3), 16);
  let g = parseInt(h.slice(3, 5), 16);
  let b = parseInt(h.slice(5, 7), 16);
  if (whiten > 0) {
    r = Math.round(r + (255 - r) * whiten);
    g = Math.round(g + (255 - g) * whiten);
    b = Math.round(b + (255 - b) * whiten);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function treeMatchesSearch(node: TreeNode): boolean {
  const label = node.label.toLowerCase();
  const id = (node.entityId ?? node.id).toLowerCase();
  return label.includes(searchQuery) || id.includes(searchQuery);
}

function matchesSearch(fn: FNode): boolean {
  return searchQuery !== "" && treeMatchesSearch(fn.tree);
}

function drawSearchHighlights(ctx: CanvasRenderingContext2D): void {
  if (!searchQuery) return;

  for (const fn of fnodes) {
    if (!matchesSearch(fn)) continue;

    if (!inView(fn.x, fn.y, fn.r * 3)) continue;
    drawRingHighlight(ctx, fn, "ring3", 3, 0.5, 2, 0.9);
  }

  ctx.globalAlpha = 1;
}

function drawHoverHighlight(ctx: CanvasRenderingContext2D, fn: FNode): void {
  drawRingHighlight(ctx, fn, "ring25", 2.5, 0.4, 1.5, 0.7);
  ctx.globalAlpha = 1;
}

function drawRingHighlight(
  ctx: CanvasRenderingContext2D, fn: FNode, profile: GlowSpriteProfile,
  haloScale: number, haloAlpha: number, ringWidth: number, ringAlpha: number,
): void {
  const haloR = fn.r * haloScale;
  ctx.globalAlpha = haloAlpha;
  ctx.drawImage(getGlowSprite(profile, nodeColor(fn.tree.kind, fn.tree.domain)), fn.x - haloR, fn.y - haloR, haloR * 2, haloR * 2);

  ctx.beginPath();
  ctx.arc(fn.x, fn.y, fn.r + ringWidth / transform.k, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.globalAlpha = ringAlpha;
  ctx.lineWidth = ringWidth / transform.k;
  ctx.stroke();
}

function drawGlows(ctx: CanvasRenderingContext2D): void {
  const now = performance.now();
  pruneExpiredGlows(now);

  for (const [fn, startTime] of glowTimestamps) {
    const elapsed = now - startTime;
    const progress = elapsed / GLOW_DURATION;
    const ease = 1 - (1 - progress) * (1 - progress);
    const ringRadius = fn.r * (1 + ease * 11);
    const opacity = 1 - progress;
    const glowColor = nodeColor(fn.tree.kind, fn.tree.domain);

    ctx.beginPath();
    ctx.arc(fn.x, fn.y, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = glowColor;
    ctx.globalAlpha = opacity * 0.2 * settings.glowBrightness;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(fn.x, fn.y, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = glowColor;
    ctx.globalAlpha = opacity * 0.9 * settings.glowBrightness;
    ctx.lineWidth = (3 + 4 * (1 - progress)) / transform.k;
    ctx.stroke();

    if (progress < 0.4) {
      const flashOpacity = 1 - progress / 0.4;
      ctx.beginPath();
      ctx.arc(fn.x, fn.y, fn.r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = flashOpacity * 0.5 * settings.glowBrightness;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }
}

function pruneExpiredGlows(now: number): void {
  for (const [fn, startTime] of glowTimestamps) {
    if (now - startTime > GLOW_DURATION) {
      glowTimestamps.delete(fn);
      pulseWaveFields.delete(fn);
    }
  }
}

// Wide faint pass, medium pass, bright core pass.
const GLOW_PASSES: [alphaScale: number, widthScale: number][] = [[0.15, 6], [0.4, 2.5], [0.9, 1]];

function drawGlowLine(
  ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number,
  lineColor: string, alpha: number, width: number
): void {
  ctx.strokeStyle = lineColor;
  for (const [alphaScale, widthScale] of GLOW_PASSES) {
    ctx.globalAlpha = alpha * alphaScale * settings.lineGlow;
    ctx.lineWidth = width * widthScale;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

interface GlowBatch {
  color: string;
  alpha: number;
  width: number;
  segments: number[];
}

// Stroking each edge separately creates fresh path geometry per stroke call,
// which defeats Firefox's GPU path cache and can silently disable canvas
// acceleration; batching all same-style edges into one path per pass avoids it.
function strokeGlowBatches(ctx: CanvasRenderingContext2D, batches: Map<string, GlowBatch>): void {
  for (const batch of batches.values()) {
    ctx.strokeStyle = batch.color;
    for (const [alphaScale, widthScale] of GLOW_PASSES) {
      ctx.globalAlpha = batch.alpha * alphaScale * settings.lineGlow;
      ctx.lineWidth = batch.width * widthScale;
      ctx.beginPath();
      const s = batch.segments;
      for (let i = 0; i < s.length; i += 4) {
        ctx.moveTo(s[i], s[i + 1]);
        ctx.lineTo(s[i + 2], s[i + 3]);
      }
      ctx.stroke();
    }
  }
}

function drawConstellation(ctx: CanvasRenderingContext2D, now: number): void {
  const invK = 1 / transform.k;

  const edgeBatches = new Map<string, GlowBatch>();
  for (const e of fedges) {
    if (!segmentInView(e.source.x, e.source.y, e.target.x, e.target.y, 4)) continue;
    const sc = nodeCluster.get(e.source);
    const tc = nodeCluster.get(e.target);
    let edgeColor: string;
    let edgeAlpha: number;
    let edgeWidth: number;
    if (sc && sc === tc) {
      edgeColor = nodeColor(sc.groupNode.kind, sc.groupNode.domain);
      edgeAlpha = 0.25;
      edgeWidth = 0.5 * invK;
    } else if (e.source.tree.kind !== "entity" && e.target.tree.kind !== "entity") {
      edgeColor = nodeColor(e.source.tree.kind, e.source.tree.domain);
      edgeAlpha = 0.35;
      edgeWidth = 0.6 * invK;
    } else {
      continue;
    }
    const key = `${edgeColor}|${edgeAlpha}`;
    let batch = edgeBatches.get(key);
    if (!batch) {
      batch = { color: edgeColor, alpha: edgeAlpha, width: edgeWidth, segments: [] };
      edgeBatches.set(key, batch);
    }
    batch.segments.push(e.source.x, e.source.y, e.target.x, e.target.y);
  }
  strokeGlowBatches(ctx, edgeBatches);

  if (clusters.length > 1) {
    // Positions only change while the simulation runs or a node is dragged,
    // yet the constellation renders every frame; reuse centroids otherwise.
    const positionsMoving = alpha > 0.001 || dragNode !== null || pendingReveals.length > 0;
    if (!centroidCache || positionsMoving || centroidCacheClusters !== clusters) {
      const centroids: { x: number; y: number }[] = [];
      for (const cluster of clusters) {
        let cx = 0, cy = 0;
        for (const fn of cluster.nodes) { cx += fn.x; cy += fn.y; }
        cx /= cluster.nodes.length;
        cy /= cluster.nodes.length;
        centroids.push({ x: cx, y: cy });
      }

      const pairs: [number, number][] = [];
      for (let i = 0; i < centroids.length; i++) {
        const a = centroids[i];
        let closestDist = Infinity;
        let closestIdx = -1;
        for (let j = 0; j < centroids.length; j++) {
          if (i === j) continue;
          const dx = a.x - centroids[j].x;
          const dy = a.y - centroids[j].y;
          const d = dx * dx + dy * dy;
          if (d < closestDist) { closestDist = d; closestIdx = j; }
        }
        if (closestIdx > i) pairs.push([i, closestIdx]);
      }

      centroidCache = centroids;
      centroidEdgeCache = pairs;
      centroidCacheClusters = clusters;
    }

    ctx.setLineDash([4 * invK, 6 * invK]);
    for (const [i, j] of centroidEdgeCache) {
      const a = centroidCache[i];
      const b = centroidCache[j];
      drawGlowLine(ctx, a.x, a.y, b.x, b.y, "#88aacc", 0.4, 0.4 * invK);
    }
    ctx.setLineDash([]);
  }

  const starScale = settings.starSize / Math.sqrt(transform.k);

  invalidateSpriteCache();

  ctx.globalCompositeOperation = "screen";

  const entityCullMargin = 5 * starScale * settings.glowSize * settings.glowIntensity * (1 + settings.twinkleSize);
  for (const fn of fnodes) {
    if (fn.tree.kind !== "entity") continue;
    if (!inView(fn.x, fn.y, entityCullMargin)) continue;

    const unavail = isUnavailable(fn) && (settings.unavailableMode === "pulse" || settings.unavailableMode === "ring");
    const pulse = twinkleFactor(fn, now);
    const baseAlpha = unavail ? 0.15 : 0.5;
    const twinklePulse = settings.twinkleMin + (1 - settings.twinkleMin) * pulse;
    const haloAlpha = Math.min(1, baseAlpha * twinklePulse * settings.glowBrightness);
    const coreAlpha = Math.min(1, twinklePulse * (unavail ? 0.4 : 1));

    const nodeCol = unavail ? "#666" : nodeColor(fn.tree.kind, fn.tree.domain);
    const sizePulse = 1 + settings.twinkleSize * (pulse - 0.5);
    const haloR = 5 * starScale * settings.glowSize * settings.glowIntensity * sizePulse;
    drawStar(ctx, fn, nodeCol, settings.glowIntensity, haloR, haloAlpha, coreAlpha);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function twinkleFactor(fn: FNode, now: number): number {
  const twinkle = settings.twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * settings.twinkleSpeed + fn.phase);
  return twinkle * twinkle;
}

function drawStar(
  ctx: CanvasRenderingContext2D, fn: FNode, nodeCol: string, intensity: number,
  haloR: number, haloAlpha: number, coreAlpha: number,
): void {
  const sprite = getStarSprite(nodeCol, intensity);
  const drawSize = haloR * 2;
  ctx.globalAlpha = haloAlpha;
  ctx.drawImage(sprite.halo, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  ctx.globalAlpha = coreAlpha;
  ctx.drawImage(sprite.core, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
}

function drawConstellationParents(ctx: CanvasRenderingContext2D, now: number): void {
  const starScale = settings.starSize / Math.sqrt(transform.k);
  const pgi = settings.parentGlowIntensity;

  ctx.globalCompositeOperation = "screen";

  const parentCullMargin = 14 * starScale * settings.glowSize * pgi * (1 + settings.twinkleSize);
  for (const fn of fnodes) {
    if (fn.tree.kind === "entity") continue;
    if (!inView(fn.x, fn.y, parentCullMargin)) continue;

    const pulse = twinkleFactor(fn, now);
    const twinklePulse = settings.twinkleMin + (1 - settings.twinkleMin) * pulse;
    const haloAlpha = Math.min(1, 0.9 * twinklePulse * settings.glowBrightness);
    const coreAlpha = Math.min(1, twinklePulse);

    const nodeCol = nodeColor(fn.tree.kind, fn.tree.domain);
    const starR = (fn.tree.kind === "root" ? 14 : 9) * starScale;
    const sizePulse = 1 + settings.twinkleSize * (pulse - 0.5);
    const haloR = starR * settings.glowSize * pgi * sizePulse;
    drawStar(ctx, fn, nodeCol, pgi, haloR, haloAlpha, coreAlpha);
  }

  ctx.globalCompositeOperation = "source-over";

  ctx.globalAlpha = 1;
}

function drawConstellationHover(ctx: CanvasRenderingContext2D): void {
  if (!hoveredNode) return;
  const fn = hoveredNode;
  const elapsed = performance.now() - hoverStartTime;
  const t = Math.min(1, elapsed / 120);
  const ease = t * (2 - t);

  const starScale = settings.starSize / Math.sqrt(transform.k);
  const isEntity = fn.tree.kind === "entity";
  const baseR = isEntity ? 5 : (fn.tree.kind === "root" ? 14 : 9);
  const starR = baseR * starScale;
  const intensity = isEntity ? settings.glowIntensity : settings.parentGlowIntensity;
  const scale = 1 + 0.5 * ease;
  const haloR = starR * settings.glowSize * intensity * scale;

  ctx.globalCompositeOperation = "screen";
  drawStar(ctx, fn, nodeColor(fn.tree.kind, fn.tree.domain), intensity, haloR, 0.6 * ease, ease);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function drawStarEffects(ctx: CanvasRenderingContext2D, now: number): void {
  pruneExpiredGlows(now);
  const ss = settings.starSize * settings.effectScale / Math.sqrt(transform.k);

  for (const [fn, startTime] of glowTimestamps) {
    const t = (now - startTime) / GLOW_DURATION;
    const nodeCol = nodeColor(fn.tree.kind, fn.tree.domain);

    switch (settings.starEffect) {
      case "supernova":
        drawSupernova(ctx, fn, t, nodeCol, ss);
        break;
      case "shooting-star":
        drawShootingStar(ctx, fn, t, nodeCol, ss);
        break;
      case "flare":
        drawFlare(ctx, fn, t, nodeCol, ss, now);
        break;
      case "pulse-wave":
        drawPulseWave(ctx, fn, t, nodeCol, ss);
        break;
      case "color-shift":
        drawColorShift(ctx, fn, t, ss);
        break;
    }
  }
  ctx.globalAlpha = 1;
}

function drawSupernova(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number): void {
  const ease = 1 - (1 - t) * (1 - t);
  const blastR = ss * 80 * ease * settings.glowIntensity;
  const opacity = (1 - t);
  const gb = settings.glowBrightness;

  ctx.globalAlpha = opacity * 0.6 * gb;
  ctx.drawImage(getGlowSprite("blast", nodeCol), fn.x - blastR, fn.y - blastR, blastR * 2, blastR * 2);

  if (t < 0.3) {
    const flashAlpha = 1 - t / 0.3;
    ctx.globalAlpha = flashAlpha * 0.9 * gb;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(fn.x, fn.y, ss * 12 * (1 - t), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const other of fnodes) {
    if (other === fn) continue;
    if (!inView(other.x, other.y, ss * 4)) continue;
    const dx = other.x - fn.x;
    const dy = other.y - fn.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < blastR) {
      const proximity = 1 - dist / blastR;
      ctx.globalAlpha = proximity * opacity * 0.4 * gb;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(other.x, other.y, ss * 4 * proximity, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawShootingStar(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number): void {
  const parent = parentFNode.get(fn);
  if (!parent) return;

  const headT = Math.min(t * 2, 1);
  const ease = 1 - (1 - headT) * (1 - headT);
  const hx = fn.x + (parent.x - fn.x) * ease;
  const hy = fn.y + (parent.y - fn.y) * ease;

  const trailLen = 8;
  for (let i = 0; i < trailLen; i++) {
    const trailT = Math.max(0, ease - i * 0.04);
    const tx = fn.x + (parent.x - fn.x) * trailT;
    const ty = fn.y + (parent.y - fn.y) * trailT;
    const fade = (1 - i / trailLen) * (1 - t);
    const r = ss * (3 - i * 0.3);

    ctx.globalAlpha = fade * 0.7 * settings.glowBrightness;
    ctx.fillStyle = i === 0 ? "#fff" : nodeCol;
    ctx.beginPath();
    ctx.arc(tx, ty, Math.max(r, ss * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  const headR = ss * 10;
  ctx.globalAlpha = (1 - t) * 0.6 * settings.glowBrightness;
  ctx.drawImage(getGlowSprite("head", nodeCol), hx - headR, hy - headR, headR * 2, headR * 2);
}

function drawFlare(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number, now: number): void {
  const intensity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
  const rotation = now * 0.001;
  const spikeLen = ss * (5 + 45 * intensity * settings.glowIntensity);
  const spikeCount = 4;

  const coreR = ss * 8 * intensity;
  if (coreR > 0) {
    ctx.globalAlpha = intensity * 0.7 * settings.glowBrightness;
    ctx.drawImage(getGlowSprite("core", nodeCol), fn.x - coreR, fn.y - coreR, coreR * 2, coreR * 2);
  }

  for (let i = 0; i < spikeCount; i++) {
    const angle = rotation + (i * Math.PI) / spikeCount;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const grad = ctx.createLinearGradient(
      fn.x - cos * spikeLen, fn.y - sin * spikeLen,
      fn.x + cos * spikeLen, fn.y + sin * spikeLen
    );
    grad.addColorStop(0, transparent(nodeCol));
    grad.addColorStop(0.4, nodeCol);
    grad.addColorStop(0.5, "#fff");
    grad.addColorStop(0.6, nodeCol);
    grad.addColorStop(1, transparent(nodeCol));

    ctx.globalAlpha = intensity * 0.6 * settings.glowBrightness;
    ctx.strokeStyle = grad;
    ctx.lineWidth = ss * (1 + 2 * intensity);
    ctx.beginPath();
    ctx.moveTo(fn.x - cos * spikeLen, fn.y - sin * spikeLen);
    ctx.lineTo(fn.x + cos * spikeLen, fn.y + sin * spikeLen);
    ctx.stroke();
  }
}

// The wave's BFS field depends only on graph topology, so compute it once per
// glow instead of every frame; invalidated on rebuild and node insertion.
interface PulseWaveField {
  depths: Map<FNode, number>;
  edges: { source: FNode; target: FNode; depth: number }[];
}
const pulseWaveFields = new Map<FNode, PulseWaveField>();

function computePulseWaveField(fn: FNode): PulseWaveField {
  const depths = new Map<FNode, number>();
  const queue: { node: FNode; depth: number }[] = [{ node: fn, depth: 0 }];
  depths.set(fn, 0);

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth > 5) continue;

    const children = childFNodes.get(node) ?? [];
    const parent = parentFNode.get(node);
    const neighbors = [...children];
    if (parent) neighbors.push(parent);

    for (const nb of neighbors) {
      if (depths.has(nb)) continue;
      depths.set(nb, depth + 1);
      queue.push({ node: nb, depth: depth + 1 });
    }
  }

  const edges: PulseWaveField["edges"] = [];
  for (const e of fedges) {
    const sd = depths.get(e.source);
    const td = depths.get(e.target);
    if (sd === undefined || td === undefined) continue;
    edges.push({ source: e.source, target: e.target, depth: Math.min(sd, td) });
  }

  return { depths, edges };
}

function drawPulseWave(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number): void {
  const waveFront = t * 6;
  let field = pulseWaveFields.get(fn);
  if (!field) {
    field = computePulseWaveField(fn);
    pulseWaveFields.set(fn, field);
  }

  for (const [node, depth] of field.depths) {
    const waveHit = depth / waveFront;
    if (waveHit > 1) continue;
    const fadeIn = Math.max(0, 1 - Math.abs(waveHit - 0.5) * 2);
    const fade = fadeIn * (1 - t);

    ctx.globalAlpha = fade * 0.8 * settings.glowBrightness;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(node.x, node.y, ss * (3 + 5 * fadeIn), 0, Math.PI * 2);
    ctx.fill();

    const glowR = ss * 12 * fadeIn;
    if (glowR > 0) {
      ctx.globalAlpha = fade * 0.4 * settings.glowBrightness;
      ctx.drawImage(getGlowSprite("soft", nodeCol), node.x - glowR, node.y - glowR, glowR * 2, glowR * 2);
    }
  }

  for (const e of field.edges) {
    const waveHit = e.depth / waveFront;
    if (waveHit > 1) continue;
    const fadeIn = Math.max(0, 1 - Math.abs(waveHit - 0.5) * 2);
    const fade = fadeIn * (1 - t);

    ctx.globalAlpha = fade * 0.7 * settings.glowBrightness;
    ctx.strokeStyle = nodeCol;
    ctx.lineWidth = ss * (1 + 3 * fadeIn);
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }
}

function drawColorShift(ctx: CanvasRenderingContext2D, fn: FNode, t: number, ss: number): void {
  const hue = t < 0.3
    ? 60 - t / 0.3 * 60
    : t < 0.6
      ? 240 * ((t - 0.3) / 0.3)
      : 240 - (t - 0.6) / 0.4 * 240;
  const sat = t < 0.2 ? 0 : Math.min(100, (t - 0.2) * 200);
  const light = t < 0.15 ? 95 - t / 0.15 * 30 : 65;
  const shiftColor = `hsl(${hue}, ${sat}%, ${light}%)`;
  const shiftTransparent = `hsla(${hue}, ${sat}%, ${light}%, 0)`;
  const fade = 1 - t * t;

  const glow = ctx.createRadialGradient(fn.x, fn.y, 0, fn.x, fn.y, ss * 20 * settings.glowIntensity);
  glow.addColorStop(0, shiftColor);
  glow.addColorStop(0.3, shiftColor);
  glow.addColorStop(1, shiftTransparent);
  ctx.globalAlpha = fade * 0.7 * settings.glowBrightness;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, ss * 20 * settings.glowIntensity, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = fade * settings.glowBrightness;
  ctx.fillStyle = t < 0.15 ? "#fff" : shiftColor;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, ss * 3, 0, Math.PI * 2);
  ctx.fill();
}

function isTreeUnavailable(node: TreeNode): boolean {
  if (!node.entityId) return false;
  return currentStates.get(node.entityId)?.state === "unavailable";
}

function isUnavailable(fn: FNode): boolean {
  return isTreeUnavailable(fn.tree);
}

function drawUnavailablePulses(ctx: CanvasRenderingContext2D, now: number): void {
  if (settings.unavailableMode !== "pulse") return;

  const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now * 0.004));

  for (const fn of fnodes) {
    if (!inView(fn.x, fn.y, fn.r * 2.5 + 1)) continue;
    if (!isUnavailable(fn)) continue;

    const r = fn.r * 2.5;

    ctx.globalAlpha = pulse * 0.3;
    ctx.fillStyle = "#ef5350";
    ctx.beginPath();
    ctx.arc(fn.x, fn.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = pulse * 0.7;
    ctx.strokeStyle = "#ef5350";
    ctx.lineWidth = 1.5 / transform.k;
    ctx.beginPath();
    ctx.arc(fn.x, fn.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function draw(): void {
  if (!canvas || !ctx) return;
  const dpr = renderScale();
  updateViewBounds();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = settings.backgroundColor;
  ctx.fillRect(0, 0, width, height);

  ctx.setTransform(
    dpr * transform.k, 0,
    0, dpr * transform.k,
    dpr * transform.x, dpr * transform.y
  );

  if (glassContainer) glassContainer.style.display = settings.showLabels ? "" : "none";

  if (settings.constellation) {
    const now = performance.now();
    if (settings.showHulls) {
      for (const cluster of clusters) {
        drawHull(ctx, cluster);
      }
    }
    drawConstellation(ctx, now);
    drawStarEffects(ctx, now);
    drawConstellationParents(ctx, now);
    drawAutomationEdges(ctx);
    drawConstellationHover(ctx);
    drawUnavailablePulses(ctx, now);
    drawSearchHighlights(ctx);
    if (settings.showLabels) drawLabels(ctx);
    return;
  }

  if (settings.showHulls) {
    for (const cluster of clusters) {
      drawHull(ctx, cluster);
    }
  }

  ctx.globalAlpha = Math.min(1, settings.lineGlow);
  ctx.lineWidth = (0.5 + settings.lineGlow) / transform.k;
  ctx.strokeStyle = settings.lineGlow > 1 ? "#666" : "#444";
  ctx.beginPath();
  for (const e of fedges) {
    if (!segmentInView(e.source.x, e.source.y, e.target.x, e.target.y, 2)) continue;
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  drawAutomationEdges(ctx);

  for (const n of fnodes) {
    if (!inView(n.x, n.y, n.r * 2)) continue;
    const unavail = isUnavailable(n);
    const dimmed = unavail && settings.unavailableMode === "pulse";
    const ringed = unavail && settings.unavailableMode === "ring";
    ctx.globalAlpha = dimmed ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    if (ringed) {
      ctx.fillStyle = settings.backgroundColor;
      ctx.fill();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = nodeColor(n.tree.kind, n.tree.domain);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = "#888";
      ctx.lineWidth = 1 / transform.k;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = dimmed ? "#666" : nodeColor(n.tree.kind, n.tree.domain);
      ctx.fill();
    }

    if (settings.showIcons && n.tree.kind === "entity" && n.tree.entityId) {
      const stateAttrIcon = currentStates.get(n.tree.entityId)?.attributes.icon;
      const iconName = getEntityIconName(n.tree.domain, stateAttrIcon);
      if (iconName) {
        const icon = getCachedIcon(iconName);
        if (icon) {
          const s = (n.r * 1.25) / icon.viewBox;
          const half = icon.viewBox / 2;
          ctx.save();
          ctx.translate(n.x, n.y);
          ctx.scale(s, s);
          ctx.translate(-half, -half);
          ctx.fillStyle = "#fff";
          ctx.globalAlpha = dimmed ? 0.5 : 0.95;
          ctx.fill(icon.path);
          ctx.restore();
        } else {
          requestIcon(iconName);
        }
      }
    }
  }
  ctx.globalAlpha = 1;

  // Draw collapsed indicator
  if (collapsedNodes.size > 0) {
    const ss = 1 / transform.k;
    for (const n of fnodes) {
      if (!collapsedNodes.has(n.tree.id)) continue;
      // Badge font has a 7-world-unit floor, so the margin must too or badges
      // pop in at screen edges when zoomed in.
      const fontSize = Math.max(7, 9 * ss);
      if (!inView(n.x, n.y, n.r + 4 * ss + fontSize * 2)) continue;

      // Dashed ring around the node
      ctx.strokeStyle = "#aaa";
      ctx.lineWidth = 1.5 * ss;
      ctx.setLineDash([3 * ss, 3 * ss]);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 4 * ss, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Child count badge
      const count = n.tree.leafCount;
      const label = String(count);
      ctx.font = `600 ${fontSize}px sans-serif`;
      const tw = ctx.measureText(label).width;
      const badgeR = Math.max(tw / 2 + 2 * ss, 5 * ss);
      const bx = n.x + n.r + 4 * ss;
      const by = n.y - n.r - 2 * ss;

      ctx.beginPath();
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = "#555";
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx, by);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
  }

  drawUnavailablePulses(ctx, performance.now());

  if (hoveredNode) {
    drawHoverHighlight(ctx, hoveredNode);
  }

  drawSearchHighlights(ctx);
  drawGlows(ctx);

  if (settings.showLabels) {
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

const DRAG_THRESHOLD_PX = 4;
const activePointers = new Map<number, { x: number; y: number }>();
let pinchDistance = 0;
let pinchMidX = 0;
let pinchMidY = 0;
let pointerStartX = 0;
let pointerStartY = 0;

function pinchState(): { distance: number; midX: number; midY: number } {
  const [a, b] = [...activePointers.values()];
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

function stopPanInertia(): void {
  panVelocityX = 0;
  panVelocityY = 0;
}

function applyPanInertia(now: number): void {
  if (panVelocityX === 0 && panVelocityY === 0) return;
  const dt = Math.min(now - lastInertiaFrame, 50);
  lastInertiaFrame = now;
  transform.x += panVelocityX * dt;
  transform.y += panVelocityY * dt;
  const decay = Math.exp(-dt / PAN_INERTIA_DECAY_MS);
  panVelocityX *= decay;
  panVelocityY *= decay;
  if (Math.hypot(panVelocityX, panVelocityY) < PAN_INERTIA_MIN_SPEED) stopPanInertia();
}

function releaseDrag(): void {
  if (dragNode) {
    dragNode.fx = null;
    dragNode.fy = null;
    dragNode = null;
  }
  panning = false;
}

function onPointerCancel(e: PointerEvent): void {
  activePointers.delete(e.pointerId);
  releaseDrag();
  stopPanInertia();
  ensureLoop();
}

function onPointerDown(e: PointerEvent): void {
  canvas?.setPointerCapture(e.pointerId);
  stopPanInertia();
  activePointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (activePointers.size === 2) {
    // A second finger turns any drag or pan into a pinch.
    releaseDrag();
    didDrag = true;
    hideTooltip();
    ({ distance: pinchDistance, midX: pinchMidX, midY: pinchMidY } = pinchState());
    return;
  }
  if (activePointers.size > 2) return;
  dismissContextMenu();
  didDrag = false;
  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
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
    lastPanMoveTime = e.timeStamp;
  }
  ensureLoop();
}

function onPointerMove(e: PointerEvent): void {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  }
  if (activePointers.size >= 2) {
    const pinch = pinchState();
    if (pinchDistance > 0) zoomAt(transform, pinch.distance / pinchDistance, pinch.midX, pinch.midY);
    transform.x += pinch.midX - pinchMidX;
    transform.y += pinch.midY - pinchMidY;
    ({ distance: pinchDistance, midX: pinchMidX, midY: pinchMidY } = pinch);
    ensureLoop();
    return;
  }
  if ((dragNode || panning) && !didDrag
    && Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY) > DRAG_THRESHOLD_PX) {
    didDrag = true;
  }
  if (dragNode) {
    if (!didDrag) return;
    const world = screenToWorld(transform, e.offsetX, e.offsetY);
    dragNode.fx = world.x;
    dragNode.fy = world.y;
    alpha = Math.max(alpha, 0.1);
  } else if (panning) {
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    const dt = e.timeStamp - lastPanMoveTime;
    if (dt > 0) {
      // Smooth over recent moves so one jittery event does not set the fling speed.
      panVelocityX = panVelocityX * 0.2 + (dx / dt) * 0.8;
      panVelocityY = panVelocityY * 0.2 + (dy / dt) * 0.8;
    }
    lastPanMoveTime = e.timeStamp;
    transform.x += dx;
    transform.y += dy;
    panStartX = e.clientX;
    panStartY = e.clientY;
  }
  const n = hitTest(e.offsetX, e.offsetY);
  const changed = hoveredNode !== n;
  if (changed && n) hoverStartTime = performance.now();
  hoveredNode = n;
  if (n) {
    let extra = "";
    if (n.tree.entityId) {
      const count = stateChangeCounts.get(n.tree.entityId);
      if (count && count > 0) {
        extra += `<br><span style="color:#9e9e9e;font-size:0.7rem">Changes: ${count}</span>`;
      }
      if (settings.showAutomationEdges) {
        extra += getAutomationTooltipHtml(n.tree.entityId);
      }
    }
    if (isCollapsible(n.tree)) {
      const collapsed = collapsedNodes.has(n.tree.id);
      extra += `<br><span style="color:#9e9e9e;font-size:0.7rem">${n.tree.leafCount} entities${collapsed ? " (collapsed)" : ""} · Shift+click to ${collapsed ? "expand" : "collapse"}</span>`;
    }
    showTooltip(e.clientX, e.clientY, n.tree.label, n.tree.entityId, currentStates, extra || undefined);
    if (canvas) canvas.style.cursor = "pointer";
  } else {
    hideTooltip();
    if (canvas) canvas.style.cursor = panning ? "grabbing" : "grab";
  }
  if (changed) ensureLoop();
}

function onPointerUp(e: PointerEvent): void {
  const wasPinch = activePointers.size >= 2;
  activePointers.delete(e.pointerId);
  if (wasPinch) {
    // Lifting one finger of a pinch must not start a pan from a stale position.
    releaseDrag();
    ensureLoop();
    return;
  }
  if (dragNode) {
    if (!didDrag) {
      if (e.shiftKey && isCollapsible(dragNode.tree)) {
        toggleCollapse(dragNode);
      } else {
        onContextMenu(e);
      }
    }
    dragNode.fx = null;
    dragNode.fy = null;
    dragNode = null;
  }
  // Only fling when the pointer was still moving at release; a pause before
  // letting go means the user meant to stop.
  if (panning && didDrag && e.timeStamp - lastPanMoveTime < PAN_RELEASE_IDLE_MS) {
    lastInertiaFrame = performance.now();
  } else {
    stopPanInertia();
  }
  panning = false;
  ensureLoop();
}

function getHaUrl(): string {
  if (panelHaUrl) return panelHaUrl;
  const creds = loadCredentials();
  return creds?.url?.replace(/\/+$/, "") ?? "";
}

function nodeActionId(node: TreeNode): string | null {
  if (node.entityId) return node.entityId;
  if (node.kind === "area") return node.id.replace(/^area:/, "");
  if (node.kind === "device") return deviceIdFromNodeId(node.id);
  return null;
}

function deviceIdFromNodeId(nodeId: string): string {
  // Node ID format: "device:{areaKey}:{deviceId}"
  const parts = nodeId.split(":");
  return parts.slice(2).join(":");
}

function copyNodeId(node: TreeNode): void {
  const id = nodeActionId(node);
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => showToast(t("Copied: {id}", { id })));
}

function openEntityPage(entityId: string, page: "history" | "logbook"): void {
  const base = getHaUrl();
  if (!base) return;
  window.open(`${base}/${page}?entity_id=${entityId}`, "_blank");
}

interface ServiceAction {
  label: string;
  service: string;
  confirm?: boolean;
}

const ON_OFF_TOGGLE: ServiceAction[] = [
  { label: "Toggle", service: "toggle" },
  { label: "Turn on", service: "turn_on" },
  { label: "Turn off", service: "turn_off" },
];

const SERVICE_ACTIONS: Record<string, ServiceAction[]> = {
  light: ON_OFF_TOGGLE,
  switch: ON_OFF_TOGGLE,
  fan: ON_OFF_TOGGLE,
  input_boolean: ON_OFF_TOGGLE,
  humidifier: ON_OFF_TOGGLE,
  script: [
    { label: "Run", service: "turn_on" },
    { label: "Stop", service: "turn_off" },
  ],
  scene: [
    { label: "Activate", service: "turn_on" },
  ],
  automation: [
    { label: "Trigger", service: "trigger" },
    ...ON_OFF_TOGGLE,
  ],
  cover: [
    { label: "Open", service: "open_cover" },
    { label: "Close", service: "close_cover" },
    { label: "Stop", service: "stop_cover" },
    { label: "Toggle", service: "toggle" },
  ],
  lock: [
    { label: "Unlock", service: "unlock", confirm: true },
    { label: "Lock", service: "lock" },
  ],
  media_player: [
    { label: "Play/Pause", service: "media_play_pause" },
    { label: "Stop", service: "media_stop" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  vacuum: [
    { label: "Start", service: "start" },
    { label: "Pause", service: "pause" },
    { label: "Return to base", service: "return_to_base" },
    { label: "Stop", service: "stop" },
  ],
  button: [
    { label: "Press", service: "press" },
  ],
  input_button: [
    { label: "Press", service: "press" },
  ],
  remote: [
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  siren: [
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  water_heater: [
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  climate: [
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  valve: [
    { label: "Open", service: "open_valve" },
    { label: "Close", service: "close_valve" },
    { label: "Toggle", service: "toggle" },
  ],
};

async function callEntityService(domain: string, service: string, entityId: string): Promise<void> {
  if (!haConnection) {
    showToast(t("Not connected"));
    return;
  }
  try {
    await haConnection.sendMessagePromise({
      type: "call_service",
      domain,
      service,
      target: { entity_id: entityId },
    });
    showToast(t("Called {service}: {id}", { service: service.replace(/_/g, " "), id: entityId }));
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
    debugLog(t("system"), t("Service call failed: {call}", { call: `${domain}.${service}` }), msg);
    showToast(t("Failed: {msg}", { msg }));
  }
}

function showToast(message: string): void {
  const existing = getRootElement().querySelector("#force-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "force-toast";
  toast.className = "force-toast";
  toast.textContent = message;
  getRootElement().appendChild(toast);

  setTimeout(() => toast.classList.add("force-toast-visible"), 10);
  setTimeout(() => {
    toast.classList.remove("force-toast-visible");
    setTimeout(() => toast.remove(), 200);
  }, 1500);
}

function dismissContextMenu(): void {
  if (contextMenuDismissTimer !== null) {
    clearTimeout(contextMenuDismissTimer);
    contextMenuDismissTimer = null;
  }
  if (contextMenuDismiss) {
    document.removeEventListener("mousedown", contextMenuDismiss);
    contextMenuDismiss = null;
  }
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  dismissContextMenu();

  const n = hitTest(e.offsetX, e.offsetY);
  if (!n) return;
  const node = n.tree;
  const id = nodeActionId(node);
  if (!id) return;

  hideTooltip();

  const rootRect = getRootElement().getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "force-context-menu";
  menu.style.left = `${e.clientX - rootRect.left}px`;
  menu.style.top = `${e.clientY - rootRect.top}px`;

  function addItem(label: string, action: () => void): void {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", () => { action(); dismissContextMenu(); });
    menu.appendChild(btn);
  }

  function addSeparator(): void {
    const sep = document.createElement("div");
    sep.className = "force-context-menu-sep";
    menu.appendChild(sep);
  }

  if (node.entityId && node.domain) {
    const actions = SERVICE_ACTIONS[node.domain];
    if (actions && haConnection) {
      for (const a of actions) {
        addItem(t(a.label), () => {
          if (a.confirm && !window.confirm(`${t(a.label)}: ${node.entityId}?`)) return;
          callEntityService(node.domain!, a.service, node.entityId!);
        });
      }
      addSeparator();
    }
  }

  addItem(t("Copy ID: {id}", { id }), () => copyNodeId(node));

  const haBase = getHaUrl();
  if (haBase) {
    if (node.entityId) {
      addItem(t("View History"), () => openEntityPage(id, "history"));
      addItem(t("View Logbook"), () => openEntityPage(id, "logbook"));
    } else if (node.kind === "area") {
      addItem(t("Open Area in HA"), () => {
        window.open(`${haBase}/config/areas/area/${id}`, "_blank");
      });
    } else if (node.kind === "device") {
      addItem(t("Open Device in HA"), () => {
        window.open(`${haBase}/config/devices/device/${id}`, "_blank");
      });
      addItem(t("View Automations"), () => {
        window.open(`${haBase}/config/automation/dashboard?device_id=${id}`, "_blank");
      });
      addItem(t("View Logbook"), () => {
        const entityIds = node.children
          .filter((c) => c.entityId)
          .map((c) => c.entityId)
          .join(",");
        if (entityIds) {
          window.open(`${haBase}/logbook?entity_id=${entityIds}`, "_blank");
        } else {
          window.open(`${haBase}/logbook`, "_blank");
        }
      });
    }
  }

  if (isCollapsible(node)) {
    const collapsed = collapsedNodes.has(node.id);
    addItem(collapsed ? t("Expand") : t("Collapse"), () => {
      toggleCollapse(n);
    });
  }

  getRootElement().appendChild(menu);
  contextMenu = menu;

  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      dismissContextMenu();
    }
  };
  contextMenuDismiss = dismiss;
  contextMenuDismissTimer = window.setTimeout(() => {
    contextMenuDismissTimer = null;
    document.addEventListener("mousedown", dismiss);
  }, 0);
}
