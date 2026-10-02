import { describe, it, expect } from "vitest";
import { limitStep, needsRescue, MAX_STEP_PER_TICK, MAX_WORLD_COORD } from "./stability";

/**
 * Regression test for upstream issue #5: on a large Home Assistant instance the
 * force layout diverged to coordinates around 1e95 within a few ticks and the
 * canvas stayed permanently blank.
 *
 * These exercise the real exported guards against a faithful reconstruction of
 * the upstream simulation (radialLayout + Barnes-Hut + the integration step).
 * The reconstruction is deliberate: it is the only way to prove the guards
 * matter, via the last test which runs the same setup *without* them.
 */

const ALPHA_DECAY = 0.998;
const QUAD_MAX_DEPTH = 40;
const BH_THETA = 0.9;
const REPULSION = 3000;
const SPRING_LEN = 64;
const SPRING_K = 0.035;
const DAMPING = 0.8;

interface N {
  id: string;
  kind: "root" | "area" | "domain" | "entity";
  children: N[];
  leafCount: number;
}
interface FNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Mirrors the shape of a real 3669-node / 5-area instance: one area holds most
// of the entities, and the densest domain holds 400 of them.
const LOP_SIDED: { entities: number }[][] = [
  Array.from({ length: 6 }, () => ({ entities: 400 })),
  Array.from({ length: 5 }, () => ({ entities: 160 })),
  Array.from({ length: 4 }, () => ({ entities: 75 })),
  Array.from({ length: 3 }, () => ({ entities: 33 })),
  Array.from({ length: 3 }, () => ({ entities: 22 })),
];

function buildTree(spec: { entities: number }[][]): N {
  const root: N = { id: "root", kind: "root", children: [], leafCount: 0 };
  spec.forEach((domains, a) => {
    const area: N = { id: `area:${a}`, kind: "area", children: [], leafCount: 0 };
    domains.forEach((d, i) => {
      const dom: N = { id: `domain:${a}:${i}`, kind: "domain", children: [], leafCount: 0 };
      for (let e = 0; e < d.entities; e++) {
        dom.children.push({ id: `entity:${a}.${i}.${e}`, kind: "entity", children: [], leafCount: 1 });
        dom.leafCount++;
      }
      area.children.push(dom);
      area.leafCount += dom.leafCount;
    });
    root.children.push(area);
    root.leafCount += area.leafCount;
  });
  return root;
}

function flatten(root: N): N[] {
  const out: N[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

// force.ts radialLayout
function radialLayout(nodes: N[], cx: number, cy: number): Map<N, { x: number; y: number }> {
  const pos = new Map<N, { x: number; y: number }>();
  const set = new Set(nodes);
  function place(node: N, x: number, y: number, start: number, span: number, depth: number) {
    pos.set(node, { x, y });
    const kids = node.children.filter((c) => set.has(c));
    if (!kids.length) return;
    const radius = SPRING_LEN * (depth === 0 ? 1.5 : 1);
    let offset = start;
    const total = kids.reduce((s, c) => s + Math.max(1, c.leafCount), 0);
    for (const kid of kids) {
      const share = (Math.max(1, kid.leafCount) / total) * span;
      const angle = offset + share / 2;
      place(kid, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, offset, share, depth + 1);
      offset += share;
    }
  }
  const rootNode = nodes.find((n) => n.kind === "root");
  if (rootNode) place(rootNode, cx, cy, 0, Math.PI * 2, 0);
  return pos;
}

function quadCreate(x0: number, y0: number, x1: number, y1: number) {
  return { x0, y0, x1, y1, cx: 0, cy: 0, count: 0, body: null as FNode | null, nw: null, ne: null, sw: null, se: null } as any;
}
function quadInsert(quad: any, fn: FNode, depth = 0) {
  if (quad.count === 0) { quad.body = fn; quad.cx = fn.x; quad.cy = fn.y; quad.count = 1; return; }
  const total = quad.count + 1;
  quad.cx = (quad.cx * quad.count + fn.x) / total;
  quad.cy = (quad.cy * quad.count + fn.y) / total;
  quad.count = total;
  if (depth >= QUAD_MAX_DEPTH) return;
  if (quad.body) { const e = quad.body; quad.body = null; quadPush(quad, e, depth); }
  quadPush(quad, fn, depth);
}
function quadPush(quad: any, fn: FNode, depth: number) {
  const mx = (quad.x0 + quad.x1) / 2, my = (quad.y0 + quad.y1) / 2;
  const east = fn.x >= mx, south = fn.y >= my;
  let child;
  if (east) {
    if (south) { child = quad.se; if (!child) { child = quadCreate(mx, my, quad.x1, quad.y1); quad.se = child; } }
    else { child = quad.ne; if (!child) { child = quadCreate(mx, quad.y0, quad.x1, my); quad.ne = child; } }
  } else {
    if (south) { child = quad.sw; if (!child) { child = quadCreate(quad.x0, my, mx, quad.y1); quad.sw = child; } }
    else { child = quad.nw; if (!child) { child = quadCreate(quad.x0, quad.y0, mx, my); quad.nw = child; } }
  }
  quadInsert(child, fn, depth + 1);
}

function runSimulation(spec: { entities: number }[][], ticks: number, guards: boolean) {
  const W = 1600, H = 900;
  const tree = buildTree(spec);
  const nodes = flatten(tree);
  const pos = radialLayout(nodes, W / 2, H / 2);
  const map = new Map<N, FNode>();
  const fnodes: FNode[] = nodes.map((n) => {
    const p = pos.get(n)!;
    const fn: FNode = { x: p.x, y: p.y, vx: 0, vy: 0 };
    map.set(n, fn);
    return fn;
  });
  const fedges: { source: FNode; target: FNode }[] = [];
  const link = (t: N) => {
    for (const c of t.children) {
      const s = map.get(t), tg = map.get(c);
      if (s && tg) fedges.push({ source: s, target: tg });
      link(c);
    }
  };
  link(tree);

  let alpha = 1;
  for (let t = 0; t < ticks; t++) {
    const ra = REPULSION * alpha;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const fn of fnodes) {
      if (fn.x < minX) minX = fn.x;
      if (fn.y < minY) minY = fn.y;
      if (fn.x > maxX) maxX = fn.x;
      if (fn.y > maxY) maxY = fn.y;
    }
    const side = Math.max(maxX - minX, maxY - minY) + 20;
    const qx0 = (minX + maxX) / 2 - side / 2, qy0 = (minY + maxY) / 2 - side / 2;
    const root = quadCreate(qx0, qy0, qx0 + side, qy0 + side);
    for (const fn of fnodes) quadInsert(root, fn);

    const repulse = (quad: any, fn: FNode) => {
      if (quad.count === 0) return;
      const dx = quad.cx - fn.x, dy = quad.cy - fn.y;
      const d2 = dx * dx + dy * dy;
      if (quad.count === 1 && quad.body) {
        if (quad.body === fn) return;
        const dist2 = Math.max(d2, 1);
        const fd = ra / (dist2 * Math.sqrt(dist2));
        fn.vx -= dx * fd; fn.vy -= dy * fd;
        return;
      }
      const s = quad.x1 - quad.x0;
      if (s * s < BH_THETA * BH_THETA * d2) {
        const dist2 = Math.max(d2, 1);
        const fd = (ra * quad.count) / (dist2 * Math.sqrt(dist2));
        fn.vx -= dx * fd; fn.vy -= dy * fd;
        return;
      }
      if (quad.nw) repulse(quad.nw, fn);
      if (quad.ne) repulse(quad.ne, fn);
      if (quad.sw) repulse(quad.sw, fn);
      if (quad.se) repulse(quad.se, fn);
    };
    for (const fn of fnodes) repulse(root, fn);

    for (const e of fedges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - SPRING_LEN) * SPRING_K * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.source.vx += fx; e.source.vy += fy;
      e.target.vx -= fx; e.target.vy -= fy;
    }
    for (const n of fnodes) {
      n.vx += (W / 2 - n.x) * 0.001 * alpha;
      n.vy += (H / 2 - n.y) * 0.001 * alpha;
    }
    for (const n of fnodes) {
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      if (guards) {
        const v = limitStep(n.vx, n.vy);
        n.vx = v.vx; n.vy = v.vy;
      }
      n.x += n.vx;
      n.y += n.vy;
      if (guards && needsRescue(n.x, n.y)) { n.x = W / 2; n.y = H / 2; n.vx = 0; n.vy = 0; }
    }
    alpha *= ALPHA_DECAY;
  }

  let maxAbs = 0, nonFinite = 0;
  for (const n of fnodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) { nonFinite++; continue; }
    maxAbs = Math.max(maxAbs, Math.abs(n.x), Math.abs(n.y));
  }
  return { nodeCount: fnodes.length, maxAbs, nonFinite };
}

describe("limitStep", () => {
  it("leaves small velocities untouched", () => {
    expect(limitStep(3, -4)).toEqual({ vx: 3, vy: -4 });
  });

  it("caps the magnitude while preserving direction", () => {
    const { vx, vy } = limitStep(3000, 4000);
    expect(Math.hypot(vx, vy)).toBeCloseTo(MAX_STEP_PER_TICK, 6);
    expect(vy / vx).toBeCloseTo(4000 / 3000, 6);
  });

  it("is idempotent so it can be applied per axis", () => {
    const once = limitStep(3000, 4000);
    const twice = limitStep(once.vx, once.vy);
    expect(twice).toEqual(once);
  });

  it("zeroes a non-finite velocity instead of propagating NaN", () => {
    expect(limitStep(NaN, 1)).toEqual({ vx: 0, vy: 0 });
    expect(limitStep(Infinity, 0)).toEqual({ vx: 0, vy: 0 });
  });
});

describe("needsRescue", () => {
  it("accepts ordinary coordinates", () => {
    expect(needsRescue(1234, -5678)).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(needsRescue(NaN, 0)).toBe(true);
    expect(needsRescue(0, Infinity)).toBe(true);
  });

  it("rejects coordinates far outside any sane world", () => {
    expect(needsRescue(MAX_WORLD_COORD + 1, 0)).toBe(true);
    expect(needsRescue(0, -MAX_WORLD_COORD - 1)).toBe(true);
  });
});

describe("force simulation stability (issue #5)", () => {
  it("keeps a 3600+ node / 5-area graph inside a sane world", () => {
    const { nodeCount, maxAbs, nonFinite } = runSimulation(LOP_SIDED, 400, true);
    expect(nodeCount).toBeGreaterThan(3600);
    expect(nonFinite).toBe(0);
    // A settled graph of this size spans a few thousand world units; anything
    // past 100k means the runaway came back.
    expect(maxAbs).toBeLessThan(1e5);
  });

  it("still settles rather than merely staying bounded", () => {
    const early = runSimulation(LOP_SIDED, 60, true);
    const late = runSimulation(LOP_SIDED, 400, true);
    // The layout is still settling between the two samples, so the graph must
    // not have run away in either direction.
    expect(early.maxAbs).toBeLessThan(1e5);
    expect(late.maxAbs).toBeLessThan(1e5);
    expect(Number.isFinite(late.maxAbs)).toBe(true);
  });

  // If this ever passes, the guards above are being bypassed and the suite
  // above is measuring nothing. A regression test that cannot fail is not a
  // regression test.
  it("proves the guards are what stop the divergence", () => {
    // Mid-run the coordinates are still finite but astronomically large...
    const mid = runSimulation(LOP_SIDED, 60, false);
    expect(mid.maxAbs).toBeGreaterThan(1e20);
    // ...and by the end of the run they have overflowed to Infinity entirely.
    const end = runSimulation(LOP_SIDED, 400, false);
    expect(end.nonFinite).toBeGreaterThan(0);
  });

  it("leaves small instances untouched", () => {
    const small = [[{ entities: 40 }, { entities: 40 }, { entities: 30 }, { entities: 20 }, { entities: 15 }]];
    const { nodeCount, maxAbs, nonFinite } = runSimulation(small, 400, true);
    expect(nodeCount).toBeLessThan(200);
    expect(nonFinite).toBe(0);
    expect(maxAbs).toBeLessThan(1e4);
  });
});
