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

export function setupSvgZoom(
  svg: SVGSVGElement,
  group: SVGGElement,
  transform: ZoomTransform
): () => void {
  function applyTransform(): void {
    group.setAttribute("transform", `translate(${transform.x},${transform.y}) scale(${transform.k})`);
  }

  let panning = false;
  let startX = 0, startY = 0;

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    applyWheel(transform, e, svg.getBoundingClientRect());
    applyTransform();
  }

  function onMouseDown(e: MouseEvent): void {
    if (e.button === 1 || (e.button === 0 && !(e.target as SVGElement).dataset.idx)) {
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
    }
  }

  function onMouseMove(e: MouseEvent): void {
    if (!panning) return;
    transform.x += e.clientX - startX;
    transform.y += e.clientY - startY;
    startX = e.clientX;
    startY = e.clientY;
    applyTransform();
  }

  function onMouseUp(): void {
    panning = false;
  }

  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("mousedown", onMouseDown);
  svg.addEventListener("mousemove", onMouseMove);
  svg.addEventListener("mouseup", onMouseUp);
  svg.addEventListener("mouseleave", onMouseUp);

  return () => {
    svg.removeEventListener("wheel", onWheel);
    svg.removeEventListener("mousedown", onMouseDown);
    svg.removeEventListener("mousemove", onMouseMove);
    svg.removeEventListener("mouseup", onMouseUp);
    svg.removeEventListener("mouseleave", onMouseUp);
  };
}
