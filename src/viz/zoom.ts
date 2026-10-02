export interface ZoomTransform {
  x: number;
  y: number;
  k: number;
}

// A typical mouse wheel notch is ~100px, which gives a ~35% step.
const ZOOM_PER_PIXEL = 0.003;
const MAX_WHEEL_PIXELS = 150;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;
// Low enough that fitAll() can still frame a very large graph: a 50k-node
// layout settles around 10,000 world units wide, which needs k ~ 0.08. Text
// is not a problem at these scales because entity labels are already hidden
// below settings.entityLabelZoom, and the tiered label thresholds in
// drawLabels() fade the rest out.
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 20;
export { MIN_ZOOM, MAX_ZOOM };

export interface WorldBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Frame a world-space box inside a viewport.
 *
 * The default transform is the identity, which anchors the world origin to the
 * top-left of the canvas. A graph that spreads wider than the viewport is then
 * only visible as an off-centre fragment, and "Reset positions" puts it back
 * that way. Framing explicitly is the only way back from there.
 *
 * Never scales past 1:1. Fitting a small graph to fill the screen is not what
 * this is for - the goal is only to guarantee the whole graph is on screen, and
 * a 10-node graph blown up 7x on load is more surprising than useful.
 *
 * Returns false when the viewport has no size yet, so callers can retry.
 */
export function fitTransform(t: ZoomTransform, box: WorldBox, vw: number, vh: number, margin = 40): boolean {
  if (vw <= 0 || vh <= 0) return false;
  if (!Number.isFinite(box.minX) || !Number.isFinite(box.minY) ||
      !Number.isFinite(box.maxX) || !Number.isFinite(box.maxY)) return false;

  const boxW = Math.max(box.maxX - box.minX, 1);
  const boxH = Math.max(box.maxY - box.minY, 1);
  const k = Math.max(MIN_ZOOM, Math.min(1,
    Math.min((vw - margin * 2) / boxW, (vh - margin * 2) / boxH)));

  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  t.k = k;
  t.x = vw / 2 - cx * k;
  t.y = vh / 2 - cy * k;
  return true;
}

export function createTransform(): ZoomTransform {
  return { x: 0, y: 0, k: 1 };
}

export function applyWheel(t: ZoomTransform, e: WheelEvent, rect: DOMRect): void {
  zoomAt(t, wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - rect.left, e.clientY - rect.top);
}

// Trackpads fire many small-delta events per gesture, so a fixed step per
// event zooms far too fast; scale by the scrolled distance instead.
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === WHEEL_DELTA_LINE ? deltaY * LINE_HEIGHT_PX
    : deltaMode === WHEEL_DELTA_PAGE ? deltaY * PAGE_HEIGHT_PX
      : deltaY;
  const clamped = Math.max(-MAX_WHEEL_PIXELS, Math.min(MAX_WHEEL_PIXELS, pixels));
  return Math.exp(-clamped * ZOOM_PER_PIXEL);
}

export function zoomAt(t: ZoomTransform, factor: number, sx: number, sy: number): void {
  const oldK = t.k;
  const newK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldK * factor));
  t.x = sx - (sx - t.x) * (newK / oldK);
  t.y = sy - (sy - t.y) * (newK / oldK);
  t.k = newK;
}

export function screenToWorld(t: ZoomTransform, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - t.x) / t.k,
    y: (sy - t.y) / t.k,
  };
}
