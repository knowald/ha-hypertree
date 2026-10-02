import type { Connection } from "home-assistant-js-websocket";
import { fetchRegistries } from "./ha/registry";
import { buildTree } from "./tree/build";
import type { TreeNode } from "./tree/types";
import type { HaState } from "./ha/types";
import { debugLog } from "./debug";
import { subscribeToStates, fetchAllStates, watchConnection } from "./ha/states";
import { showStatusBar, removeStatusBar, setStatusDisconnected } from "./statusBar";
import { createForceViz } from "./viz/force";
import { t } from "./i18n";

export interface SessionOptions {
  connection: Connection;
  container: HTMLElement;
  states: Map<string, HaState>;
  haUrl?: string;
  onReconnect?: (creds: { url: string; token: string }) => void;
  onAuthFailed?: () => void;
  // Called after the registry fetch; returning false aborts before any DOM or subscription work.
  isCurrent?: () => boolean;
}

export function showLoading(container: HTMLElement, text: string): void {
  container.innerHTML = `<div class="loading"><div class="spinner"></div><span></span></div>`;
  container.querySelector("span")!.textContent = text;
}

function countNodes(node: TreeNode): number {
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
}

export async function startSession(options: SessionOptions): Promise<(() => void) | null> {
  const { connection, container, states } = options;
  const registries = await fetchRegistries(connection);
  if (options.isCurrent && !options.isCurrent()) return null;
  const nodeCount = countNodes(buildTree(registries));

  container.innerHTML = "";
  const forceViz = createForceViz(registries, options.haUrl, connection, options.onReconnect);
  const vizContainer = document.createElement("div");
  vizContainer.id = "viz-container";
  container.appendChild(vizContainer);
  forceViz.create(vizContainer, states);

  const unsubscribeStates = subscribeToStates(connection, states, forceViz);
  const unwatchConnection = watchConnection(connection, {
    onDisconnected: () => setStatusDisconnected(true),
    onReady: () => {
      setStatusDisconnected(false);
      fetchAllStates(connection, states, forceViz);
    },
    onAuthFailed: options.onAuthFailed,
  });

  debugLog(t("system"), t("Loaded {n} nodes across {a} areas", { n: nodeCount, a: registries.areas.length }));
  showStatusBar(t("{n} nodes | {a} areas", { n: nodeCount, a: registries.areas.length }));

  return () => {
    unsubscribeStates();
    unwatchConnection();
    forceViz.destroy();
    removeStatusBar();
  };
}
