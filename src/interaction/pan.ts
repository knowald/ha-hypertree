import type { Complex } from "../hyperbolic/complex";
import type { RenderState } from "../render/renderer";
import type { FocusState } from "./focus";
import { mobiusTranslateInv, applyFocus, clampToDisk } from "../hyperbolic/poincare";
import { render } from "../render/renderer";

const FRICTION = 0.92;
const MIN_VELOCITY = 0.0005;
const ZOOM_FACTOR = 1.15;
const MIN_VB_SIZE = 0.1;
const MAX_VB_SIZE = 4.0;
const DEFAULT_VB_SIZE = 2.1;

export function setupPan(
  renderState: RenderState,
  focusState: FocusState
): void {
  const svg = renderState.svg;
  let dragging = false;
  let lastPoint: Complex | null = null;
  let lastTime = 0;
  let velocity: Complex = [0, 0];
  let momentumFrame = 0;

  let vbX = -DEFAULT_VB_SIZE / 2;
  let vbY = -DEFAULT_VB_SIZE / 2;
  let vbW = DEFAULT_VB_SIZE;
  let vbH = DEFAULT_VB_SIZE;

  function setViewBox(): void {
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
  }

  function svgCoords(clientX: number, clientY: number): Complex {
    const rect = svg.getBoundingClientRect();
    const x = vbX + ((clientX - rect.left) / rect.width) * vbW;
    const y = vbY + ((clientY - rect.top) / rect.height) * vbH;
    return [x, y];
  }

  function applyDisplacement(dx: number, dy: number): void {
    const scale = 0.5;
    const displacement: Complex = [-dx * scale, -dy * scale];
    const newFocus = clampToDisk(
      mobiusTranslateInv(displacement, focusState.currentFocus)
    );
    focusState.currentFocus = newFocus;
    applyFocus(renderState.nodes, newFocus);
    render(renderState);
  }

  function momentumTick(): void {
    velocity = [velocity[0] * FRICTION, velocity[1] * FRICTION];
    const speed = Math.sqrt(velocity[0] ** 2 + velocity[1] ** 2);

    if (speed < MIN_VELOCITY || focusState.animating) {
      momentumFrame = 0;
      return;
    }

    applyDisplacement(velocity[0], velocity[1]);
    momentumFrame = requestAnimationFrame(momentumTick);
  }

  svg.addEventListener("pointerdown", (event: PointerEvent) => {
    const target = event.target as SVGElement;
    if (target.tagName === "circle" && target.classList.contains("node")) return;
    if (focusState.animating) return;

    if (momentumFrame) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = 0;
    }

    dragging = true;
    lastPoint = svgCoords(event.clientX, event.clientY);
    lastTime = performance.now();
    velocity = [0, 0];
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = "grabbing";
  });

  svg.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragging || !lastPoint) return;

    const currentPoint = svgCoords(event.clientX, event.clientY);
    const now = performance.now();
    const dt = Math.max(now - lastTime, 1);

    const delta: Complex = [
      currentPoint[0] - lastPoint[0],
      currentPoint[1] - lastPoint[1],
    ];

    const instantVelocity: Complex = [delta[0] / dt * 16, delta[1] / dt * 16];
    velocity = [
      velocity[0] * 0.5 + instantVelocity[0] * 0.5,
      velocity[1] * 0.5 + instantVelocity[1] * 0.5,
    ];

    applyDisplacement(delta[0], delta[1]);

    lastPoint = currentPoint;
    lastTime = now;
  });

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    lastPoint = null;
    svg.style.cursor = "";

    const speed = Math.sqrt(velocity[0] ** 2 + velocity[1] ** 2);
    if (speed > MIN_VELOCITY && !focusState.animating) {
      momentumFrame = requestAnimationFrame(momentumTick);
    }
  }

  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);

  svg.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();

    const factor = event.deltaY < 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
    const newW = Math.max(MIN_VB_SIZE, Math.min(MAX_VB_SIZE, vbW * factor));
    const newH = Math.max(MIN_VB_SIZE, Math.min(MAX_VB_SIZE, vbH * factor));

    const rect = svg.getBoundingClientRect();
    const mx = vbX + ((event.clientX - rect.left) / rect.width) * vbW;
    const my = vbY + ((event.clientY - rect.top) / rect.height) * vbH;

    vbX = mx - ((mx - vbX) / vbW) * newW;
    vbY = my - ((my - vbY) / vbH) * newH;
    vbW = newW;
    vbH = newH;

    setViewBox();
  }, { passive: false });
}
