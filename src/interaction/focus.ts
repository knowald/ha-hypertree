import type { Complex } from "../hyperbolic/complex";
import type { RenderState } from "../render/renderer";
import { ORIGIN, abs } from "../hyperbolic/complex";
import { geodesicInterpolate, applyFocus } from "../hyperbolic/poincare";
import { render } from "../render/renderer";

const ANIMATION_DURATION = 600; // ms

export interface FocusState {
  currentFocus: Complex;
  animating: boolean;
}

export function createFocusState(): FocusState {
  return {
    currentFocus: [...ORIGIN],
    animating: false,
  };
}

export function animateFocusTo(
  target: Complex,
  focusState: FocusState,
  renderState: RenderState
): void {
  if (focusState.animating) return;

  const start = focusState.currentFocus;
  const distance = abs([target[0] - start[0], target[1] - start[1]]);

  if (distance < 1e-4) return;

  focusState.animating = true;
  const startTime = performance.now();

  function frame(now: number) {
    const elapsed = now - startTime;
    const rawT = Math.min(elapsed / ANIMATION_DURATION, 1);

    const t =
      rawT < 0.5
        ? 4 * rawT * rawT * rawT
        : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

    const interpolated = geodesicInterpolate(start, target, t);
    focusState.currentFocus = interpolated;

    applyFocus(renderState.nodes, interpolated);
    render(renderState);

    if (rawT < 1) {
      requestAnimationFrame(frame);
    } else {
      focusState.currentFocus = target;
      applyFocus(renderState.nodes, target);
      render(renderState);
      focusState.animating = false;
    }
  }

  requestAnimationFrame(frame);
}

export function resetFocus(
  focusState: FocusState,
  renderState: RenderState
): void {
  animateFocusTo([...ORIGIN], focusState, renderState);
}

export function setupClickFocus(
  renderState: RenderState,
  focusState: FocusState
): void {
  renderState.nodeGroup.addEventListener("click", (event: MouseEvent) => {
    const target = event.target as SVGCircleElement;
    if (target.tagName !== "circle" || !target.dataset.idx) return;

    const node = renderState.nodes[Number(target.dataset.idx)];
    if (node) {
      animateFocusTo(node.z, focusState, renderState);
    }
  });
}
