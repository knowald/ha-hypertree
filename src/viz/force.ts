import type { Connection } from "home-assistant-js-websocket";
import type { TreeNode } from "../tree/types";
import type { HaState, Registries } from "../ha/types";
import { color, showTip, hideTip } from "./shared";
import { randomizeColors, resetColors, getDomainColors, setDomainColors, setDomainColor, domainList } from "../render/colors";
import { getEntityIconName, getCachedIcon, requestIcon, setIconResolveCallback } from "../render/icons";
import { createTransform, applyWheel, screenToWorld, type ZoomTransform } from "./zoom";
import { buildTree, buildTreeByDevice, flattenTree } from "../tree/build";
import { loadCredentials, saveCredentials } from "../login";
import { getRootElement } from "../rootElement";
import { updateFps, debugLog } from "../debug";
import { fetchAutomationEdges, type AutomationEdge, type AutomationRelation } from "../ha/automation";

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

type GroupMode = "area" | "domain";
type StructureMode = "domain" | "device";

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
let transform: ZoomTransform = createTransform();

const SETTINGS_KEY = "ha-hypertree-force-settings";

interface ForceSettings {
  showHulls: boolean;
  showLabels: boolean;
  showStructureLabels: boolean;
  showIcons: boolean;
  showEntities: boolean;
  showAutomationEdges: boolean;
  unavailableMode: UnavailableMode;
  changedOnly: boolean;
  constellation: boolean;
  groupBy: GroupMode;
  structureMode: StructureMode;
  starSize: number;
  glowIntensity: number;
  parentGlowIntensity: number;
  effectScale: number;
  twinkleSpeed: number;
  twinkleSize: number;
  twinkleMin: number;
  haloFalloff: number;
  lineGlow: number;
  glowBrightness: number;
  glowSize: number;
  starEffect: StarEffect;
  labelSize: number;
  entityDotSize: number;
  entityLabelZoom: number;
  repulsion: number;
  springLen: number;
  springK: number;
  damping: number;
  automationOnly: boolean;
  appearOnChange: boolean;
  backgroundColor: string;
  initialLayout: InitialLayout;
  hiddenDomains: string[];
  hiddenAreas: string[];
  stateFilter: string;
  searchAsFilter: boolean;
}

type StarEffect = "supernova" | "shooting-star" | "flare" | "pulse-wave" | "color-shift";
type UnavailableMode = "normal" | "pulse" | "ring" | "hidden" | "only";
type InitialLayout = "tree" | "scatter";
const defaults: ForceSettings = {
  showHulls: false,
  showLabels: true,
  showStructureLabels: true,
  showIcons: true,
  showEntities: true,
  showAutomationEdges: false,
  unavailableMode: "ring",
  changedOnly: true,
  constellation: true,
  groupBy: "area",
  structureMode: "domain",
  starSize: 1.4,
  glowIntensity: 0.6,
  parentGlowIntensity: 0.2,
  effectScale: 1.1,
  twinkleSpeed: 0,
  twinkleSize: 0.2,
  twinkleMin: 0.5,
  haloFalloff: 1,
  lineGlow: 0.7,
  glowBrightness: 0.7,
  glowSize: 14,
  starEffect: "supernova",
  labelSize: 16,
  entityDotSize: 16,
  entityLabelZoom: 2.5,
  repulsion: 3000,
  springLen: 64,
  springK: 0.035,
  damping: 0.8,
  automationOnly: false,
  backgroundColor: "#000000",
  appearOnChange: false,
  initialLayout: "tree",
  hiddenDomains: [],
  hiddenAreas: [],
  stateFilter: "",
  searchAsFilter: false,
};

function loadSettings(): ForceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate old boolean pulseUnavailable to unavailableMode
      if ("pulseUnavailable" in parsed && !("unavailableMode" in parsed)) {
        parsed.unavailableMode = parsed.pulseUnavailable ? "pulse" : "normal";
        delete parsed.pulseUnavailable;
      }
      return { ...defaults, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...defaults };
}

function saveSettings(): void {
  const s: ForceSettings = {
    showHulls, showLabels, showStructureLabels, showIcons, showEntities, showAutomationEdges, unavailableMode, changedOnly, constellation, groupBy, structureMode,
    starSize, glowIntensity, twinkleSpeed, twinkleSize, twinkleMin, haloFalloff, lineGlow, glowBrightness, glowSize,
    starEffect, parentGlowIntensity, effectScale,
    labelSize, entityDotSize, entityLabelZoom,
    repulsion, springLen, springK, damping,
    automationOnly, appearOnChange, backgroundColor, initialLayout,
    hiddenDomains, hiddenAreas, stateFilter, searchAsFilter,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const saved = loadSettings();
let showHulls = saved.showHulls;
let showLabels = saved.showLabels;
let showStructureLabels = saved.showStructureLabels;
let showIcons = saved.showIcons;
let showEntities = saved.showEntities;
let showAutomationEdges = saved.showAutomationEdges;
let unavailableMode: UnavailableMode = saved.unavailableMode;
let changedOnly = saved.changedOnly;
let constellation = saved.constellation;
let groupBy: GroupMode = saved.groupBy;
let structureMode: StructureMode = saved.structureMode;

let starSize = saved.starSize;
let glowIntensity = saved.glowIntensity;
let parentGlowIntensity = saved.parentGlowIntensity;
let effectScale = saved.effectScale;
let twinkleSpeed = saved.twinkleSpeed;
let twinkleSize = saved.twinkleSize;
let twinkleMin = saved.twinkleMin;
let haloFalloff = saved.haloFalloff;
let lineGlow = saved.lineGlow;
let glowBrightness = saved.glowBrightness;
let glowSize = saved.glowSize;

let starEffect: StarEffect = saved.starEffect;

let labelSize = saved.labelSize;
let entityDotSize = saved.entityDotSize;
let entityLabelZoom = saved.entityLabelZoom;

let hoveredNode: FNode | null = null;
let hoverStartTime = 0;
let searchQuery = "";
let didDrag = false;
let contextMenu: HTMLElement | null = null;
let contextMenuDismiss: ((ev: MouseEvent) => void) | null = null;
let contextMenuDismissTimer: number | null = null;
let onMouseLeave: (() => void) | null = null;

let repulsion = saved.repulsion;
let springLen = saved.springLen;
let springK = saved.springK;
let damping = saved.damping;
let alphaDecay = 0.998;
let alpha = 1;

let automationOnly = saved.automationOnly;
let appearOnChange = saved.appearOnChange;
let backgroundColor = saved.backgroundColor;
let initialLayout: InitialLayout = saved.initialLayout;
let hiddenDomains: string[] = saved.hiddenDomains;
let hiddenAreas: string[] = saved.hiddenAreas;
let stateFilter = saved.stateFilter;
let searchAsFilter = saved.searchAsFilter;
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
let spriteCacheVersion = 0;
let lastSpriteParams = "";

function getSpriteParams(): string {
  return `${glowIntensity}|${parentGlowIntensity}`;
}

function invalidateSpriteCache(): void {
  const params = getSpriteParams();
  if (params !== lastSpriteParams) {
    spriteCache.clear();
    lastSpriteParams = params;
    spriteCacheVersion++;
  }
}

interface StarSprite {
  halo: OffscreenCanvas;
  core: OffscreenCanvas;
  size: number;
}

function getStarSprite(nodeCol: string, intensity: number): StarSprite {
  const key = `${nodeCol}|${intensity}|${haloFalloff}|${spriteCacheVersion}`;
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

  const sigma = 0.15 + 0.55 * haloFalloff;
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
    name: "Force",

    create(container: HTMLElement, _root: TreeNode, states: Map<string, HaState>) {
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

      glassContainer = document.createElement("div");
      glassContainer.className = "glass-label-container";
      container.appendChild(glassContainer);

      settingsPanel = createSettings(container);

      const obs = new ResizeObserver(() => resize());
      obs.observe(container);
      (canvas as any).__obs = obs;

      const root = structureMode === "device"
        ? buildTreeByDevice(registries)
        : buildTree(registries);
      buildGraph(root);
      resize();
      if (showAutomationEdges || automationOnly) loadAutomationEdges();

      setIconResolveCallback(() => ensureLoop());

      onMouseLeave = () => { dragNode = null; panning = false; hoveredNode = null; hideTip(); };
      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", onMouseUp);
      canvas.addEventListener("mouseleave", onMouseLeave);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);

      frame = requestAnimationFrame(tick);
    },

    destroy() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (canvas) {
        (canvas as any).__obs?.disconnect();
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("mouseup", onMouseUp);
        if (onMouseLeave) canvas.removeEventListener("mouseleave", onMouseLeave);
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
      automationEdges = [];
      automationEdgesByEntity = new Map();
      automationLoaded = false;
      automationLoading = false;
      onAutomationLoaded = null;
      revealedNodes.clear();
      collapsedNodes.clear();
      stateChangeCounts.clear();
      allTreeNodesById = new Map();
      allEntityTreeNodes = new Map();
      pendingReveals = [];
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
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

      if (appearOnChange && allEntityTreeNodes.has(entityId)) {
        if (!automationOnly || automationEdgesByEntity.has(entityId)) {
          revealAncestorChain(entityId);
        }
      }

      if (changedOnly && oldValue !== undefined) {
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

function rebuildGraph(): void {
  if (!currentRegistries || !canvas) return;

  const root = structureMode === "device"
    ? buildTreeByDevice(currentRegistries)
    : buildTree(currentRegistries);

  alpha = 1;
  buildGraph(root);
}

function rebuildWithStructure(): void {
  rebuildGraph();

  automationLoaded = false;
  automationEdges = [];
  automationEdgesByEntity = new Map();
  if (showAutomationEdges || automationOnly) loadAutomationEdges();
}

const REVEAL_STAGGER_MS = 120;

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

  // Reverse so ancestors come first: area → domain/device → entity
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

  const r = treeNode.kind === "area" ? 8
    : (treeNode.kind === "domain" || treeNode.kind === "device") ? 6
      : entityDotSize;

  let hash = 0;
  for (let i = 0; i < treeNode.id.length; i++) hash = ((hash << 5) - hash + treeNode.id.charCodeAt(i)) | 0;
  const fn: FNode = {
    tree: treeNode,
    x: 0, y: 0,
    vx: 0, vy: 0,
    fx: null, fy: null,
    r,
    phase: (hash & 0xffff) / 0xffff * Math.PI * 2,
  };

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
  }

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

function createSettings(container: HTMLElement): { toolbar: HTMLDivElement } {
  // -- Canvas toolbar (always visible, top-right) --
  const toolbar = document.createElement("div");
  toolbar.className = "canvas-toolbar";
  container.appendChild(toolbar);

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "canvas-toolbar-search";
  searchInput.placeholder = "Search entities...";
  searchInput.value = searchQuery;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase();
    if (searchAsFilter) {
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
  filterBtn.title = "Filters";
  toolbar.appendChild(filterBtn);

  const resetPosBtn = document.createElement("button");
  resetPosBtn.className = "canvas-toolbar-btn";
  resetPosBtn.textContent = "\u21bb";
  resetPosBtn.title = "Reset positions";
  resetPosBtn.addEventListener("click", () => rebuildGraph());
  toolbar.appendChild(resetPosBtn);

  const gearBtn = document.createElement("button");
  gearBtn.className = "canvas-toolbar-btn";
  gearBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="1" y="2.5" width="14" height="1.5" rx="0.75"/><rect x="1" y="7.25" width="14" height="1.5" rx="0.75"/><rect x="1" y="12" width="14" height="1.5" rx="0.75"/><circle cx="5" cy="3.25" r="2" fill="var(--surface)" stroke="currentColor" stroke-width="1.2"/><circle cx="11" cy="8" r="2" fill="var(--surface)" stroke="currentColor" stroke-width="1.2"/><circle cx="6.5" cy="12.75" r="2" fill="var(--surface)" stroke="currentColor" stroke-width="1.2"/></svg>';
  gearBtn.title = "Settings";
  toolbar.appendChild(gearBtn);

  // -- Dropdown panels --
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  toolbar.appendChild(panel);

  const filterPanel = document.createElement("div");
  filterPanel.className = "settings-panel filter-panel-dropdown";
  toolbar.appendChild(filterPanel);

  function closeFilterPanel(): void {
    filterPanel.classList.remove("open");
    filterBtn.classList.remove("active");
  }

  function closeSettingsPanel(): void {
    panel.classList.remove("open");
    gearBtn.classList.remove("active");
  }

  gearBtn.addEventListener("click", () => {
    const opening = !panel.classList.contains("open");
    closeFilterPanel();
    panel.classList.toggle("open", opening);
    gearBtn.classList.toggle("active", opening);
  });

  filterBtn.addEventListener("click", () => {
    const opening = !filterPanel.classList.contains("open");
    closeSettingsPanel();
    filterPanel.classList.toggle("open", opening);
    filterBtn.classList.toggle("active", opening);
  });

  // -- Tab bar --
  const tabBar = document.createElement("div");
  tabBar.className = "settings-tabs";
  const tabNames = ["View", "Style", "Advanced"];
  const tabBtns: HTMLButtonElement[] = [];
  const tabPanels: HTMLDivElement[] = [];

  for (const name of tabNames) {
    const btn = document.createElement("button");
    btn.className = "settings-tab";
    btn.textContent = name;
    btn.type = "button";
    tabBar.appendChild(btn);
    tabBtns.push(btn);
  }
  panel.appendChild(tabBar);

  const body = document.createElement("div");
  body.className = "settings-body";
  panel.appendChild(body);

  for (const _name of tabNames) {
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

  const viewTab = tabPanels[0];
  const styleTab = tabPanels[1];
  const advancedTab = tabPanels[2];

  // -- Shared disabled state logic --
  let entitiesToggle!: HTMLLabelElement;
  let unavailableSelect!: HTMLLabelElement;
  let changedOnlyToggle!: HTMLLabelElement;
  let appearOnChangeToggle!: HTMLLabelElement;
  let autoOnlyToggle!: HTMLLabelElement;

  function setDisabled(el: HTMLElement, disabled: boolean): void {
    el.style.opacity = disabled ? "0.4" : "";
    const input = el.querySelector("input");
    const select = el.querySelector("select");
    if (input) input.disabled = disabled;
    if (select) select.disabled = disabled;
  }

  function syncSettingsState(): void {
    const entitiesOff = !showEntities;
    const aocOn = appearOnChange;
    setDisabled(entitiesToggle, aocOn);
    setDisabled(unavailableSelect, entitiesOff || aocOn);
    setDisabled(changedOnlyToggle, entitiesOff);
    setDisabled(appearOnChangeToggle, entitiesOff);
    setDisabled(autoOnlyToggle, entitiesOff || !automationLoaded || !showAutomationEdges);
  }

  // =====================
  // VIEW TAB
  // =====================

  viewTab.appendChild(makeSegmented("Structure", ["domain", "device"], structureMode, (v) => {
    structureMode = v as StructureMode;
    rebuildWithStructure();
    saveSettings();
  }));

  viewTab.appendChild(makeSegmented("Layout", ["tree", "scatter"], initialLayout, (v) => {
    initialLayout = v as InitialLayout;
    rebuildGraph();
    saveSettings();
  }, "Initial node positions: tree (structured) or scatter (random)"));

  // -- Visual mode radio (default / constellation / hulls / automations) --
  const visualModeGroup = document.createElement("div");
  visualModeGroup.className = "visual-mode-group";

  const currentVisualMode = showAutomationEdges ? "automations" : constellation ? "constellation" : showHulls ? "hulls" : "default";
  const visualModes = ["default", "constellation", "hulls", "automations"] as const;

  const constellationSubOptions = document.createElement("div");
  constellationSubOptions.className = "force-sub-options";
  constellationSubOptions.hidden = currentVisualMode !== "constellation";
  const hullSubOptions = document.createElement("div");
  hullSubOptions.className = "force-sub-options";
  hullSubOptions.hidden = currentVisualMode !== "hulls";
  const automationSubOptions = document.createElement("div");
  automationSubOptions.className = "force-sub-options";
  automationSubOptions.hidden = currentVisualMode !== "automations";

  function applyVisualMode(mode: string): void {
    constellation = mode === "constellation";
    showHulls = mode === "hulls";
    showAutomationEdges = mode === "automations";
    constellationSubOptions.hidden = mode !== "constellation";
    hullSubOptions.hidden = mode !== "hulls";
    automationSubOptions.hidden = mode !== "automations";
    if (mode === "automations" && !automationLoaded && !automationLoading) loadAutomationEdges();
    if (mode !== "automations" && automationOnly) {
      automationOnly = false;
      autoOnlyToggle.querySelector("input")!.checked = false;
      rebuildGraph();
    }
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
    label.appendChild(document.createTextNode(mode.charAt(0).toUpperCase() + mode.slice(1)));
    visualModeGroup.appendChild(label);

    if (mode === "constellation") visualModeGroup.appendChild(constellationSubOptions);
    if (mode === "hulls") visualModeGroup.appendChild(hullSubOptions);
    if (mode === "automations") visualModeGroup.appendChild(automationSubOptions);
  }

  constellationSubOptions.appendChild(makeSlider("Brightness", 0, 3, glowBrightness, 0.1, (v) => { glowBrightness = v; saveSettings(); }, "Overall star and edge opacity"));
  constellationSubOptions.appendChild(makeSlider("Star size", 0.2, 3, starSize, 0.1, (v) => { starSize = v; saveSettings(); }));
  constellationSubOptions.appendChild(makeSlider("Halo intensity", 0.2, 3, glowIntensity, 0.1, (v) => { glowIntensity = v; saveSettings(); }, "Glow gradient spread and strength"));
  constellationSubOptions.appendChild(makeSlider("Halo size", 2, 16, glowSize, 0.5, (v) => { glowSize = v; saveSettings(); }, "Base glow radius around stars"));
  constellationSubOptions.appendChild(makeSlider("Parent halo", 0.2, 5, parentGlowIntensity, 0.1, (v) => { parentGlowIntensity = v; saveSettings(); }, "Halo for area, domain, and device nodes"));
  constellationSubOptions.appendChild(makeSlider("Effect scale", 0.5, 5, effectScale, 0.1, (v) => { effectScale = v; saveSettings(); }, "Size of state-change effects"));
  constellationSubOptions.appendChild(makeSlider("Twinkle speed", 0, 5, twinkleSpeed, 0.1, (v) => { twinkleSpeed = v; saveSettings(); }));
  constellationSubOptions.appendChild(makeSlider("Twinkle size", 0, 1, twinkleSize, 0.05, (v) => { twinkleSize = v; saveSettings(); }, "Halo radius pulsing with twinkle"));
  constellationSubOptions.appendChild(makeSlider("Twinkle floor", 0, 1, twinkleMin, 0.05, (v) => { twinkleMin = v; saveSettings(); }, "Minimum brightness during twinkle dip"));
  constellationSubOptions.appendChild(makeSlider("Halo spread", 0, 1, haloFalloff, 0.05, (v) => { haloFalloff = v; saveSettings(); }, "Gaussian halo width: low = tight bright peak, high = broad soft glow"));
  constellationSubOptions.appendChild(makeSelect("Effect",
    ["supernova", "shooting-star", "flare", "pulse-wave", "color-shift"],
    starEffect, (v) => { starEffect = v as StarEffect; saveSettings(); }, "Animation on entity state change"));

  hullSubOptions.appendChild(makeSegmented("Grouping", ["area", "domain"], groupBy, (v) => {
    groupBy = v as GroupMode;
    rebuildClusters();
    saveSettings();
  }));

  autoOnlyToggle = makeToggle("Automation entities only", automationOnly, (v) => {
    automationOnly = v;
    saveSettings();
    if (v && !automationLoaded && !automationLoading) {
      loadAutomationEdges();
    } else {
      rebuildGraph();
    }
  }, "Hide entities not referenced by any automation");
  automationSubOptions.appendChild(autoOnlyToggle);

  onAutomationLoaded = () => {
    syncSettingsState();
    if (automationOnly) rebuildGraph();
  };

  viewTab.appendChild(visualModeGroup);

  // -- Entities + sub-options --
  entitiesToggle = makeToggle("Entities", showEntities, (v) => {
    showEntities = v;
    entitiesSubOptions.hidden = !v;
    if (!v) {
      if (appearOnChange) {
        appearOnChange = false;
        appearOnChangeToggle.querySelector("input")!.checked = false;
        revealedNodes.clear();
        pendingReveals = [];
        if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      }
      if (automationOnly) {
        automationOnly = false;
        autoOnlyToggle.querySelector("input")!.checked = false;
      }
    }
    syncSettingsState();
    rebuildGraph();
    saveSettings();
  });
  viewTab.appendChild(entitiesToggle);

  const entitiesSubOptions = document.createElement("div");
  entitiesSubOptions.className = "force-sub-options";
  entitiesSubOptions.hidden = !showEntities;

  unavailableSelect = makeSelect("Unavailable", ["normal", "pulse", "ring", "hidden", "only"], unavailableMode, (v) => {
    const prev = unavailableMode;
    unavailableMode = v as UnavailableMode;
    if (v === "hidden" || prev === "hidden" || v === "only" || prev === "only") rebuildGraph();
    ensureLoop();
    saveSettings();
  });
  entitiesSubOptions.appendChild(unavailableSelect);

  appearOnChangeToggle = makeToggle("Appear on change", appearOnChange, (v) => {
    appearOnChange = v;
    if (v) {
      showEntities = true;
      entitiesToggle.querySelector("input")!.checked = true;
    } else {
      revealedNodes.clear();
      pendingReveals = [];
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    }
    syncSettingsState();
    rebuildGraph();
    saveSettings();
  }, "Nodes start hidden and appear as state changes arrive");
  entitiesSubOptions.appendChild(appearOnChangeToggle);
  viewTab.appendChild(entitiesSubOptions);

  // -- Filter panel contents --
  const filterBody = document.createElement("div");
  filterBody.className = "settings-body";
  filterPanel.appendChild(filterBody);

  // Search as filter toggle
  filterBody.appendChild(makeToggle("Search hides non-matching", searchAsFilter, (v) => {
    searchAsFilter = v;
    saveSettings();
    if (searchQuery) rebuildGraph();
  }, "When enabled, the search bar hides nodes instead of highlighting them"));

  // Domain filter
  const domainSection = makeSection("Domains");

  const domainActions = document.createElement("div");
  domainActions.className = "filter-actions";
  const domainAllBtn = document.createElement("button");
  domainAllBtn.className = "force-reset-btn";
  domainAllBtn.textContent = "All";
  domainAllBtn.style.cssText = "flex:1;padding:0.2rem 0";
  const domainNoneBtn = document.createElement("button");
  domainNoneBtn.className = "force-reset-btn";
  domainNoneBtn.textContent = "None";
  domainNoneBtn.style.cssText = "flex:1;padding:0.2rem 0";
  domainActions.appendChild(domainAllBtn);
  domainActions.appendChild(domainNoneBtn);
  domainSection.body.appendChild(domainActions);

  const domainGrid = document.createElement("div");
  domainGrid.className = "filter-grid";
  domainSection.body.appendChild(domainGrid);

  const domains = domainList().sort();
  const domainCheckboxes: { domain: string; checkbox: HTMLInputElement }[] = [];

  for (const d of domains) {
    const item = document.createElement("label");
    item.className = "filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hiddenDomains.includes(d);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        hiddenDomains = hiddenDomains.filter((x) => x !== d);
      } else {
        hiddenDomains = [...hiddenDomains, d];
      }
      saveSettings();
      rebuildGraph();
    });
    const label = document.createElement("span");
    label.className = "filter-domain";
    label.textContent = d;
    item.appendChild(cb);
    item.appendChild(label);
    domainGrid.appendChild(item);
    domainCheckboxes.push({ domain: d, checkbox: cb });
  }

  domainAllBtn.addEventListener("click", () => {
    hiddenDomains = [];
    for (const { checkbox } of domainCheckboxes) checkbox.checked = true;
    saveSettings();
    rebuildGraph();
  });
  domainNoneBtn.addEventListener("click", () => {
    hiddenDomains = domains.slice();
    for (const { checkbox } of domainCheckboxes) checkbox.checked = false;
    saveSettings();
    rebuildGraph();
  });
  filterBody.appendChild(domainSection.el);

  // Area filter
  const areaSection = makeSection("Areas");

  const areaActions = document.createElement("div");
  areaActions.className = "filter-actions";
  const areaAllBtn = document.createElement("button");
  areaAllBtn.className = "force-reset-btn";
  areaAllBtn.textContent = "All";
  areaAllBtn.style.cssText = "flex:1;padding:0.2rem 0";
  const areaNoneBtn = document.createElement("button");
  areaNoneBtn.className = "force-reset-btn";
  areaNoneBtn.textContent = "None";
  areaNoneBtn.style.cssText = "flex:1;padding:0.2rem 0";
  areaActions.appendChild(areaAllBtn);
  areaActions.appendChild(areaNoneBtn);
  areaSection.body.appendChild(areaActions);

  const areaGrid = document.createElement("div");
  areaGrid.className = "filter-grid";
  areaSection.body.appendChild(areaGrid);

  const filterRoot = structureMode === "device"
    ? buildTreeByDevice(currentRegistries!)
    : buildTree(currentRegistries!);
  const areas = filterRoot.children.filter((c) => c.kind === "area").sort((a, b) => a.label.localeCompare(b.label));
  const areaCheckboxes: { areaId: string; checkbox: HTMLInputElement }[] = [];

  for (const area of areas) {
    const areaId = area.id.replace(/^area:/, "");
    const item = document.createElement("label");
    item.className = "filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hiddenAreas.includes(areaId);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        hiddenAreas = hiddenAreas.filter((x) => x !== areaId);
      } else {
        hiddenAreas = [...hiddenAreas, areaId];
      }
      saveSettings();
      rebuildGraph();
    });
    const label = document.createElement("span");
    label.className = "filter-domain";
    label.textContent = area.label;
    item.appendChild(cb);
    item.appendChild(label);
    areaGrid.appendChild(item);
    areaCheckboxes.push({ areaId, checkbox: cb });
  }

  areaAllBtn.addEventListener("click", () => {
    hiddenAreas = [];
    for (const { checkbox } of areaCheckboxes) checkbox.checked = true;
    saveSettings();
    rebuildGraph();
  });
  areaNoneBtn.addEventListener("click", () => {
    hiddenAreas = areas.map((a) => a.id.replace(/^area:/, ""));
    for (const { checkbox } of areaCheckboxes) checkbox.checked = false;
    saveSettings();
    rebuildGraph();
  });
  filterBody.appendChild(areaSection.el);

  // State filter
  const stateSection = makeSection("State");

  const stateInputWrap = document.createElement("div");
  stateInputWrap.style.cssText = "position:relative";
  const stateInput = document.createElement("input");
  stateInput.type = "text";
  stateInput.className = "force-search";
  stateInput.placeholder = "Filter by state (e.g. on, off)";
  stateInput.value = stateFilter;
  const stateClearBtn = document.createElement("button");
  stateClearBtn.textContent = "\u00d7";
  stateClearBtn.style.cssText = "position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;padding:0 4px;display:" + (stateFilter ? "block" : "none");
  stateClearBtn.addEventListener("click", () => {
    stateFilter = "";
    stateInput.value = "";
    stateClearBtn.style.display = "none";
    saveSettings();
    rebuildGraph();
  });
  let stateDebounce: ReturnType<typeof setTimeout> | null = null;
  stateInput.addEventListener("input", () => {
    stateFilter = stateInput.value.trim();
    stateClearBtn.style.display = stateFilter ? "block" : "none";
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

  // =====================
  // STYLE TAB
  // =====================

  styleTab.appendChild(makeToggle("Labels", showLabels, (v) => { showLabels = v; saveSettings(); }));
  styleTab.appendChild(makeToggle(
    "Structure labels",
    showStructureLabels,
    (v) => { showStructureLabels = v; saveSettings(); },
    "Show labels on grouping nodes (domains in domain mode, devices in device mode)"
  ));
  styleTab.appendChild(makeToggle(
    "Entity icons",
    showIcons,
    (v) => { showIcons = v; saveSettings(); },
    "Render Material Design Icons on entity nodes (resolved from Home Assistant)"
  ));
  changedOnlyToggle = makeToggle("Skip unchanged", changedOnly, (v) => {
    changedOnly = v;
    saveSettings();
  }, "Skip glow when state value hasn't changed");
  styleTab.appendChild(changedOnlyToggle);

  syncSettingsState();

  styleTab.appendChild(makeSlider("Label size", 4, 24, labelSize, 1, (v) => { labelSize = v; saveSettings(); }));
  styleTab.appendChild(makeSlider("Entity label zoom", 0.5, 5, entityLabelZoom, 0.1, (v) => { entityLabelZoom = v; saveSettings(); }, "Zoom level to show entity labels"));
  styleTab.appendChild(makeSlider("Entity dot size", 1, 16, entityDotSize, 0.5, (v) => {
    entityDotSize = v;
    for (const fn of fnodes) {
      if (fn.tree.kind === "entity") fn.r = v;
    }
    saveSettings();
  }));
  styleTab.appendChild(makeSlider("Connection brightness", 0, 3, lineGlow, 0.1, (v) => { lineGlow = v; saveSettings(); }, "Opacity of parent-child connection lines"));

  // -- Colors --
  const colorsSection = makeSection("Colors");

  const bgSwatch = document.createElement("label");
  bgSwatch.className = "force-color-swatch";
  bgSwatch.title = "Background";
  const bgDot = document.createElement("span");
  bgDot.className = "force-color-dot";
  bgDot.style.background = backgroundColor;
  const bgInput = document.createElement("input");
  bgInput.type = "color";
  bgInput.value = backgroundColor;
  bgInput.addEventListener("input", () => {
    backgroundColor = bgInput.value;
    bgDot.style.background = bgInput.value;
    saveSettings();
    ensureLoop();
  });
  const bgName = document.createElement("span");
  bgName.className = "force-color-name";
  bgName.textContent = "background";
  bgSwatch.appendChild(bgDot);
  bgSwatch.appendChild(bgName);
  bgSwatch.appendChild(bgInput);
  colorsSection.body.appendChild(bgSwatch);

  const colorGrid = document.createElement("div");
  colorGrid.className = "force-color-grid";
  for (const domain of domainList()) {
    const swatch = document.createElement("label");
    swatch.className = "force-color-swatch";
    swatch.title = domain;

    const dot = document.createElement("span");
    dot.className = "force-color-dot";
    dot.style.background = getDomainColors()[domain];

    const input = document.createElement("input");
    input.type = "color";
    input.value = getDomainColors()[domain];
    input.addEventListener("input", () => {
      dot.style.background = input.value;
      setDomainColor(domain, input.value);
      spriteCache.clear();
      ensureLoop();
    });

    const name = document.createElement("span");
    name.className = "force-color-name";
    name.textContent = domain.replace(/_/g, " ");

    swatch.appendChild(dot);
    swatch.appendChild(name);
    swatch.appendChild(input);
    colorGrid.appendChild(swatch);
  }
  colorsSection.body.appendChild(colorGrid);

  function syncColorSwatches(): void {
    const colors = getDomainColors();
    for (const swatch of colorGrid.children) {
      const el = swatch as HTMLLabelElement;
      const d = el.title;
      const dot = el.querySelector(".force-color-dot") as HTMLSpanElement;
      const inp = el.querySelector("input") as HTMLInputElement;
      if (dot && inp && d in colors) {
        dot.style.background = colors[d];
        inp.value = colors[d];
      }
    }
  }

  styleTab.appendChild(colorsSection.el);

  // =====================
  // ADVANCED TAB
  // =====================

  // -- Physics --
  const physicsSection = makeSection("Physics");
  physicsSection.body.appendChild(makeSlider("Repulsion", 100, 3000, repulsion, 10, (v) => { repulsion = v; reheat(); saveSettings(); }));
  physicsSection.body.appendChild(makeSlider("Spring length", 10, 120, springLen, 1, (v) => { springLen = v; reheat(); saveSettings(); }));
  physicsSection.body.appendChild(makeSlider("Spring stiffness", 0.005, 0.15, springK, 0.005, (v) => { springK = v; reheat(); saveSettings(); }, "Pull strength between connected nodes"));
  physicsSection.body.appendChild(makeSlider("Damping", 0.5, 0.99, damping, 0.01, (v) => { damping = v; reheat(); saveSettings(); }, "Velocity decay per frame"));
  advancedTab.appendChild(physicsSection.el);

  // -- Actions --
  const buttons = document.createElement("div");
  buttons.className = "force-buttons";

  const randomColorBtn = document.createElement("button");
  randomColorBtn.className = "force-reset-btn";
  randomColorBtn.textContent = "Randomize colors";
  randomColorBtn.addEventListener("click", () => {
    randomizeColors();
    spriteCache.clear();
    syncColorSwatches();
    ensureLoop();
  });
  buttons.appendChild(randomColorBtn);

  const resetAllBtn = document.createElement("button");
  resetAllBtn.className = "force-reset-btn";
  resetAllBtn.textContent = "Reset all settings";
  resetAllBtn.addEventListener("click", () => {
    resetColors();
    spriteCache.clear();
    Object.assign(saved, defaults);
    showHulls = defaults.showHulls;
    showLabels = defaults.showLabels;
    showStructureLabels = defaults.showStructureLabels;
    showIcons = defaults.showIcons;
    showEntities = defaults.showEntities;
    showAutomationEdges = defaults.showAutomationEdges;
    unavailableMode = defaults.unavailableMode;
    changedOnly = defaults.changedOnly;
    constellation = defaults.constellation;
    groupBy = defaults.groupBy;
    structureMode = defaults.structureMode;
    starSize = defaults.starSize;
    glowIntensity = defaults.glowIntensity;
    parentGlowIntensity = defaults.parentGlowIntensity;
    effectScale = defaults.effectScale;
    twinkleSpeed = defaults.twinkleSpeed;
    twinkleSize = defaults.twinkleSize;
    twinkleMin = defaults.twinkleMin;
    haloFalloff = defaults.haloFalloff;
    lineGlow = defaults.lineGlow;
    glowBrightness = defaults.glowBrightness;
    glowSize = defaults.glowSize;
    starEffect = defaults.starEffect;
    labelSize = defaults.labelSize;
    entityDotSize = defaults.entityDotSize;
    entityLabelZoom = defaults.entityLabelZoom;
    repulsion = defaults.repulsion;
    springLen = defaults.springLen;
    springK = defaults.springK;
    damping = defaults.damping;
    automationOnly = defaults.automationOnly;
    appearOnChange = defaults.appearOnChange;
    backgroundColor = defaults.backgroundColor;
    initialLayout = defaults.initialLayout;
    hiddenDomains = [];
    hiddenAreas = [];
    stateFilter = "";
    searchAsFilter = false;
    revealedNodes.clear();
    collapsedNodes.clear();
    pendingReveals = [];
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    stateChangeCounts.clear();
    searchQuery = "";
    searchInput.value = "";
    automationEdges = [];
    automationEdgesByEntity = new Map();
    automationLoaded = false;
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
  exportBtn.textContent = "Export settings";
  exportBtn.addEventListener("click", () => {
    const data = { settings: loadSettings(), colors: getDomainColors() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hypertree-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Settings exported");
  });
  buttons.appendChild(exportBtn);

  const importBtn = document.createElement("button");
  importBtn.className = "force-reset-btn";
  importBtn.textContent = "Import settings";
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
          if (data.settings) {
            const merged = { ...defaults, ...data.settings };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
          }
          if (data.colors) setDomainColors(data.colors);
          spriteCache.clear();
          const s = loadSettings();
          showHulls = s.showHulls;
          showLabels = s.showLabels;
          showStructureLabels = s.showStructureLabels;
          showIcons = s.showIcons;
          showEntities = s.showEntities;
          showAutomationEdges = s.showAutomationEdges;
          unavailableMode = s.unavailableMode;
          changedOnly = s.changedOnly;
          constellation = s.constellation;
          groupBy = s.groupBy;
          structureMode = s.structureMode;
          starSize = s.starSize;
          glowIntensity = s.glowIntensity;
          parentGlowIntensity = s.parentGlowIntensity;
          effectScale = s.effectScale;
          twinkleSpeed = s.twinkleSpeed;
          twinkleSize = s.twinkleSize;
          twinkleMin = s.twinkleMin;
          haloFalloff = s.haloFalloff;
          lineGlow = s.lineGlow;
          glowBrightness = s.glowBrightness;
          glowSize = s.glowSize;
          starEffect = s.starEffect;
          labelSize = s.labelSize;
          entityDotSize = s.entityDotSize;
          entityLabelZoom = s.entityLabelZoom;
          repulsion = s.repulsion;
          springLen = s.springLen;
          springK = s.springK;
          damping = s.damping;
          automationOnly = s.automationOnly;
          appearOnChange = s.appearOnChange;
          backgroundColor = s.backgroundColor;
          initialLayout = s.initialLayout;
          hiddenDomains = s.hiddenDomains;
          hiddenAreas = s.hiddenAreas;
          stateFilter = s.stateFilter;
          searchAsFilter = s.searchAsFilter;
          removeSettings();
          settingsPanel = createSettings(container);
          rebuildWithStructure();
          showToast("Settings imported");
        } catch {
          showToast("Invalid settings file");
        }
      });
    });
    input.click();
  });
  buttons.appendChild(importBtn);

  advancedTab.appendChild(buttons);

  // -- Connection (standalone only) --
  if (reconnectCallback) {
    const connectionSection = makeSection("Connection");

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
    tokenInput.placeholder = "Long-lived access token";
    tokenInput.value = savedCreds?.token ?? "";
    connectionSection.body.appendChild(tokenInput);

    const reconnectBtn = document.createElement("button");
    reconnectBtn.className = "force-reset-btn";
    reconnectBtn.textContent = "Reconnect";
    reconnectBtn.addEventListener("click", () => {
      const url = urlInput.value.trim();
      const token = tokenInput.value.trim();
      if (!url || !token) return;
      saveCredentials({ url, token });
      reconnectCallback!({ url, token });
    });
    connectionSection.body.appendChild(reconnectBtn);

    advancedTab.appendChild(connectionSection.el);
  }

  return { toolbar };
}

function makeToggle(label: string, initial: boolean, onChange: (v: boolean) => void, tooltip?: string): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "toggle-label";
  if (tooltip) el.title = tooltip;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = initial;
  input.addEventListener("change", () => onChange(input.checked));
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
    option.textContent = opt;
    if (opt === initial) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
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
    btn.textContent = opt;
    if (opt === initial) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (btn.classList.contains("active")) return;
      for (const b of buttons) b.classList.remove("active");
      btn.classList.add("active");
      onChange(opt);
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

  debugLog("system", `Automation: found ${automationEntityIds.length} automation entities in registry`);

  const knownEntityIds = new Set(allEntityTreeNodes.keys());

  try {
    automationEdges = await fetchAutomationEdges(haConnection, automationEntityIds, knownEntityIds);
    debugLog("system", `Automation: fetched ${automationEdges.length} edges`);
  } catch (err) {
    debugLog("system", `Automation: fetch failed`, String(err));
    automationEdges = [];
  }

  automationEdgesByEntity = new Map();
  for (const edge of automationEdges) {
    let list = automationEdgesByEntity.get(edge.automationEntityId);
    if (!list) { list = []; automationEdgesByEntity.set(edge.automationEntityId, list); }
    list.push(edge);

    list = automationEdgesByEntity.get(edge.targetEntityId);
    if (!list) { list = []; automationEdgesByEntity.set(edge.targetEntityId, list); }
    list.push(edge);
  }

  automationLoaded = true;
  automationLoading = false;
  if (onAutomationLoaded) onAutomationLoaded();
  ensureLoop();
}

function drawAutomationEdges(drawCtx: CanvasRenderingContext2D): void {
  if (!showAutomationEdges || automationEdges.length === 0) return;

  const invK = 1 / transform.k;
  const hoveredEntityId = hoveredNode?.tree.entityId;
  const hoveredEdges = hoveredEntityId ? automationEdgesByEntity.get(hoveredEntityId) : undefined;
  const hasHoveredEdges = hoveredEdges && hoveredEdges.length > 0;

  for (const edge of automationEdges) {
    const sourceNode = entityNodeMap.get(edge.automationEntityId);
    const targetNode = entityNodeMap.get(edge.targetEntityId);
    if (!sourceNode || !targetNode) continue;

    const isConnected = hasHoveredEdges && (
      edge.automationEntityId === hoveredEntityId || edge.targetEntityId === hoveredEntityId
    );

    const lineAlpha = hasHoveredEdges ? (isConnected ? 0.85 : 0.15) : 0.5;
    const lineWidth = (hasHoveredEdges && isConnected ? 2.5 : 1.5) * invK;

    drawCtx.globalAlpha = lineAlpha;
    drawCtx.strokeStyle = AUTOMATION_COLORS[edge.relation];
    drawCtx.lineWidth = lineWidth;
    drawCtx.setLineDash(AUTOMATION_DASHES[edge.relation].map((v) => v * invK));

    drawCtx.beginPath();
    drawCtx.moveTo(sourceNode.x, sourceNode.y);
    drawCtx.lineTo(targetNode.x, targetNode.y);
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
      let list = byRelation.get(edge.relation);
      if (!list) { list = []; byRelation.set(edge.relation, list); }
      list.push(edge.targetEntityId);
    }

    if (byRelation.size === 0) return "";

    let html = `<br><span style="color:#9e9e9e;font-size:0.7rem">References:</span>`;
    for (const [relation, ids] of byRelation) {
      const colorHex = AUTOMATION_COLORS[relation];
      html += `<br><span style="color:${colorHex};font-size:0.7rem">${relation}:</span> `;
      html += `<span style="color:#bbb;font-size:0.7rem">${ids.join(", ")}</span>`;
    }
    return html;
  }

  // Target entity: show which automations reference it
  const byAutomation = new Map<string, AutomationRelation[]>();
  for (const edge of edges) {
    if (edge.targetEntityId !== entityId) continue;
    let list = byAutomation.get(edge.automationEntityId);
    if (!list) { list = []; byAutomation.set(edge.automationEntityId, list); }
    list.push(edge.relation);
  }

  if (byAutomation.size === 0) return "";

  let html = `<br><span style="color:#9e9e9e;font-size:0.7rem">Used by automations:</span>`;
  for (const [autoId, relations] of byAutomation) {
    const state = currentStates.get(autoId);
    const name = state?.attributes.friendly_name ?? autoId;
    const relLabels = relations.map((r) =>
      `<span style="color:${AUTOMATION_COLORS[r]}">${r}</span>`
    ).join(", ");
    html += `<br><span style="font-size:0.7rem">${relLabels} in ${name}</span>`;
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

  let nodes: TreeNode[];
  if (!showEntities) {
    nodes = allNodes.filter((n) => n.kind !== "entity");
  } else if (unavailableMode === "hidden") {
    nodes = allNodes.filter((n) => {
      if (n.kind !== "entity" || !n.entityId) return true;
      const state = currentStates.get(n.entityId);
      return !(state && state.state === "unavailable");
    });
  } else if (unavailableMode === "only") {
    nodes = allNodes.filter((n) => {
      if (n.kind !== "entity") return true;
      if (!n.entityId) return false;
      const state = currentStates.get(n.entityId);
      return state !== undefined && state.state === "unavailable";
    });
  } else {
    nodes = allNodes;
  }

  if (appearOnChange) {
    nodes = nodes.filter((n) => {
      if (n.kind === "root") return true;
      return revealedNodes.has(n.id);
    });
  }

  if (automationOnly) {
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity") return true;
      return n.entityId !== undefined && automationEdgesByEntity.has(n.entityId);
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (hiddenDomains.length > 0) {
    const hidden = new Set(hiddenDomains);
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity" || !n.domain) return true;
      return !hidden.has(n.domain);
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (hiddenAreas.length > 0) {
    const hidden = new Set(hiddenAreas.map((a) => `area:${a}`));
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

  if (stateFilter !== "") {
    const filter = stateFilter.toLowerCase();
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity" || !n.entityId) return true;
      const state = currentStates.get(n.entityId);
      return state !== undefined && state.state.toLowerCase() === filter;
    });
    nodes = pruneEmptyBranches(nodes);
  }

  if (searchAsFilter && searchQuery) {
    nodes = nodes.filter((n) => {
      if (n.kind !== "entity") return true;
      const label = n.label.toLowerCase();
      const id = (n.entityId ?? n.id).toLowerCase();
      return label.includes(searchQuery) || id.includes(searchQuery);
    });
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

  const map = new Map<TreeNode, FNode>();
  const cx = width / 2 || 400;
  const cy = height / 2 || 300;

  // Radial tree layout for initial positions (when layout is "tree")
  const positions = new Map<TreeNode, { x: number; y: number }>();
  if (initialLayout === "tree") {
    const nodeSet = new Set(nodes);
    function layoutRadial(node: TreeNode, x: number, y: number, angleStart: number, angleSpan: number, depth: number): void {
      positions.set(node, { x, y });
      const children = node.children.filter((c) => nodeSet.has(c));
      if (children.length === 0) return;
      const radius = springLen * (depth === 0 ? 1.5 : 1);
      let offset = angleStart;
      const totalLeaves = children.reduce((s, c) => s + Math.max(1, c.leafCount), 0);
      for (const child of children) {
        const share = (Math.max(1, child.leafCount) / totalLeaves) * angleSpan;
        const angle = offset + share / 2;
        layoutRadial(child, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, offset, share, depth + 1);
        offset += share;
      }
    }
    const rootNode = nodes.find((n) => n.kind === "root");
    if (rootNode) layoutRadial(rootNode, cx, cy, 0, Math.PI * 2, 0);
  }

  fnodes = nodes.map((n) => {
    const r = n.kind === "root" ? 10 : n.kind === "area" ? 8
      : (n.kind === "domain" || n.kind === "device") ? 6 : entityDotSize;
    let hash = 0;
    for (let i = 0; i < n.id.length; i++) hash = ((hash << 5) - hash + n.id.charCodeAt(i)) | 0;
    const pos = positions.get(n);
    const fn: FNode = {
      tree: n,
      x: pos ? pos.x : cx + (Math.random() - 0.5) * 600,
      y: pos ? pos.y : cy + (Math.random() - 0.5) * 400,
      vx: 0, vy: 0,
      fx: null, fy: null,
      r,
      phase: (hash & 0xffff) / 0xffff * Math.PI * 2,
    };
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
  rebuildClusters();

  if (initialLayout === "tree") {
    for (let i = 0; i < 150; i++) {
      simulate();
      alpha *= alphaDecay;
    }
  }
}

function resize(): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
}

function tick(): void {
  if (!canvas) return;

  updateFps(performance.now());

  if (alpha > 0.001) {
    simulate();
    alpha *= alphaDecay;
  }

  draw();

  const needsAnimation = alpha > 0.001 || glowTimestamps.size > 0 || dragNode !== null || panning || constellation || unavailableMode === "pulse";
  if (needsAnimation) {
    frame = requestAnimationFrame(tick);
  } else {
    frame = 0;
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

  // Barnes-Hut criterion: cell width / distance < theta → approximate
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
  const ra = repulsion * alpha;

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
    const f = (d - springLen) * springK * alpha;
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
    else { n.vx *= damping; n.x += n.vx; }
    if (n.fy !== null) { n.y = n.fy; n.vy = 0; }
    else { n.vy *= damping; n.y += n.vy; }
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
  const fontFamily = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif";
  const entityFontSize = labelSize / transform.k;
  const parentFontSize = (labelSize * 1.4) / transform.k;
  const pad = 3 / transform.k;
  const radius = 3 / transform.k;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  let glassIndex = 0;

  for (const n of fnodes) {
    const kind = n.tree.kind;
    const isEntity = kind === "entity";
    const isArea = kind === "area";
    const isMiddle = kind === "domain" || kind === "device";
    const isGlass = kind === "root" || isArea;

    if (isEntity && transform.k < entityLabelZoom) continue;
    if (isMiddle && !showStructureLabels) continue;

    let labelAlpha = 1;
    if (isEntity) {
      labelAlpha = Math.min(1, (transform.k - entityLabelZoom) / 0.5);
    }

    const alpha = Math.max(0.3, labelAlpha);
    const middleFontSize = labelSize * 1.15;
    const middlePad = 3;
    const middleRadius = 3;
    const middleGap = 2;

    if (kind === "root") {
      ctx.font = `700 ${parentFontSize * 1.2}px ${fontFamily}`;
    } else if (isArea) {
      ctx.font = `600 ${parentFontSize}px ${fontFamily}`;
    } else if (isMiddle) {
      ctx.font = `500 ${middleFontSize}px ${fontFamily}`;
    } else {
      ctx.font = `${entityFontSize}px ${fontFamily}`;
    }

    const gap = isMiddle ? middleGap : 2 / transform.k;
    const labelY = n.y + n.r + gap;
    const metrics = ctx.measureText(n.tree.label);
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const textH = ascent + descent;
    const textY = labelY + ascent;
    const labelPad = isMiddle ? middlePad : pad;
    const labelRadius = isMiddle ? middleRadius : radius;

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
      const baseFontSize = kind === "root" ? labelSize * 1.4 * 1.2 : labelSize * 1.4;
      const screenFontSize = baseFontSize * transform.k;
      const padY = 2 * transform.k;
      const padX = 8 * transform.k;
      const weight = kind === "root" ? "700" : "600";
      div.textContent = n.tree.label;
      div.style.left = `${screenX}px`;
      div.style.top = `${screenY}px`;
      div.style.fontSize = `${screenFontSize}px`;
      div.style.padding = `${padY}px ${padX}px`;
      div.style.fontWeight = weight;
      div.style.opacity = String(alpha);
      div.style.display = "";
    } else {
      // Canvas roundRect background for domain/device/entity labels
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.roundRect(
        n.x - metrics.width / 2 - labelPad,
        textY - ascent - labelPad,
        metrics.width + labelPad * 2,
        textH + labelPad * 2,
        labelRadius
      );
      ctx.fill();

      ctx.globalAlpha = alpha;
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
  // Expand shorthand #rgb to #rrggbb before appending alpha
  if (hex.length === 4) {
    hex = "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex + "00";
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

function matchesSearch(fn: FNode): boolean {
  if (!searchQuery) return false;
  const label = fn.tree.label.toLowerCase();
  const id = (fn.tree.entityId ?? fn.tree.id).toLowerCase();
  return label.includes(searchQuery) || id.includes(searchQuery);
}

function drawSearchHighlights(ctx: CanvasRenderingContext2D): void {
  if (!searchQuery) return;

  for (const fn of fnodes) {
    if (!matchesSearch(fn)) continue;

    const nodeCol = color(fn.tree);
    const highlightR = fn.r * 3;

    const glow = ctx.createRadialGradient(fn.x, fn.y, fn.r, fn.x, fn.y, highlightR);
    glow.addColorStop(0, nodeCol);
    glow.addColorStop(1, transparent(nodeCol));
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(fn.x, fn.y, highlightR, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(fn.x, fn.y, fn.r + 2 / transform.k, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff";
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2 / transform.k;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function drawHoverHighlight(ctx: CanvasRenderingContext2D, fn: FNode): void {
  const nodeCol = color(fn.tree);
  const haloR = fn.r * 2.5;

  const glow = ctx.createRadialGradient(fn.x, fn.y, fn.r, fn.x, fn.y, haloR);
  glow.addColorStop(0, nodeCol);
  glow.addColorStop(1, transparent(nodeCol));
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, haloR, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(fn.x, fn.y, fn.r + 1.5 / transform.k, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.5 / transform.k;
  ctx.stroke();

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
    ctx.globalAlpha = opacity * 0.2 * glowBrightness;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(fn.x, fn.y, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = nodeColor;
    ctx.globalAlpha = opacity * 0.9 * glowBrightness;
    ctx.lineWidth = (3 + 4 * (1 - progress)) / transform.k;
    ctx.stroke();

    if (progress < 0.4) {
      const flashOpacity = 1 - progress / 0.4;
      ctx.beginPath();
      ctx.arc(fn.x, fn.y, fn.r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = flashOpacity * 0.5 * glowBrightness;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  for (const fn of expired) {
    glowTimestamps.delete(fn);
  }
}

function drawGlowLine(
  ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number,
  lineColor: string, alpha: number, width: number
): void {
  ctx.globalAlpha = alpha * 0.15 * lineGlow;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = width * 6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.globalAlpha = alpha * 0.4 * lineGlow;
  ctx.lineWidth = width * 2.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.globalAlpha = alpha * 0.9 * lineGlow;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawConstellation(ctx: CanvasRenderingContext2D, now: number): void {
  const invK = 1 / transform.k;

  for (const e of fedges) {
    const sc = nodeCluster.get(e.source);
    const tc = nodeCluster.get(e.target);
    if (sc && sc === tc) {
      drawGlowLine(ctx, e.source.x, e.source.y, e.target.x, e.target.y,
        color(sc.groupNode), 0.25, 0.5 * invK);
    } else if (e.source.tree.kind !== "entity" && e.target.tree.kind !== "entity") {
      const edgeCol = color(e.source.tree);
      drawGlowLine(ctx, e.source.x, e.source.y, e.target.x, e.target.y,
        edgeCol, 0.35, 0.6 * invK);
    }
  }

  if (clusters.length > 1) {
    const centroids: { x: number; y: number; c: Cluster }[] = [];
    for (const cluster of clusters) {
      let cx = 0, cy = 0;
      for (const fn of cluster.nodes) { cx += fn.x; cy += fn.y; }
      cx /= cluster.nodes.length;
      cy /= cluster.nodes.length;
      centroids.push({ x: cx, y: cy, c: cluster });
    }

    ctx.setLineDash([4 * invK, 6 * invK]);
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
      if (closestIdx > i) {
        drawGlowLine(ctx, a.x, a.y, centroids[closestIdx].x, centroids[closestIdx].y,
          "#88aacc", 0.4, 0.4 * invK);
      }
    }
    ctx.setLineDash([]);
  }

  const starScale = starSize / Math.sqrt(transform.k);

  invalidateSpriteCache();

  ctx.globalCompositeOperation = "screen";

  for (const fn of fnodes) {
    if (fn.tree.kind !== "entity") continue;

    const unavail = isUnavailable(fn) && (unavailableMode === "pulse" || unavailableMode === "ring");
    const twinkle = twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * twinkleSpeed + fn.phase);
    const pulse = twinkle * twinkle;
    const baseAlpha = unavail ? 0.15 : 0.5;
    const twinklePulse = twinkleMin + (1 - twinkleMin) * pulse;
    const haloAlpha = Math.min(1, baseAlpha * twinklePulse * glowBrightness);
    const coreAlpha = Math.min(1, twinklePulse * (unavail ? 0.4 : 1));

    const nodeCol = unavail ? "#666" : color(fn.tree);
    const starR = 5 * starScale;
    const sizePulse = 1 + twinkleSize * (pulse - 0.5);
    const haloR = starR * glowSize * glowIntensity * sizePulse;
    const sprite = getStarSprite(nodeCol, glowIntensity);
    const drawSize = haloR * 2;

    ctx.globalAlpha = haloAlpha;
    ctx.drawImage(sprite.halo, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
    ctx.globalAlpha = coreAlpha;
    ctx.drawImage(sprite.core, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function drawConstellationParents(ctx: CanvasRenderingContext2D, now: number): void {
  const starScale = starSize / Math.sqrt(transform.k);
  const pgi = parentGlowIntensity;

  ctx.globalCompositeOperation = "screen";

  for (const fn of fnodes) {
    if (fn.tree.kind === "entity") continue;

    const twinkle = twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * twinkleSpeed + fn.phase);
    const pulse = twinkle * twinkle;
    const twinklePulse = twinkleMin + (1 - twinkleMin) * pulse;
    const haloAlpha = Math.min(1, 0.9 * twinklePulse * glowBrightness);
    const coreAlpha = Math.min(1, twinklePulse);

    const nodeCol = color(fn.tree);
    const starR = (fn.tree.kind === "root" ? 14 : 9) * starScale;
    const sizePulse = 1 + twinkleSize * (pulse - 0.5);
    const haloR = starR * glowSize * pgi * sizePulse;
    const sprite = getStarSprite(nodeCol, pgi);
    const drawSize = haloR * 2;

    ctx.globalAlpha = haloAlpha;
    ctx.drawImage(sprite.halo, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
    ctx.globalAlpha = coreAlpha;
    ctx.drawImage(sprite.core, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
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

  const starScale = starSize / Math.sqrt(transform.k);
  const isEntity = fn.tree.kind === "entity";
  const baseR = isEntity ? 5 : (fn.tree.kind === "root" ? 14 : 9);
  const starR = baseR * starScale;
  const intensity = isEntity ? glowIntensity : parentGlowIntensity;
  const scale = 1 + 0.5 * ease;
  const haloR = starR * glowSize * intensity * scale;
  const nodeCol = color(fn.tree);
  const sprite = getStarSprite(nodeCol, intensity);
  const drawSize = haloR * 2;

  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.6 * ease;
  ctx.drawImage(sprite.halo, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  ctx.globalAlpha = ease;
  ctx.drawImage(sprite.core, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function drawStarEffects(ctx: CanvasRenderingContext2D, now: number): void {
  const expired: FNode[] = [];
  const ss = starSize * effectScale / Math.sqrt(transform.k);

  for (const [fn, startTime] of glowTimestamps) {
    const elapsed = now - startTime;
    if (elapsed > GLOW_DURATION) {
      expired.push(fn);
      continue;
    }
    const t = elapsed / GLOW_DURATION;
    const nodeCol = color(fn.tree);

    switch (starEffect) {
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

  for (const fn of expired) glowTimestamps.delete(fn);
  ctx.globalAlpha = 1;
}

function drawSupernova(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number): void {
  const ease = 1 - (1 - t) * (1 - t);
  const blastR = ss * 80 * ease * glowIntensity;
  const opacity = (1 - t);
  const gb = glowBrightness;

  const blast = ctx.createRadialGradient(fn.x, fn.y, 0, fn.x, fn.y, blastR);
  blast.addColorStop(0, "#fff");
  blast.addColorStop(0.15, nodeCol);
  blast.addColorStop(1, transparent(nodeCol));
  ctx.globalAlpha = opacity * 0.6 * gb;
  ctx.fillStyle = blast;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, blastR, 0, Math.PI * 2);
  ctx.fill();

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

    ctx.globalAlpha = fade * 0.7 * glowBrightness;
    ctx.fillStyle = i === 0 ? "#fff" : nodeCol;
    ctx.beginPath();
    ctx.arc(tx, ty, Math.max(r, ss * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  const headGlow = ctx.createRadialGradient(hx, hy, 0, hx, hy, ss * 10);
  headGlow.addColorStop(0, "#fff");
  headGlow.addColorStop(0.3, nodeCol);
  headGlow.addColorStop(1, transparent(nodeCol));
  ctx.globalAlpha = (1 - t) * 0.6 * glowBrightness;
  ctx.fillStyle = headGlow;
  ctx.beginPath();
  ctx.arc(hx, hy, ss * 10, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlare(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number, now: number): void {
  const intensity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
  const rotation = now * 0.001;
  const spikeLen = ss * (5 + 45 * intensity * glowIntensity);
  const spikeCount = 4;

  const coreGlow = ctx.createRadialGradient(fn.x, fn.y, 0, fn.x, fn.y, ss * 8 * intensity);
  coreGlow.addColorStop(0, "#fff");
  coreGlow.addColorStop(0.5, nodeCol);
  coreGlow.addColorStop(1, transparent(nodeCol));
  ctx.globalAlpha = intensity * 0.7 * glowBrightness;
  ctx.fillStyle = coreGlow;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, ss * 8 * intensity, 0, Math.PI * 2);
  ctx.fill();

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

    ctx.globalAlpha = intensity * 0.6 * glowBrightness;
    ctx.strokeStyle = grad;
    ctx.lineWidth = ss * (1 + 2 * intensity);
    ctx.beginPath();
    ctx.moveTo(fn.x - cos * spikeLen, fn.y - sin * spikeLen);
    ctx.lineTo(fn.x + cos * spikeLen, fn.y + sin * spikeLen);
    ctx.stroke();
  }
}

function drawPulseWave(ctx: CanvasRenderingContext2D, fn: FNode, t: number, nodeCol: string, ss: number): void {
  const waveFront = t * 6;
  const visited = new Map<FNode, number>();
  const queue: { node: FNode; depth: number }[] = [{ node: fn, depth: 0 }];
  visited.set(fn, 0);

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth > 5) continue;

    const children = childFNodes.get(node) ?? [];
    const parent = parentFNode.get(node);
    const neighbors = [...children];
    if (parent) neighbors.push(parent);

    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      visited.set(nb, depth + 1);
      queue.push({ node: nb, depth: depth + 1 });
    }
  }

  for (const [node, depth] of visited) {
    const waveHit = depth / waveFront;
    if (waveHit > 1) continue;
    const fadeIn = Math.max(0, 1 - Math.abs(waveHit - 0.5) * 2);
    const fade = fadeIn * (1 - t);

    ctx.globalAlpha = fade * 0.8 * glowBrightness;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(node.x, node.y, ss * (3 + 5 * fadeIn), 0, Math.PI * 2);
    ctx.fill();

    const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, ss * 12 * fadeIn);
    glow.addColorStop(0, nodeCol);
    glow.addColorStop(1, transparent(nodeCol));
    ctx.globalAlpha = fade * 0.4 * glowBrightness;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(node.x, node.y, ss * 12 * fadeIn, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const e of fedges) {
    const sd = visited.get(e.source);
    const td = visited.get(e.target);
    if (sd === undefined || td === undefined) continue;
    const edgeDepth = Math.min(sd, td);
    const waveHit = edgeDepth / waveFront;
    if (waveHit > 1) continue;
    const fadeIn = Math.max(0, 1 - Math.abs(waveHit - 0.5) * 2);
    const fade = fadeIn * (1 - t);

    ctx.globalAlpha = fade * 0.7 * glowBrightness;
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

  const glow = ctx.createRadialGradient(fn.x, fn.y, 0, fn.x, fn.y, ss * 20 * glowIntensity);
  glow.addColorStop(0, shiftColor);
  glow.addColorStop(0.3, shiftColor);
  glow.addColorStop(1, shiftTransparent);
  ctx.globalAlpha = fade * 0.7 * glowBrightness;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, ss * 20 * glowIntensity, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = fade * glowBrightness;
  ctx.fillStyle = t < 0.15 ? "#fff" : shiftColor;
  ctx.beginPath();
  ctx.arc(fn.x, fn.y, ss * 3, 0, Math.PI * 2);
  ctx.fill();
}

function isUnavailable(fn: FNode): boolean {
  if (!fn.tree.entityId) return false;
  const state = currentStates.get(fn.tree.entityId);
  return state !== undefined && state.state === "unavailable";
}

function drawUnavailablePulses(ctx: CanvasRenderingContext2D, now: number): void {
  if (unavailableMode !== "pulse") return;

  const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now * 0.004));

  for (const fn of fnodes) {
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
  const dpr = devicePixelRatio;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  ctx.setTransform(
    dpr * transform.k, 0,
    0, dpr * transform.k,
    dpr * transform.x, dpr * transform.y
  );

  if (glassContainer) glassContainer.style.display = showLabels ? "" : "none";

  if (constellation) {
    const now = performance.now();
    drawConstellation(ctx, now);
    drawStarEffects(ctx, now);
    drawConstellationParents(ctx, now);
    drawConstellationHover(ctx);
    drawUnavailablePulses(ctx, now);
    drawSearchHighlights(ctx);
    if (showLabels) drawLabels(ctx);
    return;
  }

  if (showHulls) {
    for (const cluster of clusters) {
      drawHull(ctx, cluster);
    }
  }

  ctx.globalAlpha = Math.min(1, lineGlow);
  ctx.lineWidth = (0.5 + lineGlow) / transform.k;
  ctx.strokeStyle = lineGlow > 1 ? "#666" : "#444";
  for (const e of fedges) {
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  drawAutomationEdges(ctx);

  for (const n of fnodes) {
    const unavail = isUnavailable(n);
    const dimmed = unavail && unavailableMode === "pulse";
    const ringed = unavail && unavailableMode === "ring";
    ctx.globalAlpha = dimmed ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    if (ringed) {
      ctx.fillStyle = backgroundColor;
      ctx.fill();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color(n.tree);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = "#888";
      ctx.lineWidth = 1 / transform.k;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = dimmed ? "#666" : color(n.tree);
      ctx.fill();
    }

    if (showIcons && n.tree.kind === "entity" && n.tree.entityId) {
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
      const fontSize = Math.max(7, 9 * ss);
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
  dismissContextMenu();
  didDrag = false;
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
    didDrag = true;
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
      if (showAutomationEdges) {
        extra += getAutomationTooltipHtml(n.tree.entityId);
      }
    }
    if (isCollapsible(n.tree)) {
      const collapsed = collapsedNodes.has(n.tree.id);
      extra += `<br><span style="color:#9e9e9e;font-size:0.7rem">${n.tree.leafCount} entities${collapsed ? " (collapsed)" : ""} · Shift+click to ${collapsed ? "expand" : "collapse"}</span>`;
    }
    showTip(e.clientX, e.clientY, n.tree, currentStates, extra || undefined);
    if (canvas) canvas.style.cursor = "pointer";
  } else {
    hideTip();
    if (canvas) canvas.style.cursor = panning ? "grabbing" : "grab";
  }
  if (changed) ensureLoop();
}

function onMouseUp(e: MouseEvent): void {
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
  panning = false;
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
  navigator.clipboard.writeText(id).then(() => showToast(`Copied: ${id}`));
}

function openHaPage(node: TreeNode, page: "history" | "logbook"): void {
  const base = getHaUrl();
  if (!base) return;
  const id = nodeActionId(node);
  if (!id) return;
  if (node.kind === "area") {
    window.open(`${base}/config/areas/area/${id}`, "_blank");
  } else {
    window.open(`${base}/${page}?entity_id=${id}`, "_blank");
  }
}

interface ServiceAction {
  label: string;
  service: string;
  confirm?: boolean;
}

const SERVICE_ACTIONS: Record<string, ServiceAction[]> = {
  light: [
    { label: "Toggle", service: "toggle" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  switch: [
    { label: "Toggle", service: "toggle" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  fan: [
    { label: "Toggle", service: "toggle" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  input_boolean: [
    { label: "Toggle", service: "toggle" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  humidifier: [
    { label: "Toggle", service: "toggle" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
  ],
  script: [
    { label: "Run", service: "turn_on" },
    { label: "Stop", service: "turn_off" },
  ],
  scene: [
    { label: "Activate", service: "turn_on" },
  ],
  automation: [
    { label: "Trigger", service: "trigger" },
    { label: "Toggle", service: "toggle" },
    { label: "Turn on", service: "turn_on" },
    { label: "Turn off", service: "turn_off" },
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
    showToast("Not connected");
    return;
  }
  try {
    await haConnection.sendMessagePromise({
      type: "call_service",
      domain,
      service,
      target: { entity_id: entityId },
    });
    showToast(`${service.replace(/_/g, " ")}: ${entityId}`);
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
    debugLog("system", `Service call failed: ${domain}.${service}`, msg);
    showToast(`Failed: ${msg}`);
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

  hideTip();

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
        addItem(a.label, () => {
          if (a.confirm && !window.confirm(`${a.label}: ${node.entityId}?`)) return;
          callEntityService(node.domain!, a.service, node.entityId!);
        });
      }
      addSeparator();
    }
  }

  addItem(`Copy ID: ${id}`, () => copyNodeId(node));

  const haBase = getHaUrl();
  if (haBase) {
    if (node.entityId) {
      addItem("View History", () => openHaPage(node, "history"));
      addItem("View Logbook", () => openHaPage(node, "logbook"));
    } else if (node.kind === "area") {
      addItem("Open Area in HA", () => openHaPage(node, "history"));
    } else if (node.kind === "device") {
      addItem("Open Device in HA", () => {
        window.open(`${haBase}/config/devices/device/${id}`, "_blank");
      });
      addItem("View Automations", () => {
        window.open(`${haBase}/config/automation/dashboard?device_id=${id}`, "_blank");
      });
      addItem("View Logbook", () => {
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
    addItem(collapsed ? "Expand" : "Collapse", () => {
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
