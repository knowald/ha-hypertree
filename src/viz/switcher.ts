import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";
import type { Visualization } from "./types";
import { getRootElement } from "../rootElement";

export function createSwitcher(
  container: HTMLElement,
  visualizations: Visualization[],
  root: TreeNode,
  states: Map<string, HaState>,
  defaultViz?: string
): { updateStates(s: Map<string, HaState>): void; onEntityChanged(id: string): void } {
  const bar = document.createElement("div");
  bar.id = "viz-bar";
  getRootElement().appendChild(bar);

  const vizContainer = document.createElement("div");
  vizContainer.id = "viz-container";
  container.appendChild(vizContainer);

  let activeViz: Visualization | null = null;
  let activeBtn: HTMLButtonElement | null = null;

  for (const viz of visualizations) {
    const btn = document.createElement("button");
    btn.textContent = viz.name;
    btn.addEventListener("click", () => activate(viz, btn));
    bar.appendChild(btn);
  }

  function activate(viz: Visualization, btn: HTMLButtonElement): void {
    if (activeViz === viz) return;

    if (activeViz) {
      activeViz.destroy();
    }
    if (activeBtn) {
      activeBtn.classList.remove("active");
    }

    vizContainer.innerHTML = "";
    activeViz = viz;
    activeBtn = btn;
    btn.classList.add("active");
    viz.create(vizContainer, root, states);
  }

  if (visualizations.length > 0) {
    const buttons = Array.from(bar.querySelectorAll("button")) as HTMLButtonElement[];
    let defaultIndex = 0;
    if (defaultViz) {
      const idx = visualizations.findIndex((v) => v.name === defaultViz);
      if (idx >= 0) defaultIndex = idx;
    }
    activate(visualizations[defaultIndex], buttons[defaultIndex]);
  }

  return {
    updateStates(s: Map<string, HaState>): void {
      if (activeViz) {
        activeViz.updateStates(s);
      }
    },
    onEntityChanged(id: string): void {
      if (activeViz?.onEntityChanged) {
        activeViz.onEntityChanged(id);
      }
    },
  };
}
