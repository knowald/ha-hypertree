import { renderLoginForm, loadCredentials, showLoginError, type LoginCredentials } from "./login";
import { connect } from "./ha/connection";
import { fetchRegistries } from "./ha/registry";
import { buildTree, flattenTree } from "./tree/build";
import type { HaState } from "./ha/types";
import type { Connection } from "home-assistant-js-websocket";
import { initDebugConsole, debugLog } from "./debug";
import { subscribeToStates, fetchAllStates, watchConnection } from "./ha/states";
import { showStatusBar, removeStatusBar, setStatusDisconnected } from "./statusBar";
import { createForceViz } from "./viz/force";

const loginContainer = document.getElementById("login")!;
const treeContainer = document.getElementById("tree")!;

let activeConnection: Connection | null = null;
let teardownSession: (() => void) | null = null;
let connectInFlight = false;

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
  if (connectInFlight) return;
  connectInFlight = true;

  if (!autoConnect) {
    const button = loginContainer.querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Connecting...";
  }

  try {
    const connection = await connect(creds.url, creds.token);
    activeConnection?.close();
    activeConnection = connection;
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
  } finally {
    connectInFlight = false;
  }
}

async function initTree(connection: Connection) {
  const registries = await fetchRegistries(connection);
  const root = buildTree(registries);

  const nodes = flattenTree(root);

  treeContainer.innerHTML = "";

  const states = new Map<string, HaState>();

  const forceViz = createForceViz(registries, undefined, connection, (creds) => {
    teardownSession?.();
    teardownSession = null;
    activeConnection?.close();
    activeConnection = null;
    treeContainer.innerHTML = `<div class="loading"><div class="spinner"></div><span>Connecting...</span></div>`;
    // autoConnect mode recovers to the login form on failure; the regular
    // path would try to update a login button that is not on screen here.
    handleLogin(creds, true);
  });

  const vizContainer = document.createElement("div");
  vizContainer.id = "viz-container";
  treeContainer.appendChild(vizContainer);
  forceViz.create(vizContainer, root, states);

  const unsubscribeStates = subscribeToStates(connection, states, forceViz);
  const unwatchConnection = watchConnection(connection, {
    onDisconnected: () => setStatusDisconnected(true),
    onReady: () => {
      setStatusDisconnected(false);
      fetchAllStates(connection, states, forceViz);
    },
    onAuthFailed: () => {
      connection.close();
      if (activeConnection === connection) activeConnection = null;
      teardownSession?.();
      teardownSession = null;
      treeContainer.hidden = true;
      treeContainer.innerHTML = "";
      loginContainer.hidden = false;
      renderLoginForm(loginContainer, handleLogin);
      showLoginError(loginContainer, "Authentication failed, please log in again");
    },
  });

  teardownSession = () => {
    unsubscribeStates();
    unwatchConnection();
    forceViz.destroy();
    removeStatusBar();
  };

  debugLog("system", `Loaded ${nodes.length} nodes across ${registries.areas.length} areas`);
  showStatusBar(`${nodes.length} nodes | ${registries.areas.length} areas`);
}
