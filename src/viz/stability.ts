/**
 * Stability rails for the force simulation (upstream issue #5).
 *
 * radialLayout places siblings by angular share, so a domain holding hundreds
 * of entities starts them a fraction of a pixel apart - a 400-entity domain
 * packs at ~0.11px. The Barnes-Hut cell covering that ring multiplies repulsion
 * by its body count, so one crowded cell injects a velocity of
 * repulsion*count/d^2. With d floored at 1 that is 3000*400 = 1.2e6 world
 * units per tick for a single node. Positions explode, the quadtree bounds are
 * recomputed from them and balloon with them, and the next tick is worse.
 *
 * Measured on a 3692-node graph (5 areas, 3664 entities): 1e4 at tick 1,
 * 1e49 at tick 49, 1e135 at tick 149, all-Infinity by tick 399 - which is
 * what leaves the canvas permanently blank. Softening the distance does not
 * help, because the runaway is the count multiplier rather than the distance
 * floor. Capping the per-tick step breaks the feedback loop.
 */

/** Largest distance a node may travel in one tick. */
export const MAX_STEP_PER_TICK = 60;

/** Past this, a coordinate means the layout is already lost. */
export const MAX_WORLD_COORD = 5e5;

export interface Vec2 {
  vx: number;
  vy: number;
}

/**
 * Cap the magnitude of a velocity. Idempotent, so applying it once per axis
 * is equivalent to applying it once to the vector.
 */
export function limitStep(vx: number, vy: number): Vec2 {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return { vx: 0, vy: 0 };
  const v = Math.hypot(vx, vy);
  if (v <= MAX_STEP_PER_TICK) return { vx, vy };
  const k = MAX_STEP_PER_TICK / v;
  return { vx: vx * k, vy: vy * k };
}

/** True for a node whose position can no longer be trusted. */
export function needsRescue(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return Math.abs(x) > MAX_WORLD_COORD || Math.abs(y) > MAX_WORLD_COORD;
}
