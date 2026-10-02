import { describe, it, expect } from "vitest";
import { createTransform, fitTransform, screenToWorld, wheelZoomFactor, zoomAt, MIN_ZOOM } from "./zoom";

describe("zoomAt", () => {
  it("keeps the world point under the zoom center fixed", () => {
    const t = { x: 30, y: -20, k: 1.5 };
    const before = screenToWorld(t, 200, 150);
    zoomAt(t, 2, 200, 150);
    const after = screenToWorld(t, 200, 150);
    expect(t.k).toBe(3);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps the zoom level", () => {
    const t = createTransform();
    zoomAt(t, 1000, 0, 0);
    expect(t.k).toBe(20);
    zoomAt(t, 0.00001, 0, 0);
    expect(t.k).toBe(MIN_ZOOM);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on scroll up and out on scroll down", () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
  });

  it("scales with scroll distance so small trackpad deltas zoom gently", () => {
    const small = wheelZoomFactor(-4, 0);
    const notch = wheelZoomFactor(-100, 0);
    expect(small).toBeGreaterThan(1);
    expect(Math.log(notch) / Math.log(small)).toBeCloseTo(25);
  });

  it("treats line-mode deltas as pixels and clamps large jumps", () => {
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
    expect(wheelZoomFactor(-10000, 0)).toBeCloseTo(wheelZoomFactor(-150, 0));
  });
});

describe("fitTransform", () => {
  it("centres the box in the viewport", () => {
    const t = createTransform();
    expect(fitTransform(t, { minX: -3000, minY: -2000, maxX: 3000, maxY: 2000 }, 1000, 800)).toBe(true);
    const centre = screenToWorld(t, 500, 400);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
  });

  it("brings a box much larger than the viewport into view", () => {
    // The bug this exists for: with the identity transform a graph wider than
    // the viewport is only visible as an off-centre fragment.
    const t = createTransform();
    const box = { minX: -2700, minY: -2700, maxX: 2700, maxY: 2700 };
    expect(fitTransform(t, box, 1200, 800)).toBe(true);
    expect(t.k).toBeLessThan(1);
    for (const corner of [box.minX, box.maxX]) {
      const sx = corner * t.k + t.x;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(1200);
    }
  });

  it("does not zoom in past 1 for a box smaller than the viewport", () => {
    const t = createTransform();
    fitTransform(t, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1000, 800);
    expect(t.k).toBeLessThanOrEqual(1);
  });

  it("keeps the zoom within its clamp for a degenerate box", () => {
    const t = createTransform();
    fitTransform(t, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, 1000, 800);
    expect(t.k).toBeGreaterThan(0);
    expect(Number.isFinite(t.k)).toBe(true);
  });

  it("frames a very large graph - the floor has to be low enough", () => {
    // A 50k-node layout settles around 10,000 world units wide, which needs
    // k ~ 0.08. With the old 0.1 floor the fit silently clamped and left part
    // of the graph off screen.
    const box = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };
    const t = createTransform();
    expect(fitTransform(t, box, 1200, 800)).toBe(true);
    const kNeeded = Math.min((1200 - 80) / 10000, (800 - 80) / 10000);
    expect(t.k).toBeLessThanOrEqual(kNeeded + 1e-9);
    expect(t.k).toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  it("refuses to fit into a viewport that has no size yet", () => {
    const t = createTransform();
    expect(fitTransform(t, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 0)).toBe(false);
    expect(t).toEqual({ x: 0, y: 0, k: 1 });
  });

  it("refuses a box full of non-finite coordinates", () => {
    const t = createTransform();
    expect(fitTransform(t, { minX: NaN, minY: 0, maxX: 10, maxY: 10 }, 800, 600)).toBe(false);
  });
});
