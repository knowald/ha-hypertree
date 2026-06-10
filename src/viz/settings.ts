const SETTINGS_KEY = "ha-hypertree-force-settings";

export type StarEffect = "supernova" | "shooting-star" | "flare" | "pulse-wave" | "color-shift";
export type UnavailableMode = "normal" | "pulse" | "ring" | "hidden" | "only";
export type InitialLayout = "tree" | "scatter";
export type GroupMode = "area" | "domain";
export type StructureMode = "domain" | "device";

export interface ForceSettings {
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

export const defaults: ForceSettings = {
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
  appearOnChange: false,
  backgroundColor: "#000000",
  initialLayout: "tree",
  hiddenDomains: [],
  hiddenAreas: [],
  stateFilter: "",
  searchAsFilter: false,
};

function loadSettings(): ForceSettings {
  const result = structuredClone(defaults);
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Migrate old boolean pulseUnavailable to unavailableMode
    if ("pulseUnavailable" in parsed && !("unavailableMode" in parsed)) {
      parsed.unavailableMode = parsed.pulseUnavailable ? "pulse" : "normal";
    }
    // Copy known keys only, so settings removed in newer versions do not
    // linger in storage forever.
    for (const key of Object.keys(result) as (keyof ForceSettings)[]) {
      if (key in parsed) {
        (result as unknown as Record<string, unknown>)[key] = parsed[key];
      }
    }
  } catch (err) {
    console.warn("ha-hypertree: failed to load saved settings, using defaults", err);
  }
  return result;
}

// Single mutable settings object shared by the viz and the settings panel.
// Mutate fields directly, then call saveSettings() to persist.
export const settings: ForceSettings = loadSettings();

export function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

export function applySettings(partial: Partial<ForceSettings>): void {
  Object.assign(settings, structuredClone(defaults), partial);
  saveSettings();
}
