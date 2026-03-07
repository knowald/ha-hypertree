import { renderLoginForm, loadCredentials, showLoginError, type LoginCredentials } from "./login";
import { connect } from "./ha/connection";
import { fetchRegistries } from "./ha/registry";
import { buildTree, flattenTree } from "./tree/build";
import type { HaState } from "./ha/types";
import type { Connection } from "home-assistant-js-websocket";
import { initDebugConsole, debugLog } from "./debug";

import { getRootElement } from "./rootElement";
import { createForceViz } from "./viz/force";

const loginContainer = document.getElementById("login")!;
const treeContainer = document.getElementById("tree")!;

initDebugConsole();

const savedCreds = loadCredentials();
if (savedCreds) {
  loginContainer.hidden = true;
  treeContainer.hidden = false;
  treeContainer.innerHTML = `<div class="loading"><div class="spinner"></div><span>Connecting...</span></div>`;
  debugLog("auth", "Auto-connecting with saved credentials");
  handleLogin(savedCreds, true);
} else {
  renderLoginForm(loginContainer, handleLogin);
}

async function handleLogin(creds: LoginCredentials, autoConnect = false) {
  if (!autoConnect) {
    const button = loginContainer.querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Connecting...";
  }

  try {
    const connection = await connect(creds.url, creds.token);
    loginContainer.hidden = true;

    treeContainer.hidden = false;
    treeContainer.innerHTML = `<div class="loading"><div class="spinner"></div><span>Loading registries...</span></div>`;

    debugLog("auth", "Connected to " + creds.url);
    await initTree(connection);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    debugLog("auth", "Connection failed: " + message);

    if (autoConnect) {
      treeContainer.hidden = true;
      treeContainer.innerHTML = "";
      loginContainer.hidden = false;
      renderLoginForm(loginContainer, handleLogin);
      showLoginError(loginContainer, message);
    } else {
      const button = loginContainer.querySelector("button") as HTMLButtonElement;
      button.disabled = false;
      button.textContent = "Connect";
      showLoginError(loginContainer, message);
    }
  }
}

async function initTree(connection: Connection) {
  const registries = await fetchRegistries(connection);
  const root = buildTree(registries);

  const nodes = flattenTree(root);

  treeContainer.innerHTML = "";

  const states = new Map<string, HaState>();

  const forceViz = createForceViz(registries, undefined, connection, (creds) => {
    treeContainer.innerHTML = "";
    handleLogin(creds);
  });

  const vizContainer = document.createElement("div");
  vizContainer.id = "viz-container";
  treeContainer.appendChild(vizContainer);
  forceViz.create(vizContainer, root, states);

  subscribeToStates(connection, states, forceViz);

  debugLog("system", `Loaded ${nodes.length} nodes across ${registries.areas.length} areas`);

  const statusEl = document.createElement("div");
  statusEl.id = "status";
  statusEl.textContent = `${nodes.length} nodes | ${registries.areas.length} areas`;
  getRootElement().appendChild(statusEl);
}

interface StateChangedEvent {
  data: {
    entity_id: string;
    old_state: HaState | null;
    new_state: HaState | null;
  };
}

function subscribeToStates(
  connection: Connection,
  states: Map<string, HaState>,
  forceViz: { updateStates(s: Map<string, HaState>): void; onEntityChanged(id: string, oldValue?: string): void }
) {
  connection.subscribeMessage<StateChangedEvent>(
    (event) => {
      const newState = event.data?.new_state;
      if (newState) {
        const oldState = event.data.old_state;
        const oldVal = oldState?.state ?? "n/a";
        const newVal = newState.state;
        debugLog("state", newState.entity_id, `${oldVal} -> ${newVal}`);

        states.set(newState.entity_id, newState);
        forceViz.updateStates(states);
        forceViz.onEntityChanged(newState.entity_id, oldVal);
      }
    },
    { type: "subscribe_events", event_type: "state_changed" }
  );

  connection
    .sendMessagePromise<HaState[]>({ type: "get_states" })
    .then((stateList) => {
      for (const state of stateList) {
        states.set(state.entity_id, state);
      }
      forceViz.updateStates(states);
      debugLog("system", `Received ${stateList.length} initial states`);
    });
}
