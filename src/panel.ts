import type { Connection } from "home-assistant-js-websocket";
import { setRootElement } from "./rootElement";
import { fetchRegistries } from "./ha/registry";
import { buildTree, flattenTree } from "./tree/build";
import { initDebugConsole, debugLog } from "./debug";
import { subscribeToStates, fetchAllStates, watchConnection } from "./ha/states";
import { showStatusBar, setStatusDisconnected } from "./statusBar";
import { createForceViz } from "./viz/force";
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

class HypertreePanel extends HTMLElement {
  private initialized = false;
  private initGeneration = 0;
  private teardown: (() => void) | null = null;
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

  disconnectedCallback() {
    // Invalidates any initPanel still awaiting the registry fetch.
    this.initGeneration++;
    this.teardown?.();
    this.teardown = null;
    this.initialized = false;
  }

  private async initPanel(hass: Hass) {
    const generation = ++this.initGeneration;
    initDebugConsole();

    const haUrl = hass.auth.data.hassUrl.replace(/\/+$/, "");
    debugLog("auth", "Panel connected to " + haUrl);

    try {
      const registries = await fetchRegistries(hass.connection);
      if (generation !== this.initGeneration) return;
      const root = buildTree(registries);
      const nodes = flattenTree(root);

      const treeContainer = this.container.querySelector("#tree") as HTMLDivElement;
      treeContainer.innerHTML = "";

      const forceViz = createForceViz(registries, haUrl, hass.connection);

      const vizContainer = document.createElement("div");
      vizContainer.id = "viz-container";
      treeContainer.appendChild(vizContainer);
      forceViz.create(vizContainer, root, this.states);

      const unsubscribeStates = subscribeToStates(hass.connection, this.states, forceViz);
      const unwatchConnection = watchConnection(hass.connection, {
        onDisconnected: () => setStatusDisconnected(true),
        onReady: () => {
          setStatusDisconnected(false);
          fetchAllStates(hass.connection, this.states, forceViz);
        },
      });

      // The connection outlives this panel (it belongs to the HA frontend),
      // so detach everything when the panel is removed from the DOM.
      this.teardown = () => {
        unsubscribeStates();
        unwatchConnection();
        forceViz.destroy();
      };

      debugLog("system", `Loaded ${nodes.length} nodes across ${registries.areas.length} areas`);
      showStatusBar(`${nodes.length} nodes | ${registries.areas.length} areas`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load";
      debugLog("system", "Init failed: " + message);
      const treeContainer = this.container.querySelector("#tree") as HTMLDivElement;
      treeContainer.innerHTML = `<div class="loading"><span>${message}</span></div>`;
    }
  }
}

customElements.define("ha-panel-hypertree", HypertreePanel);
