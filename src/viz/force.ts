import type { Connection } from "home-assistant-js-websocket";
import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState, Registries } from "../ha/types";
import { color, showTip, hideTip, flatten } from "./shared";
import { randomizeColors, resetColors, getDomainColors, setDomainColors, setDomainColor, domainList } from "../render/colors";
import { createTransform, applyWheel, screenToWorld, type ZoomTransform } from "./zoom";
import { buildTree, buildTreeByDevice } from "../tree/build";
import { loadCredentials } from "../login";
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
let settingsPanel: HTMLDivElement | null = null;
let frame = 0;
let currentStates: Map<string, HaState> = new Map();
let currentRegistries: Registries | null = null;
let panelHaUrl = "";
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
  lineGlow: number;
  glowBrightness: number;
  glowSize: number;
  starEffect: StarEffect;
  labelSize: number;
  entityDotSize: number;
  parentLabelZoom: number;
  entityLabelZoom: number;
  repulsion: number;
  springLen: number;
  springK: number;
  damping: number;
  automationOnly: boolean;
  appearOnChange: boolean;
  backgroundColor: string;
}

type StarEffect = "supernova" | "shooting-star" | "flare" | "pulse-wave" | "color-shift";
type UnavailableMode = "normal" | "pulse" | "hidden" | "only";
const defaults: ForceSettings = {
  showHulls: false,
  showLabels: true,
  showEntities: true,
  showAutomationEdges: false,
  unavailableMode: "pulse",
  changedOnly: true,
  constellation: false,
  groupBy: "area",
  structureMode: "domain",
  starSize: 0.8,
  glowIntensity: 1.2,
  parentGlowIntensity: 0.2,
  effectScale: 2,
  twinkleSpeed: 0.1,
  twinkleSize: 0,
  lineGlow: 0.3,
  glowBrightness: 2,
  glowSize: 8,
  starEffect: "supernova",
  labelSize: 16,
  entityDotSize: 16,
  parentLabelZoom: 1.5,
  entityLabelZoom: 2.5,
  repulsion: 3000,
  springLen: 64,
  springK: 0.035,
  damping: 0.8,
  automationOnly: false,
  backgroundColor: "#000000",
  appearOnChange: false,
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
    showHulls, showLabels, showEntities, showAutomationEdges, unavailableMode, changedOnly, constellation, groupBy, structureMode,
    starSize, glowIntensity, twinkleSpeed, twinkleSize, lineGlow, glowBrightness, glowSize,
    starEffect, parentGlowIntensity, effectScale,
    labelSize, entityDotSize, parentLabelZoom, entityLabelZoom,
    repulsion, springLen, springK, damping,
    automationOnly, appearOnChange, backgroundColor,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const saved = loadSettings();
let showHulls = saved.showHulls;
let showLabels = saved.showLabels;
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
let lineGlow = saved.lineGlow;
let glowBrightness = saved.glowBrightness;
let glowSize = saved.glowSize;

let starEffect: StarEffect = saved.starEffect;

let labelSize = saved.labelSize;
let entityDotSize = saved.entityDotSize;
let parentLabelZoom = saved.parentLabelZoom;
let entityLabelZoom = saved.entityLabelZoom;

let hoveredNode: FNode | null = null;
let hoverStartTime = 0;
let searchQuery = "";
let didDrag = false;
let contextMenu: HTMLElement | null = null;

let repulsion = saved.repulsion;
let springLen = saved.springLen;
let springK = saved.springK;
let damping = saved.damping;
let alphaDecay = 0.998;
let alpha = 1;

let automationOnly = saved.automationOnly;
let appearOnChange = saved.appearOnChange;
let backgroundColor = saved.backgroundColor;
let revealedNodes: Set<string> = new Set();
let stateChangeCounts: Map<string, number> = new Map();
let allTreeNodesById: Map<string, TreeNode> = new Map();
let allEntityTreeNodes: Map<string, TreeNode> = new Map();
let pendingReveals: string[] = [];
let revealTimer: ReturnType<typeof setTimeout> | null = null;

let haConnection: Connection | null = null;
let automationEdges: AutomationEdge[] = [];
let automationEdgesByEntity: Map<string, AutomationEdge[]> = new Map();
let automationLoading = false;
let automationLoaded = false;
let onAutomationLoaded: (() => void) | null = null;

const GLOW_DURATION = 3000;

// Star sprite cache: pre-rendered gradient stars keyed by "color|sizeCategory|glowParam"
const spriteCache = new Map<string, { canvas: OffscreenCanvas; size: number }>();
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

function getStarSprite(nodeCol: string, intensity: number): { canvas: OffscreenCanvas; size: number } {
  const key = `${nodeCol}|${intensity}|${spriteCacheVersion}`;
  let entry = spriteCache.get(key);
  if (entry) return entry;

  // Sprite dimensions: the halo is the largest element at 8 * intensity relative to base star size.
  // We render at a fixed pixel resolution and scale when drawing.
  // Use a base of 128px for the halo radius, so total sprite is 256x256.
  const spritePixels = 256;
  const center = spritePixels / 2;
  const haloR = center; // fills the sprite
  const innerR = (center / 8) * 3 * intensity; // starR * 3 * intensity relative to haloR = starR * 8 * intensity
  const coreR = (center / 8) * 0.6;
  const spikeLen = (center / 8) * 3;

  const oc = new OffscreenCanvas(spritePixels, spritePixels);
  const sctx = oc.getContext("2d")!;

  // Outer glow (tighter falloff)
  const outerGlow = sctx.createRadialGradient(center, center, 0, center, center, haloR);
  outerGlow.addColorStop(0, nodeCol);
  outerGlow.addColorStop(0.15, nodeCol);
  outerGlow.addColorStop(0.5, transparent(nodeCol));
  outerGlow.addColorStop(1, transparent(nodeCol));
  sctx.globalAlpha = 0.7 * intensity;
  sctx.fillStyle = outerGlow;
  sctx.beginPath();
  sctx.arc(center, center, haloR, 0, Math.PI * 2);
  sctx.fill();

  // Inner glow (brighter, tighter)
  const innerGlow = sctx.createRadialGradient(center, center, 0, center, center, innerR);
  innerGlow.addColorStop(0, "#fff");
  innerGlow.addColorStop(0.2, "#fff");
  innerGlow.addColorStop(0.5, nodeCol);
  innerGlow.addColorStop(1, transparent(nodeCol));
  sctx.globalAlpha = 0.9 * intensity;
  sctx.fillStyle = innerGlow;
  sctx.beginPath();
  sctx.arc(center, center, innerR, 0, Math.PI * 2);
  sctx.fill();

  // Core dot (larger)
  sctx.globalAlpha = 1;
  sctx.fillStyle = "#fff";
  sctx.beginPath();
  sctx.arc(center, center, coreR * 1.8, 0, Math.PI * 2);
  sctx.fill();

  // Cross spikes (brighter, thicker)
  const spikeGrad = sctx.createLinearGradient(center - spikeLen, center, center + spikeLen, center);
  spikeGrad.addColorStop(0, transparent(nodeCol));
  spikeGrad.addColorStop(0.3, nodeCol);
  spikeGrad.addColorStop(0.5, "#fff");
  spikeGrad.addColorStop(0.7, nodeCol);
  spikeGrad.addColorStop(1, transparent(nodeCol));
  sctx.strokeStyle = spikeGrad;
  sctx.globalAlpha = 0.8;
  sctx.lineWidth = 1.5;
  sctx.beginPath();
  sctx.moveTo(center - spikeLen, center);
  sctx.lineTo(center + spikeLen, center);
  sctx.stroke();

  const vSpikeGrad = sctx.createLinearGradient(center, center - spikeLen, center, center + spikeLen);
  vSpikeGrad.addColorStop(0, transparent(nodeCol));
  vSpikeGrad.addColorStop(0.3, nodeCol);
  vSpikeGrad.addColorStop(0.5, "#fff");
  vSpikeGrad.addColorStop(0.7, nodeCol);
  vSpikeGrad.addColorStop(1, transparent(nodeCol));
  sctx.strokeStyle = vSpikeGrad;
  sctx.beginPath();
  sctx.moveTo(center, center - spikeLen);
  sctx.lineTo(center, center + spikeLen);
  sctx.stroke();

  entry = { canvas: oc, size: spritePixels };
  spriteCache.set(key, entry);
  return entry;
}

export function createForceViz(registries: Registries, haUrl?: string, connection?: Connection): Visualization {
  panelHaUrl = haUrl ?? "";
  haConnection = connection ?? null;
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

      canvas.addEventListener("mousedown", onMouseDown);
      canvas.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("mouseup", onMouseUp);
      canvas.addEventListener("mouseleave", () => { dragNode = null; panning = false; hoveredNode = null; hideTip(); });
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);

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
      if (glassContainer) {
        glassContainer.remove();
        glassContainer = null;
        glassLabels = [];
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
      automationEdges = [];
      automationEdgesByEntity = new Map();
      automationLoaded = false;
      automationLoading = false;
      onAutomationLoaded = null;
      revealedNodes.clear();
      stateChangeCounts.clear();
      allTreeNodesById = new Map();
      allEntityTreeNodes = new Map();
      pendingReveals = [];
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      dismissContextMenu();
      dragNode = null;
      panning = false;
    },

    updateStates(states) {
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

function insertRevealedNode(nodeId: string): void {
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

  glowTimestamps.set(fn, performance.now());
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

function createSettings(container: HTMLElement): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "force-settings";
  container.appendChild(wrapper);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "force-settings-toggle";
  toggleBtn.textContent = "\u2699";
  toggleBtn.title = "Toggle settings";
  wrapper.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.className = "force-settings-body";
  panel.hidden = true;
  wrapper.appendChild(panel);

  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    wrapper.classList.toggle("force-settings-open", !panel.hidden);
  });

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "force-search";
  searchInput.placeholder = "Search entities...";
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.toLowerCase();
    ensureLoop();
  });
  panel.appendChild(searchInput);

  // Forward-declare toggle references for cross-section disabled state management
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

    // Appear on change forces entities on, so lock the toggle
    setDisabled(entitiesToggle, aocOn);

    // These are all entity-specific — irrelevant when entities are off
    setDisabled(unavailableSelect, entitiesOff || aocOn);
    setDisabled(changedOnlyToggle, entitiesOff);
    setDisabled(appearOnChangeToggle, entitiesOff);

    // Automation-only needs entities visible AND automation data loaded
    setDisabled(autoOnlyToggle, entitiesOff || !automationLoaded);
  }

  // -- Mode section (top) --
  const modeSection = makeSection("Mode");

  modeSection.body.appendChild(makeSelect("Structure", ["domain", "device"], structureMode, (v) => {
    structureMode = v as StructureMode;
    rebuildWithStructure();
    saveSettings();
  }));

  // Entities + sub-options
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
  modeSection.body.appendChild(entitiesToggle);

  const entitiesSubOptions = document.createElement("div");
  entitiesSubOptions.className = "force-sub-options";
  entitiesSubOptions.hidden = !showEntities;

  unavailableSelect = makeSelect("Unavailable", ["normal", "pulse", "hidden", "only"], unavailableMode, (v) => {
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
  modeSection.body.appendChild(entitiesSubOptions);

  // Hulls + sub-options
  const hullToggle = makeToggle("Hulls", showHulls, (v) => {
    showHulls = v;
    hullSubOptions.hidden = !v;
    if (v && constellation) {
      constellation = false;
      constellationSubOptions.hidden = true;
      constellationToggle.querySelector("input")!.checked = false;
      ensureLoop();
    }
    saveSettings();
  }, "Convex hull outlines around groups");
  modeSection.body.appendChild(hullToggle);

  const hullSubOptions = document.createElement("div");
  hullSubOptions.className = "force-sub-options";
  hullSubOptions.hidden = !showHulls;
  hullSubOptions.appendChild(makeSelect("Grouping", ["area", "domain"], groupBy, (v) => {
    groupBy = v as GroupMode;
    rebuildClusters();
    saveSettings();
  }));
  modeSection.body.appendChild(hullSubOptions);

  // Constellation + sub-options
  const constellationToggle = makeToggle("Constellation", constellation, (v) => {
    constellation = v;
    constellationSubOptions.hidden = !v;
    if (v && showHulls) {
      showHulls = false;
      hullSubOptions.hidden = true;
      hullToggle.querySelector("input")!.checked = false;
    }
    ensureLoop();
    saveSettings();
  });
  modeSection.body.appendChild(constellationToggle);

  const constellationSubOptions = document.createElement("div");
  constellationSubOptions.className = "force-sub-options";
  constellationSubOptions.hidden = !constellation;
  constellationSubOptions.appendChild(makeSlider("Brightness", 0, 3, glowBrightness, 0.1, (v) => { glowBrightness = v; saveSettings(); }, "Overall star and edge opacity"));
  constellationSubOptions.appendChild(makeSlider("Star size", 0.2, 3, starSize, 0.1, (v) => { starSize = v; saveSettings(); }));
  constellationSubOptions.appendChild(makeSlider("Halo intensity", 0.2, 3, glowIntensity, 0.1, (v) => { glowIntensity = v; saveSettings(); }, "Glow gradient spread and strength"));
  constellationSubOptions.appendChild(makeSlider("Halo size", 2, 16, glowSize, 0.5, (v) => { glowSize = v; saveSettings(); }, "Base glow radius around stars"));
  constellationSubOptions.appendChild(makeSlider("Parent halo", 0.2, 5, parentGlowIntensity, 0.1, (v) => { parentGlowIntensity = v; saveSettings(); }, "Halo for area, domain, and device nodes"));
  constellationSubOptions.appendChild(makeSlider("Effect scale", 0.5, 5, effectScale, 0.1, (v) => { effectScale = v; saveSettings(); }, "Size of state-change effects"));
  constellationSubOptions.appendChild(makeSlider("Twinkle speed", 0, 5, twinkleSpeed, 0.1, (v) => { twinkleSpeed = v; saveSettings(); }));
  constellationSubOptions.appendChild(makeSlider("Twinkle size", 0, 1, twinkleSize, 0.05, (v) => { twinkleSize = v; saveSettings(); }, "Halo radius pulsing with twinkle"));
  constellationSubOptions.appendChild(makeSlider("Edge glow", 0, 3, lineGlow, 0.1, (v) => { lineGlow = v; saveSettings(); }, "Glow on connection lines"));
  constellationSubOptions.appendChild(makeSelect("Effect",
    ["supernova", "shooting-star", "flare", "pulse-wave", "color-shift"],
    starEffect, (v) => { starEffect = v as StarEffect; saveSettings(); }, "Animation on entity state change"));
  modeSection.body.appendChild(constellationSubOptions);

  panel.appendChild(modeSection.el);

  // -- Display section --
  const displaySection = makeSection("Display");
  const displayToggles = document.createElement("div");
  displayToggles.className = "force-toggles";
  displayToggles.appendChild(makeToggle("Labels", showLabels, (v) => { showLabels = v; saveSettings(); }));
  changedOnlyToggle = makeToggle("Skip unchanged", changedOnly, (v) => {
    changedOnly = v;
    saveSettings();
  }, "Skip glow when state value hasn't changed");
  displayToggles.appendChild(changedOnlyToggle);
  displaySection.body.appendChild(displayToggles);
  displaySection.body.appendChild(makeSlider("Label size", 4, 24, labelSize, 1, (v) => { labelSize = v; saveSettings(); }));
  displaySection.body.appendChild(makeSlider("Parent label zoom", 0.5, 5, parentLabelZoom, 0.1, (v) => { parentLabelZoom = v; saveSettings(); }, "Zoom level to show structural labels"));
  displaySection.body.appendChild(makeSlider("Entity label zoom", 0.5, 5, entityLabelZoom, 0.1, (v) => { entityLabelZoom = v; saveSettings(); }, "Zoom level to show entity labels"));
  displaySection.body.appendChild(makeSlider("Entity dot size", 1, 16, entityDotSize, 0.5, (v) => {
    entityDotSize = v;
    for (const fn of fnodes) {
      if (fn.tree.kind === "entity") fn.r = v;
    }
    saveSettings();
  }));
  panel.appendChild(displaySection.el);

  // -- Automations section --
  const autoSection = makeSection("Automations", false);
  const autoToggles = document.createElement("div");
  autoToggles.className = "force-toggles";

  autoToggles.appendChild(makeToggle("Show automation edges", showAutomationEdges, (v) => {
    showAutomationEdges = v;
    saveSettings();
    if (v && !automationLoaded && !automationLoading) loadAutomationEdges();
    ensureLoop();
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
  autoToggles.appendChild(autoOnlyToggle);

  onAutomationLoaded = () => {
    syncSettingsState();
    if (automationOnly) rebuildGraph();
  };

  autoSection.body.appendChild(autoToggles);
  panel.appendChild(autoSection.el);

  // Apply initial disabled states
  syncSettingsState();

  // -- Physics section --
  const physicsSection = makeSection("Physics", false);
  physicsSection.body.appendChild(makeSlider("Repulsion", 100, 3000, repulsion, 10, (v) => { repulsion = v; reheat(); saveSettings(); }));
  physicsSection.body.appendChild(makeSlider("Spring length", 10, 120, springLen, 1, (v) => { springLen = v; reheat(); saveSettings(); }));
  physicsSection.body.appendChild(makeSlider("Spring stiffness", 0.005, 0.15, springK, 0.005, (v) => { springK = v; reheat(); saveSettings(); }, "Pull strength between connected nodes"));
  physicsSection.body.appendChild(makeSlider("Damping", 0.5, 0.99, damping, 0.01, (v) => { damping = v; reheat(); saveSettings(); }, "Velocity decay per frame"));
  panel.appendChild(physicsSection.el);

  // -- Colors section --
  const colorsSection = makeSection("Colors", false);

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
      const label = swatch as HTMLLabelElement;
      const domain = label.title;
      const dot = label.querySelector(".force-color-dot") as HTMLSpanElement;
      const input = label.querySelector("input") as HTMLInputElement;
      if (dot && input && domain in colors) {
        dot.style.background = colors[domain];
        input.value = colors[domain];
      }
    }
  }

  panel.appendChild(colorsSection.el);

  // -- Actions --
  const buttons = document.createElement("div");
  buttons.className = "force-buttons";

  const resetPosBtn = document.createElement("button");
  resetPosBtn.className = "force-reset-btn";
  resetPosBtn.textContent = "Reset positions";
  resetPosBtn.addEventListener("click", () => {
    rebuildGraph();
  });
  buttons.appendChild(resetPosBtn);

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
    lineGlow = defaults.lineGlow;
    glowBrightness = defaults.glowBrightness;
    glowSize = defaults.glowSize;
    starEffect = defaults.starEffect;
    labelSize = defaults.labelSize;
    entityDotSize = defaults.entityDotSize;
    parentLabelZoom = defaults.parentLabelZoom;
    entityLabelZoom = defaults.entityLabelZoom;
    repulsion = defaults.repulsion;
    springLen = defaults.springLen;
    springK = defaults.springK;
    damping = defaults.damping;
    automationOnly = defaults.automationOnly;
    appearOnChange = defaults.appearOnChange;
    backgroundColor = defaults.backgroundColor;
    revealedNodes.clear();
    pendingReveals = [];
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    stateChangeCounts.clear();
    searchQuery = "";
    automationEdges = [];
    automationEdgesByEntity = new Map();
    automationLoaded = false;
    automationLoading = false;
    transform = createTransform();
    saveSettings();
    const container = wrapper.parentElement!;
    wrapper.remove();
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
          // Reload settings into live variables
          const s = loadSettings();
          showHulls = s.showHulls;
          showLabels = s.showLabels;
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
          lineGlow = s.lineGlow;
          glowBrightness = s.glowBrightness;
          glowSize = s.glowSize;
          starEffect = s.starEffect;
          labelSize = s.labelSize;
          entityDotSize = s.entityDotSize;
          parentLabelZoom = s.parentLabelZoom;
          entityLabelZoom = s.entityLabelZoom;
          repulsion = s.repulsion;
          springLen = s.springLen;
          springK = s.springK;
          damping = s.damping;
          automationOnly = s.automationOnly;
          appearOnChange = s.appearOnChange;
          backgroundColor = s.backgroundColor;
          // Rebuild UI and graph
          const container = wrapper.parentElement!;
          wrapper.remove();
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

  panel.appendChild(buttons);

  return wrapper;
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
  for (const id of entityNodeMap.keys()) {
    if (id.startsWith("automation.")) automationEntityIds.push(id);
  }

  debugLog("system", `Automation: found ${automationEntityIds.length} automation entities in graph`);

  const knownEntityIds = new Set(entityNodeMap.keys());

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
  const allNodes = flatten(root);

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
  const map = new Map<TreeNode, FNode>();
  const nodeSet = new Set(nodes);

  // Radial tree layout for initial positions
  const positions = new Map<TreeNode, { x: number; y: number }>();
  const cx = width / 2 || 400;
  const cy = height / 2 || 300;

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
  if (rootNode) {
    layoutRadial(rootNode, cx, cy, 0, Math.PI * 2, 0);
  }

  fnodes = nodes.map((n) => {
    const r = n.kind === "root" ? 10 : n.kind === "area" ? 8
      : (n.kind === "domain" || n.kind === "device") ? 6 : entityDotSize;
    let hash = 0;
    for (let i = 0; i < n.id.length; i++) hash = ((hash << 5) - hash + n.id.charCodeAt(i)) | 0;
    const pos = positions.get(n);
    const fn: FNode = {
      tree: n,
      x: pos ? pos.x : cx + (Math.random() - 0.5) * 100,
      y: pos ? pos.y : cy + (Math.random() - 0.5) * 100,
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

  // Warm up: run simulation ticks before first render so the layout is mostly settled
  for (let i = 0; i < 150; i++) {
    simulate();
    alpha *= alphaDecay;
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
    if (isMiddle && transform.k < parentLabelZoom) continue;

    let labelAlpha = 1;
    if (isEntity) {
      labelAlpha = Math.min(1, (transform.k - entityLabelZoom) / 0.5);
    } else if (isMiddle) {
      labelAlpha = Math.min(1, (transform.k - parentLabelZoom) / 0.5);
    }

    const alpha = Math.max(0.3, labelAlpha);

    if (kind === "root") {
      ctx.font = `700 ${parentFontSize * 1.2}px ${fontFamily}`;
    } else if (isArea) {
      ctx.font = `600 ${parentFontSize}px ${fontFamily}`;
    } else if (isMiddle) {
      ctx.font = `500 ${parentFontSize}px ${fontFamily}`;
    } else {
      ctx.font = `${entityFontSize}px ${fontFamily}`;
    }

    const labelY = n.y + n.r + 2 / transform.k;
    const metrics = ctx.measureText(n.tree.label);
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const textH = ascent + descent;
    const textY = labelY + ascent;

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
      const screenFontSize = kind === "root" ? labelSize * 1.4 * 1.2 : labelSize * 1.4;
      const weight = kind === "root" ? "700" : "600";
      div.textContent = n.tree.label;
      div.style.left = `${screenX}px`;
      div.style.top = `${screenY}px`;
      div.style.fontSize = `${screenFontSize}px`;
      div.style.fontWeight = weight;
      div.style.opacity = String(alpha);
      div.style.display = "";
    } else {
      // Canvas roundRect background for domain/device/entity labels
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.roundRect(
        n.x - metrics.width / 2 - pad,
        textY - ascent - pad,
        metrics.width + pad * 2,
        textH + pad * 2,
        radius
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

  ctx.globalCompositeOperation = "lighter";

  for (const fn of fnodes) {
    if (fn.tree.kind !== "entity") continue;

    const unavail = unavailableMode === "pulse" && isUnavailable(fn);
    const twinkle = twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * twinkleSpeed + fn.phase);
    const pulse = twinkle * twinkle;
    const baseAlpha = unavail ? 0.15 : 0.5;
    const starAlpha = Math.min(1, baseAlpha * (0.15 + 0.85 * pulse) * glowBrightness);

    const nodeCol = unavail ? "#666" : color(fn.tree);
    const starR = 5 * starScale;
    const sizePulse = 1 + twinkleSize * (pulse - 0.5);
    const haloR = starR * glowSize * glowIntensity * sizePulse;
    const sprite = getStarSprite(nodeCol, glowIntensity);
    const drawSize = haloR * 2;

    ctx.globalAlpha = starAlpha;
    ctx.drawImage(sprite.canvas, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

function drawConstellationParents(ctx: CanvasRenderingContext2D, now: number): void {
  const starScale = starSize / Math.sqrt(transform.k);
  const pgi = parentGlowIntensity;

  ctx.globalCompositeOperation = "lighter";

  for (const fn of fnodes) {
    if (fn.tree.kind === "entity") continue;

    const twinkle = twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * twinkleSpeed + fn.phase);
    const pulse = twinkle * twinkle;
    const starAlpha = Math.min(1, 0.9 * (0.15 + 0.85 * pulse) * glowBrightness);

    const nodeCol = color(fn.tree);
    const starR = (fn.tree.kind === "root" ? 14 : 9) * starScale;
    const sizePulse = 1 + twinkleSize * (pulse - 0.5);
    const haloR = starR * glowSize * pgi * sizePulse;
    const sprite = getStarSprite(nodeCol, pgi);
    const drawSize = haloR * 2;

    ctx.globalAlpha = starAlpha;
    ctx.drawImage(sprite.canvas, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
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

  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.6 * ease;
  ctx.drawImage(sprite.canvas, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
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

  ctx.lineWidth = 0.5 / transform.k;
  ctx.strokeStyle = "#444";
  for (const e of fedges) {
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }

  drawAutomationEdges(ctx);

  for (const n of fnodes) {
    const unavail = unavailableMode === "pulse" && isUnavailable(n);
    ctx.globalAlpha = unavail ? 0.3 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = unavail ? "#666" : color(n.tree);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

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
    showTip(e.clientX, e.clientY, n.tree, currentStates, extra || undefined);
    if (canvas) canvas.style.cursor = "pointer";
  } else {
    hideTip();
    if (canvas) canvas.style.cursor = panning ? "grabbing" : "grab";
  }
  if (changed) ensureLoop();
}

function onMouseUp(): void {
  if (dragNode) {
    if (!didDrag) {
      performClickAction(dragNode.tree);
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
  return null;
}

function performClickAction(node: TreeNode): void {
  copyNodeId(node);
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

  addItem(`Copy ID: ${id}`, () => copyNodeId(node));

  const haBase = getHaUrl();
  if (haBase) {
    if (node.entityId) {
      addItem("View History", () => openHaPage(node, "history"));
      addItem("View Logbook", () => openHaPage(node, "logbook"));
    } else if (node.kind === "area") {
      addItem("Open Area in HA", () => openHaPage(node, "history"));
    }
  }

  getRootElement().appendChild(menu);
  contextMenu = menu;

  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      dismissContextMenu();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}
