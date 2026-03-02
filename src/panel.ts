import type { Connection } from "home-assistant-js-websocket";
import { setRootElement, getRootElement } from "./rootElement";
import { fetchRegistries } from "./ha/registry";
import { buildTree, flattenTree } from "./tree/build";
import { initDebugConsole, debugLog } from "./debug";
import { createSwitcher } from "./viz/switcher";
import { createForceViz } from "./viz/force";
import { hyperbolicViz } from "./viz/hyperbolic";
import { treemapViz } from "./viz/treemap";
import { sunburstViz } from "./viz/sunburst";
import { dendrogramViz } from "./viz/dendrogram";
import { globeViz } from "./viz/globe";
import { matrixViz } from "./viz/matrix";
import type { HaState } from "./ha/types";
import styles from "./style.css?inline";

interface HassAuth {
  data: { hassUrl: string };
}

interface Hass {
  connection: Connection;
  states: Record<string, HaState>;
  auth: HassAuth;
}

interface StateChangedEvent {
  data: {
    entity_id: string;
    old_state: HaState | null;
    new_state: HaState | null;
  };
}

class HypertreePanel extends HTMLElement {
  private initialized = false;
  private switcher: { updateStates(s: Map<string, HaState>): void; onEntityChanged(id: string): void } | null = null;
  private states = new Map<string, HaState>();
  private container!: HTMLDivElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = styles;
    shadow.appendChild(style);

    this.container = document.createElement("div");
    this.container.id = "app";
    this.container.innerHTML = `<div id="tree"><div class="loading"><div class="spinner"></div><span>Loading...</span></div></div>`;
    shadow.appendChild(this.container);

    setRootElement(this.container);
  }

  set hass(hass: Hass) {
    if (!this.initialized) {
      this.initialized = true;
      this.initPanel(hass);
    }
  }

  private async initPanel(hass: Hass) {
    initDebugConsole();

    const haUrl = hass.auth.data.hassUrl.replace(/\/+$/, "");
    debugLog("auth", "Panel connected to " + haUrl);

    try {
      const registries = await fetchRegistries(hass.connection);
      const root = buildTree(registries);
      const nodes = flattenTree(root);

      const treeContainer = this.container.querySelector("#tree") as HTMLDivElement;
      treeContainer.innerHTML = "";

      const visualizations = [
        createForceViz(registries, haUrl),
        dendrogramViz,
        globeViz,
        hyperbolicViz,
        matrixViz,
        sunburstViz,
        treemapViz,
      ];

      this.switcher = createSwitcher(treeContainer, visualizations, root, this.states, "Force");

      const vizBar = getRootElement().querySelector("#viz-bar");
      if (vizBar) {
        const spacer = document.createElement("div");
        spacer.className = "viz-bar-spacer";
        vizBar.appendChild(spacer);
      }

      this.subscribeToStates(hass.connection);

      debugLog("system", `Loaded ${nodes.length} nodes across ${registries.areas.length} areas`);

      const statusEl = document.createElement("div");
      statusEl.id = "status";
      statusEl.textContent = `${nodes.length} nodes | ${registries.areas.length} areas`;
      getRootElement().appendChild(statusEl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load";
      debugLog("system", "Init failed: " + message);
      const treeContainer = this.container.querySelector("#tree") as HTMLDivElement;
      treeContainer.innerHTML = `<div class="loading"><span>${message}</span></div>`;
    }
  }

  private subscribeToStates(connection: Connection) {
    connection.subscribeMessage<StateChangedEvent>(
      (event) => {
        const newState = event.data?.new_state;
        if (newState) {
          const oldState = event.data.old_state;
          const oldVal = oldState?.state ?? "n/a";
          const newVal = newState.state;
          debugLog("state", newState.entity_id, `${oldVal} -> ${newVal}`);

          this.states.set(newState.entity_id, newState);
          this.switcher?.updateStates(this.states);
          this.switcher?.onEntityChanged(newState.entity_id);
        }
      },
      { type: "subscribe_events", event_type: "state_changed" }
    );

    connection
      .sendMessagePromise<HaState[]>({ type: "get_states" })
      .then((stateList) => {
        for (const state of stateList) {
          this.states.set(state.entity_id, state);
        }
        this.switcher?.updateStates(this.states);
        debugLog("system", `Received ${stateList.length} initial states`);
      });
  }
}

customElements.define("ha-panel-hypertree", HypertreePanel);
