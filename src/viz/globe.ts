import type { Visualization } from "./types";
import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import { color, showTip, hideTip, flatten } from "./shared";

interface GlobeNode {
  node: TreeNode;
  theta: number;
  phi: number;
  r: number;
}

let canvas: HTMLCanvasElement | null = null;
let currentStates: Map<string, HaState> = new Map();
let globeNodes: GlobeNode[] = [];
let width = 0, height = 0;
let rotX = 0.3;
let rotY = -0.5;
let frame = 0;
let dragging = false;
let lastMx = 0, lastMy = 0;
let velX = 0, velY = 0;
let autoRotate = true;
let globeScale = 1;

const ZOOM_FACTOR = 1.1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

export const globeViz: Visualization = {
  name: "Globe",

  create(container, root, states) {
    currentStates = states;
    autoRotate = true;
    rotX = 0.3;
    rotY = -0.5;
    globeScale = 1;

    canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas);

    const obs = new ResizeObserver(() => resize());
    obs.observe(container);
    (canvas as any).__obs = obs;

    buildGlobe(root);
    resize();

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", () => { dragging = false; hideTip(); });
    canvas.addEventListener("wheel", onWheel, { passive: false });

    frame = requestAnimationFrame(tick);
  },

  destroy() {
    cancelAnimationFrame(frame);
    frame = 0;
    if (canvas) {
      (canvas as any).__obs?.disconnect();
      canvas = null;
    }
    globeNodes = [];
    dragging = false;
  },

  updateStates(states) {
    currentStates = states;
  },
};

function buildGlobe(root: TreeNode): void {
  const nodes = flatten(root);
  const leaves = nodes.filter((n) => n.children.length === 0);
  const nonLeaves = nodes.filter((n) => n.children.length > 0 && n !== root);

  globeNodes = [];

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < leaves.length; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / leaves.length);
    const theta = goldenAngle * i;
    globeNodes.push({ node: leaves[i], theta, phi, r: 2 });
  }

  const posMap = new Map<TreeNode, { theta: number; phi: number }>();
  for (const gn of globeNodes) {
    posMap.set(gn.node, { theta: gn.theta, phi: gn.phi });
  }

  for (const n of nonLeaves.reverse()) {
    let sx = 0, sy = 0, sz = 0;
    let count = 0;
    for (const child of n.children) {
      const pos = posMap.get(child);
      if (!pos) continue;
      sx += Math.sin(pos.phi) * Math.cos(pos.theta);
      sy += Math.sin(pos.phi) * Math.sin(pos.theta);
      sz += Math.cos(pos.phi);
      count++;
    }
    if (count > 0) {
      sx /= count;
      sy /= count;
      sz /= count;
      const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      const phi = Math.acos(sz / len);
      const theta = Math.atan2(sy, sx);
      posMap.set(n, { theta, phi });
      const r = n.kind === "area" ? 5 : n.kind === "domain" ? 4 : 3;
      globeNodes.push({ node: n, theta, phi, r });
    }
  }

  globeNodes.push({ node: root, theta: 0, phi: 0, r: 6 });
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

  if (autoRotate && !dragging) {
    rotY += 0.003;
  }

  if (!dragging) {
    velX *= 0.95;
    velY *= 0.95;
    rotX += velX;
    rotY += velY;
  }

  draw();
  frame = requestAnimationFrame(tick);
}

function project(theta: number, phi: number): { x: number; y: number; z: number } {
  const sx = Math.sin(phi) * Math.cos(theta);
  const sy = Math.sin(phi) * Math.sin(theta);
  const sz = Math.cos(phi);

  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);
  const y1 = sy * cosX - sz * sinX;
  const z1 = sy * sinX + sz * cosX;

  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const x2 = sx * cosY + z1 * sinY;
  const z2 = -sx * sinY + z1 * cosY;

  return { x: x2, y: y1, z: z2 };
}

function draw(): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d")!;
  const dpr = devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const baseR = Math.min(cx, cy) - 30;
  const globeR = baseR * globeScale;

  ctx.beginPath();
  ctx.arc(cx, cy, globeR, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1a2e";
  ctx.fill();
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = "#222";
  ctx.lineWidth = 0.5;
  for (let lat = -60; lat <= 60; lat += 30) {
    ctx.beginPath();
    const phi = (90 - lat) * Math.PI / 180;
    for (let i = 0; i <= 360; i += 5) {
      const theta = i * Math.PI / 180;
      const p = project(theta, phi);
      if (p.z < 0) continue;
      const screenX = cx + p.x * globeR;
      const screenY = cy - p.y * globeR;
      if (i === 0) ctx.moveTo(screenX, screenY);
      else ctx.lineTo(screenX, screenY);
    }
    ctx.stroke();
  }

  const projected = globeNodes.map((gn) => {
    const p = project(gn.theta, gn.phi);
    return { gn, x: cx + p.x * globeR, y: cy - p.y * globeR, z: p.z };
  });
  projected.sort((a, b) => a.z - b.z);

  for (const item of projected) {
    if (item.z < -0.1) continue;

    const opacity = Math.max(0.15, Math.min(1, item.z + 0.5));
    const r = item.gn.r * globeScale * (0.6 + 0.4 * Math.max(0, item.z));

    ctx.beginPath();
    ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color(item.gn.node);
    ctx.globalAlpha = opacity;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function hitTest(mx: number, my: number): GlobeNode | null {
  const cx = width / 2;
  const cy = height / 2;
  const baseR = Math.min(cx, cy) - 30;
  const globeR = baseR * globeScale;

  let closest: GlobeNode | null = null;
  let closestDist = Infinity;

  for (const gn of globeNodes) {
    const p = project(gn.theta, gn.phi);
    if (p.z < 0) continue;
    const sx = cx + p.x * globeR;
    const sy = cy - p.y * globeR;
    const dx = mx - sx;
    const dy = my - sy;
    const dist = dx * dx + dy * dy;
    const hitR = (gn.r * globeScale + 3);
    if (dist < hitR * hitR && dist < closestDist) {
      closestDist = dist;
      closest = gn;
    }
  }
  return closest;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const direction = e.deltaY < 0 ? 1 : -1;
  const newScale = direction > 0
    ? globeScale * ZOOM_FACTOR
    : globeScale / ZOOM_FACTOR;
  globeScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
}

function onMouseDown(e: MouseEvent): void {
  dragging = true;
  autoRotate = false;
  lastMx = e.clientX;
  lastMy = e.clientY;
  velX = 0;
  velY = 0;
}

function onMouseMove(e: MouseEvent): void {
  if (dragging) {
    const dx = e.clientX - lastMx;
    const dy = e.clientY - lastMy;
    velX = -dy * 0.005;
    velY = dx * 0.005;
    rotX += velX;
    rotY += velY;
    lastMx = e.clientX;
    lastMy = e.clientY;
  }

  const gn = hitTest(e.offsetX, e.offsetY);
  if (gn) showTip(e.clientX, e.clientY, gn.node, currentStates);
  else hideTip();
}

function onMouseUp(): void {
  dragging = false;
}
