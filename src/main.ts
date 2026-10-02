import { renderLoginForm, loadCredentials, showLoginError, type LoginCredentials } from "./login";
import { connect, normalizeUrl } from "./ha/connection";
import type { HaState } from "./ha/types";
import type { Connection } from "home-assistant-js-websocket";
import { initDebugConsole, debugLog } from "./debug";
import { startSession, showLoading } from "./session";
import { t } from "./i18n";

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
  showLoading(treeContainer, t("Connecting..."));
  debugLog(t("auth"), t("Auto-connecting with saved credentials"));
  handleLogin(savedCreds, true);
} else {
  renderLoginForm(loginContainer, handleLogin);
}

async function handleLogin(creds: LoginCredentials, autoConnect = false) {
  if (connectInFlight) return;
  connectInFlight = true;

  if (!autoConnect) {
    const button = loginContainer.querySelector("button");
    if (button) {
      button.disabled = true;
      button.textContent = t("Connecting...");
    }
  }

  try {
    const connection = await connect(creds.url, creds.token);
    activeConnection?.close();
    activeConnection = connection;
    loginContainer.hidden = true;

    treeContainer.hidden = false;
    showLoading(treeContainer, t("Loading registries..."));

    debugLog(t("auth"), t("Connected to {url}", { url: normalizeUrl(creds.url) }));
    await initTree(connection);
  } catch (err) {
    const message = err instanceof Error ? err.message : t("Connection failed");
    debugLog(t("auth"), t("Connection failed: {msg}", { msg: message }));

    if (autoConnect) {
      treeContainer.hidden = true;
      treeContainer.innerHTML = "";
      loginContainer.hidden = false;
      renderLoginForm(loginContainer, handleLogin);
      showLoginError(loginContainer, message);
    } else {
      const button = loginContainer.querySelector("button");
      if (button) {
        button.disabled = false;
        button.textContent = t("Connect");
      }
      showLoginError(loginContainer, message);
    }
  } finally {
    connectInFlight = false;
  }
}

async function initTree(connection: Connection) {
  const teardown = await startSession({
    connection,
    container: treeContainer,
    states: new Map<string, HaState>(),
    onReconnect: (creds) => {
      teardownSession?.();
      teardownSession = null;
      activeConnection?.close();
      activeConnection = null;
      showLoading(treeContainer, t("Connecting..."));
      // autoConnect mode recovers to the login form on failure; the regular
      // path would try to update a login button that is not on screen here.
      handleLogin(creds, true);
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
      showLoginError(loginContainer, t("Authentication failed, please log in again"));
    },
  });
  teardownSession = teardown;
}
