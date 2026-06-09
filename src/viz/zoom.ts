export interface ZoomTransform {
  x: number;
  y: number;
  k: number;
}

const ZOOM_FACTOR = 1.1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;

export function createTransform(): ZoomTransform {
  return { x: 0, y: 0, k: 1 };
}

export function applyWheel(t: ZoomTransform, e: WheelEvent, rect: DOMRect): void {
  const oldK = t.k;
  const direction = e.deltaY < 0 ? 1 : -1;
  const newK = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
    direction > 0 ? oldK * ZOOM_FACTOR : oldK / ZOOM_FACTOR
  ));

  const cursorX = e.clientX - rect.left;
  const cursorY = e.clientY - rect.top;

  t.x = cursorX - (cursorX - t.x) * (newK / oldK);
  t.y = cursorY - (cursorY - t.y) * (newK / oldK);
  t.k = newK;
}

export function screenToWorld(t: ZoomTransform, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - t.x) / t.k,
    y: (sy - t.y) / t.k,
  };
}
