const DEFAULT_DOMAIN_COLORS: Record<string, string> = {
  light: "#ffca28",
  switch: "#66bb6a",
  sensor: "#42a5f5",
  binary_sensor: "#ab47bc",
  climate: "#ef5350",
  cover: "#78909c",
  media_player: "#ec407a",
  camera: "#26a69a",
  fan: "#29b6f6",
  lock: "#ffa726",
  vacuum: "#8d6e63",
  automation: "#7e57c2",
  script: "#5c6bc0",
  scene: "#26c6da",
  input_boolean: "#9ccc65",
  input_number: "#d4e157",
  input_select: "#ffee58",
  input_text: "#fff176",
  input_datetime: "#ffcc80",
  person: "#ff7043",
  device_tracker: "#ff8a65",
  zone: "#a1887f",
  sun: "#fdd835",
  weather: "#4fc3f7",
  update: "#ce93d8",
  button: "#4db6ac",
  number: "#aed581",
  select: "#81c784",
  text: "#90a4ae",
  timer: "#f48fb1",
  counter: "#80cbc4",
  group: "#b0bec5",
};

const DOMAIN_COLORS: Record<string, string> = { ...DEFAULT_DOMAIN_COLORS };

const KIND_COLORS: Record<string, string> = {
  root: "#e0e0e0",
  area: "#b0bec5",
  domain: "#90a4ae",
  device: "#80cbc4",
};

const DEFAULT_COLOR = "#607d8b";

export function nodeColor(kind: string, domain?: string): string {
  if (kind === "entity" || kind === "domain") {
    return (domain && DOMAIN_COLORS[domain]) ?? DEFAULT_COLOR;
  }
  return KIND_COLORS[kind] ?? DEFAULT_COLOR;
}

function randomHslColor(): string {
  const h = Math.floor(Math.random() * 360);
  const s = 50 + Math.floor(Math.random() * 40);
  const l = 45 + Math.floor(Math.random() * 25);
  const r = hslToHex(h, s, l);
  return r;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${f(0).toString(16).padStart(2, "0")}${f(8).toString(16).padStart(2, "0")}${f(4).toString(16).padStart(2, "0")}`;
}

export function randomizeColors(): void {
  for (const key of Object.keys(DOMAIN_COLORS)) {
    DOMAIN_COLORS[key] = randomHslColor();
  }
}

export function resetColors(): void {
  for (const key of Object.keys(DEFAULT_DOMAIN_COLORS)) {
    DOMAIN_COLORS[key] = DEFAULT_DOMAIN_COLORS[key];
  }
}
