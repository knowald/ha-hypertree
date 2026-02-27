import type { Visualization } from "./types";
import { flattenTree, collectEdges } from "../tree/build";
import { layoutTree } from "../tree/layout";
import { createRenderer, render, type RenderState } from "../render/renderer";
import { applyFocus } from "../hyperbolic/poincare";
import { createFocusState, resetFocus, setupClickFocus } from "../interaction/focus";
import { setupPan } from "../interaction/pan";
import { animateBloom } from "../render/bloom";
import { initRipples } from "../render/ripple";

let renderState: RenderState | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

export const hyperbolicViz: Visualization = {
  name: "Hyperbolic",

  create(container, root, states) {
    layoutTree(root);
    const nodes = flattenTree(root);
    const edges = collectEdges(root);

    renderState = createRenderer(container, nodes, edges);
    renderState.states = states;
    initRipples(renderState);

    applyFocus(nodes, [0, 0]);
    animateBloom(renderState).then(() => {
      if (!renderState) return;
      const focusState = createFocusState();
      setupClickFocus(renderState, focusState);
      setupPan(renderState, focusState);

      keyHandler = (e: KeyboardEvent) => {
        if (e.key === "Escape" && renderState) resetFocus(focusState, renderState);
      };
      document.addEventListener("keydown", keyHandler);
    });
  },

  destroy() {
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    renderState = null;
  },

  updateStates(states) {
    if (renderState) {
      renderState.states = states;
      render(renderState);
    }
  },
};
