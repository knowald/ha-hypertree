import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState, Registries } from "../ha/types";
import { color, showTip, hideTip, flatten } from "./shared";
import { randomizeColors, resetColors } from "../render/colors";
import { createTransform, applyWheel, screenToWorld, type ZoomTransform } from "./zoom";
import { buildTree, buildTreeByDevice } from "../tree/build";
import { loadCredentials } from "../login";
import { getRootElement } from "../rootElement";
import { updateFps } from "../debug";

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
  lineGlow: number;
  glowBrightness: number;
  starEffect: StarEffect;
  labelSize: number;
  entityDotSize: number;
  parentLabelZoom: number;
  entityLabelZoom: number;
  repulsion: number;
  springLen: number;
  springK: number;
  damping: number;
}

type StarEffect = "supernova" | "shooting-star" | "flare" | "pulse-wave" | "color-shift";
type UnavailableMode = "normal" | "pulse" | "hidden" | "only";
const defaults: ForceSettings = {
  showHulls: false,
  showLabels: true,
  showEntities: true,
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
  lineGlow: 0.3,
  glowBrightness: 2,
  starEffect: "supernova",
  labelSize: 16,
  entityDotSize: 16,
  parentLabelZoom: 1.5,
  entityLabelZoom: 2.5,
  repulsion: 3000,
  springLen: 64,
  springK: 0.035,
  damping: 0.8,
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
    showHulls, showLabels, showEntities, unavailableMode, changedOnly, constellation, groupBy, structureMode,
    starSize, glowIntensity, twinkleSpeed, lineGlow, glowBrightness,
    starEffect, parentGlowIntensity, effectScale,
    labelSize, entityDotSize, parentLabelZoom, entityLabelZoom,
    repulsion, springLen, springK, damping,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const saved = loadSettings();
let showHulls = saved.showHulls;
let showLabels = saved.showLabels;
let showEntities = saved.showEntities;
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
let lineGlow = saved.lineGlow;
let glowBrightness = saved.glowBrightness;

let starEffect: StarEffect = saved.starEffect;

let labelSize = saved.labelSize;
let entityDotSize = saved.entityDotSize;
let parentLabelZoom = saved.parentLabelZoom;
let entityLabelZoom = saved.entityLabelZoom;

let hoveredNode: FNode | null = null;
let searchQuery = "";
let didDrag = false;
let contextMenu: HTMLElement | null = null;

let repulsion = saved.repulsion;
let springLen = saved.springLen;
let springK = saved.springK;
let damping = saved.damping;
let alphaDecay = 0.998;
let alpha = 1;

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

  // Outer glow
  const outerGlow = sctx.createRadialGradient(center, center, 0, center, center, haloR);
  outerGlow.addColorStop(0, nodeCol);
  outerGlow.addColorStop(0.25, nodeCol);
  outerGlow.addColorStop(1, transparent(nodeCol));
  sctx.globalAlpha = 0.6 * intensity;
  sctx.fillStyle = outerGlow;
  sctx.beginPath();
  sctx.arc(center, center, haloR, 0, Math.PI * 2);
  sctx.fill();

  // Inner glow
  const innerGlow = sctx.createRadialGradient(center, center, 0, center, center, innerR);
  innerGlow.addColorStop(0, "#fff");
  innerGlow.addColorStop(0.3, nodeCol);
  innerGlow.addColorStop(1, transparent(nodeCol));
  sctx.globalAlpha = 0.8 * intensity;
  sctx.fillStyle = innerGlow;
  sctx.beginPath();
  sctx.arc(center, center, innerR, 0, Math.PI * 2);
  sctx.fill();

  // Core dot
  sctx.globalAlpha = 1;
  sctx.fillStyle = "#fff";
  sctx.beginPath();
  sctx.arc(center, center, coreR, 0, Math.PI * 2);
  sctx.fill();

  // Cross spikes
  sctx.strokeStyle = nodeCol;
  sctx.globalAlpha = 0.6;
  sctx.lineWidth = 1;
  sctx.beginPath();
  sctx.moveTo(center - spikeLen, center);
  sctx.lineTo(center + spikeLen, center);
  sctx.moveTo(center, center - spikeLen);
  sctx.lineTo(center, center + spikeLen);
  sctx.stroke();

  entry = { canvas: oc, size: spritePixels };
  spriteCache.set(key, entry);
  return entry;
}

export function createForceViz(registries: Registries, haUrl?: string): Visualization {
  panelHaUrl = haUrl ?? "";
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
      dismissContextMenu();
      dragNode = null;
      panning = false;
    },

    updateStates(states) {
      currentStates = states;
    },

    onEntityChanged(entityId: string, oldValue?: string) {
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

function rebuildWithStructure(): void {
  if (!currentRegistries || !canvas) return;

  const root = structureMode === "device"
    ? buildTreeByDevice(currentRegistries)
    : buildTree(currentRegistries);

  alpha = 1;
  buildGraph(root);
}

function reheat(): void {
  alpha = Math.max(alpha, 0.5);
  ensureLoop();
}

function makeSection(label: string): HTMLDivElement {
  const section = document.createElement("div");
  section.className = "force-section";
  const header = document.createElement("div");
  header.className = "force-section-header";
  header.textContent = label;
  section.appendChild(header);
  return section;
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

  // -- Display section --
  const displaySection = makeSection("Display");
  const displayToggles = document.createElement("div");
  displayToggles.className = "force-toggles";
  displayToggles.appendChild(makeToggle("Labels", showLabels, (v) => { showLabels = v; saveSettings(); }));
  displayToggles.appendChild(makeToggle("Entities", showEntities, (v) => {
    showEntities = v;
    rebuildWithStructure();
    saveSettings();
  }));
  displayToggles.appendChild(makeSelect("Unavailable", ["normal", "pulse", "hidden", "only"], unavailableMode, (v) => {
    const prev = unavailableMode;
    unavailableMode = v as UnavailableMode;
    if (v === "hidden" || prev === "hidden" || v === "only" || prev === "only") rebuildWithStructure();
    ensureLoop();
    saveSettings();
  }));
  displayToggles.appendChild(makeToggle("Changed only", changedOnly, (v) => {
    changedOnly = v;
    saveSettings();
  }));
  displaySection.appendChild(displayToggles);
  displaySection.appendChild(makeSlider("Label size", 4, 24, labelSize, 1, (v) => { labelSize = v; saveSettings(); }));
  displaySection.appendChild(makeSlider("Parent label zoom", 0.5, 5, parentLabelZoom, 0.1, (v) => { parentLabelZoom = v; saveSettings(); }));
  displaySection.appendChild(makeSlider("Entity label zoom", 0.5, 5, entityLabelZoom, 0.1, (v) => { entityLabelZoom = v; saveSettings(); }));
  displaySection.appendChild(makeSlider("Entity dot size", 1, 16, entityDotSize, 0.5, (v) => {
    entityDotSize = v;
    for (const fn of fnodes) {
      if (fn.tree.kind === "entity") fn.r = v;
    }
    saveSettings();
  }));
  panel.appendChild(displaySection);

  // -- Mode section --
  const modeSection = makeSection("Mode");
  const modeToggles = document.createElement("div");
  modeToggles.className = "force-toggles";

  modeToggles.appendChild(makeSelect("Structure", ["domain", "device"], structureMode, (v) => {
    structureMode = v as StructureMode;
    rebuildWithStructure();
    saveSettings();
  }));

  const hullGrouping = makeSelect("Grouping", ["area", "domain"], groupBy, (v) => {
    groupBy = v as GroupMode;
    rebuildClusters();
    saveSettings();
  });
  hullGrouping.hidden = !showHulls;
  hullGrouping.className = "toggle-label force-sub-option";

  const hullToggle = makeToggle("Hulls", showHulls, (v) => {
    showHulls = v;
    hullGrouping.hidden = !v;
    if (v && constellation) {
      constellation = false;
      constellationContent.hidden = true;
      constellationToggle.querySelector("input")!.checked = false;
      ensureLoop();
    }
    saveSettings();
  });
  modeToggles.appendChild(hullToggle);
  modeToggles.appendChild(hullGrouping);

  const constellationContent = document.createElement("div");
  constellationContent.className = "force-constellation-options";
  constellationContent.hidden = !constellation;

  const constellationToggle = makeToggle("Constellation", constellation, (v) => {
    constellation = v;
    constellationContent.hidden = !v;
    if (v && showHulls) {
      showHulls = false;
      hullGrouping.hidden = true;
      hullToggle.querySelector("input")!.checked = false;
    }
    ensureLoop();
    saveSettings();
  });
  modeToggles.appendChild(constellationToggle);
  modeSection.appendChild(modeToggles);

  constellationContent.appendChild(makeSlider("Glow brightness", 0, 3, glowBrightness, 0.1, (v) => { glowBrightness = v; saveSettings(); }));
  constellationContent.appendChild(makeSlider("Star size", 0.2, 3, starSize, 0.1, (v) => { starSize = v; saveSettings(); }));
  constellationContent.appendChild(makeSlider("Glow intensity", 0.2, 3, glowIntensity, 0.1, (v) => { glowIntensity = v; saveSettings(); }));
  constellationContent.appendChild(makeSlider("Parent glow", 0.2, 5, parentGlowIntensity, 0.1, (v) => { parentGlowIntensity = v; saveSettings(); }));
  constellationContent.appendChild(makeSlider("Effect scale", 0.5, 5, effectScale, 0.1, (v) => { effectScale = v; saveSettings(); }));
  constellationContent.appendChild(makeSlider("Twinkle speed", 0, 5, twinkleSpeed, 0.1, (v) => { twinkleSpeed = v; saveSettings(); }));
  constellationContent.appendChild(makeSlider("Line glow", 0, 3, lineGlow, 0.1, (v) => { lineGlow = v; saveSettings(); }));
  constellationContent.appendChild(makeSelect("Effect",
    ["supernova", "shooting-star", "flare", "pulse-wave", "color-shift"],
    starEffect, (v) => { starEffect = v as StarEffect; saveSettings(); }));
  modeSection.appendChild(constellationContent);
  panel.appendChild(modeSection);

  // -- Physics section --
  const physicsSection = makeSection("Physics");
  physicsSection.appendChild(makeSlider("Repulsion", 100, 3000, repulsion, 10, (v) => { repulsion = v; reheat(); saveSettings(); }));
  physicsSection.appendChild(makeSlider("Spring length", 10, 120, springLen, 1, (v) => { springLen = v; reheat(); saveSettings(); }));
  physicsSection.appendChild(makeSlider("Spring stiffness", 0.005, 0.15, springK, 0.005, (v) => { springK = v; reheat(); saveSettings(); }));
  physicsSection.appendChild(makeSlider("Damping", 0.5, 0.99, damping, 0.01, (v) => { damping = v; reheat(); saveSettings(); }));
  panel.appendChild(physicsSection);

  // -- Actions --
  const buttons = document.createElement("div");
  buttons.className = "force-buttons";

  const resetPosBtn = document.createElement("button");
  resetPosBtn.className = "force-reset-btn";
  resetPosBtn.textContent = "Reset positions";
  resetPosBtn.addEventListener("click", () => {
    transform = createTransform();
    rebuildWithStructure();
  });
  buttons.appendChild(resetPosBtn);

  const randomColorBtn = document.createElement("button");
  randomColorBtn.className = "force-reset-btn";
  randomColorBtn.textContent = "Randomize colors";
  randomColorBtn.addEventListener("click", () => {
    randomizeColors();
    spriteCache.clear();
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
    lineGlow = defaults.lineGlow;
    glowBrightness = defaults.glowBrightness;
    starEffect = defaults.starEffect;
    labelSize = defaults.labelSize;
    entityDotSize = defaults.entityDotSize;
    parentLabelZoom = defaults.parentLabelZoom;
    entityLabelZoom = defaults.entityLabelZoom;
    repulsion = defaults.repulsion;
    springLen = defaults.springLen;
    springK = defaults.springK;
    damping = defaults.damping;
    searchQuery = "";
    transform = createTransform();
    saveSettings();
    const container = wrapper.parentElement!;
    wrapper.remove();
    settingsPanel = createSettings(container);
    rebuildWithStructure();
  });
  buttons.appendChild(resetAllBtn);

  panel.appendChild(buttons);

  return wrapper;
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

function makeSlider(
  label: string, min: number, max: number, initial: number, step: number,
  onChange: (v: number) => void
): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "force-slider-label";
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

function buildGraph(root: TreeNode): void {
  const allNodes = flatten(root);
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
  const map = new Map<TreeNode, FNode>();

  fnodes = nodes.map((n) => {
    const r = n.kind === "root" ? 10 : n.kind === "area" ? 8
      : (n.kind === "domain" || n.kind === "device") ? 6 : entityDotSize;
    const fn: FNode = {
      tree: n,
      x: Math.random() * 600 + 100,
      y: Math.random() * 400 + 100,
      vx: 0, vy: 0,
      fx: null, fy: null,
      r,
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

function quadInsert(quad: QuadNode, fn: FNode): void {
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

  // If leaf with existing body, push it down then insert new
  if (quad.body) {
    const existing = quad.body;
    quad.body = null;
    quadPush(quad, existing);
  }
  quadPush(quad, fn);
}

function quadPush(quad: QuadNode, fn: FNode): void {
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

  quadInsert(child, fn);
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

  for (const fn of fnodes) {
    if (fn.tree.kind !== "entity") continue;

    const unavail = unavailableMode === "pulse" && isUnavailable(fn);
    const phase = fn.x * 0.1 + fn.y * 0.07;
    const twinkle = twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * twinkleSpeed + phase);
    const pulse = twinkle * twinkle;
    const baseAlpha = unavail ? 0.15 : 0.5;
    const starAlpha = Math.min(1, baseAlpha * (0.15 + 0.85 * pulse) * glowBrightness);

    const nodeCol = unavail ? "#666" : color(fn.tree);
    const starR = 5 * starScale;
    const haloR = starR * 8 * glowIntensity;
    const sprite = getStarSprite(nodeCol, glowIntensity);
    const drawSize = haloR * 2;

    ctx.globalAlpha = starAlpha;
    ctx.drawImage(sprite.canvas, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  }

  ctx.globalAlpha = 1;
}

function drawConstellationParents(ctx: CanvasRenderingContext2D, now: number): void {
  const starScale = starSize / Math.sqrt(transform.k);
  const pgi = parentGlowIntensity;

  for (const fn of fnodes) {
    if (fn.tree.kind === "entity") continue;

    const phase = fn.x * 0.1 + fn.y * 0.07;
    const twinkle = twinkleSpeed === 0 ? 1 : 0.5 + 0.5 * Math.sin(now * 0.003 * twinkleSpeed + phase);
    const pulse = twinkle * twinkle;
    const starAlpha = Math.min(1, 0.9 * (0.15 + 0.85 * pulse) * glowBrightness);

    const nodeCol = color(fn.tree);
    const starR = (fn.tree.kind === "root" ? 14 : 9) * starScale;
    const haloR = starR * 8 * pgi;
    const sprite = getStarSprite(nodeCol, pgi);
    const drawSize = haloR * 2;

    ctx.globalAlpha = starAlpha;
    ctx.drawImage(sprite.canvas, fn.x - haloR, fn.y - haloR, drawSize, drawSize);
  }

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
  ctx.clearRect(0, 0, width, height);

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
  hoveredNode = n;
  if (n) {
    showTip(e.clientX, e.clientY, n.tree, currentStates);
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
