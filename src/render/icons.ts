// Icon resolution. Tries Home Assistant's <ha-icon> (panel mode) first, then
// falls back to the public Iconify API (standalone mode).

import { debugLog } from "../debug";

const HA_DOMAIN_ICONS: Record<string, string> = {
  light: "mdi:lightbulb",
  switch: "mdi:toggle-switch-variant",
  sensor: "mdi:eye",
  binary_sensor: "mdi:radiobox-blank",
  climate: "mdi:thermostat",
  cover: "mdi:window-shutter",
  media_player: "mdi:cast",
  camera: "mdi:video",
  fan: "mdi:fan",
  lock: "mdi:lock",
  vacuum: "mdi:robot-vacuum",
  automation: "mdi:robot",
  script: "mdi:script-text",
  scene: "mdi:palette",
  input_boolean: "mdi:toggle-switch",
  input_number: "mdi:ray-vertex",
  input_select: "mdi:format-list-bulleted",
  input_text: "mdi:form-textbox",
  input_datetime: "mdi:calendar-clock",
  input_button: "mdi:gesture-tap-button",
  button: "mdi:button-pointer",
  number: "mdi:ray-vertex",
  select: "mdi:format-list-bulleted",
  text: "mdi:form-textbox",
  person: "mdi:account",
  device_tracker: "mdi:account-arrow-right",
  zone: "mdi:map-marker-radius",
  sun: "mdi:white-balance-sunny",
  weather: "mdi:weather-partly-cloudy",
  update: "mdi:package-up",
  timer: "mdi:timer-outline",
  counter: "mdi:counter",
  group: "mdi:google-circles-communities",
  remote: "mdi:remote",
  siren: "mdi:bullhorn",
  humidifier: "mdi:air-humidifier",
  water_heater: "mdi:thermometer",
  valve: "mdi:pipe-valve",
};

interface ResolvedIcon {
  path: Path2D;
  viewBox: number;
}

type IconState = ResolvedIcon | "pending" | null;

const iconCache = new Map<string, IconState>();

let onIconResolved: (() => void) | null = null;

export function setIconResolveCallback(cb: (() => void) | null): void {
  onIconResolved = cb;
}

export function getEntityIconName(
  domain: string | undefined,
  stateAttrIcon: unknown,
): string | null {
  if (typeof stateAttrIcon === "string" && stateAttrIcon.startsWith("mdi:")) {
    return stateAttrIcon;
  }
  if (domain && HA_DOMAIN_ICONS[domain]) return HA_DOMAIN_ICONS[domain];
  return null;
}

export function getCachedIcon(name: string): ResolvedIcon | null {
  const v = iconCache.get(name);
  return v && v !== "pending" ? v : null;
}

export function requestIcon(name: string): void {
  if (iconCache.has(name)) return;
  iconCache.set(name, "pending");
  void resolveIcon(name);
}

async function tryHaIcon(name: string): Promise<ResolvedIcon | null> {
  if (!customElements.get("ha-icon")) return null;
  const el = document.createElement("ha-icon") as HTMLElement & { icon?: string };
  el.setAttribute("icon", name);
  el.icon = name;
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  try {
    for (let i = 0; i < 60; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const svgIcon = el.shadowRoot?.querySelector("ha-svg-icon") as
        | (HTMLElement & { path?: string; viewBox?: string })
        | null;
      const path = svgIcon?.path;
      if (typeof path === "string" && path.length > 0) {
        const vb = parseViewBoxSize(svgIcon?.viewBox);
        return { path: new Path2D(path), viewBox: vb };
      }
    }
    return null;
  } finally {
    el.remove();
  }
}

function parseViewBoxSize(vb: string | undefined): number {
  if (!vb) return 24;
  const parts = vb.trim().split(/\s+/);
  if (parts.length !== 4) return 24;
  const w = Number(parts[2]);
  return Number.isFinite(w) && w > 0 ? w : 24;
}

async function tryIconify(name: string): Promise<ResolvedIcon | null> {
  const colon = name.indexOf(":");
  if (colon < 0) return null;
  const prefix = name.slice(0, colon);
  const iconName = name.slice(colon + 1);
  if (!prefix || !iconName) return null;
  try {
    const res = await fetch(`https://api.iconify.design/${prefix}/${iconName}.svg`);
    if (!res.ok) return null;
    const svg = await res.text();
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.querySelector("parsererror")) return null;
    const root = doc.documentElement;
    const viewBox = parseViewBoxSize(root.getAttribute("viewBox") ?? undefined);
    const paths = Array.from(doc.querySelectorAll("path"))
      .map((p) => p.getAttribute("d"))
      .filter((d): d is string => !!d && d.length > 0);
    if (paths.length === 0) return null;
    return { path: new Path2D(paths.join(" ")), viewBox };
  } catch {
    return null;
  }
}

async function resolveIcon(name: string): Promise<void> {
  let icon = await tryHaIcon(name);
  let source = "ha-icon";
  if (!icon) {
    icon = await tryIconify(name);
    source = "iconify";
  }
  if (icon) {
    iconCache.set(name, icon);
    debugLog("system", `Icon resolved via ${source}: ${name} (vb ${icon.viewBox})`);
    if (onIconResolved) onIconResolved();
    return;
  }
  debugLog("system", `Icon unresolved: ${name}`);
  iconCache.set(name, null);
}

