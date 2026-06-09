import type { Connection } from "home-assistant-js-websocket";
import type { HaState } from "./types";
import { debugLog } from "../debug";

export interface StateConsumer {
  updateStates(states: Map<string, HaState>): void;
  onEntityChanged(entityId: string, oldValue?: string): void;
}

interface StateChangedEvent {
  data: {
    entity_id: string;
    old_state: HaState | null;
    new_state: HaState | null;
  };
}

export function subscribeToStates(
  connection: Connection,
  states: Map<string, HaState>,
  viz: StateConsumer
): () => void {
  const unsubscribePromise = connection.subscribeMessage<StateChangedEvent>(
    (event) => {
      const newState = event.data?.new_state;
      if (newState) {
        const oldValue = event.data.old_state?.state ?? "n/a";
        debugLog("state", newState.entity_id, `${oldValue} -> ${newState.state}`);
        states.set(newState.entity_id, newState);
        viz.updateStates(states);
        viz.onEntityChanged(newState.entity_id, oldValue);
      }
    },
    { type: "subscribe_events", event_type: "state_changed" }
  );
  // Swallow subscribe failures (connection lost mid-subscribe) so they do not
  // surface as unhandled rejections; reconnect logic re-establishes the sub.
  unsubscribePromise.catch(() => {});

  fetchAllStates(connection, states, viz);

  return () => {
    unsubscribePromise.then((unsubscribe) => unsubscribe()).catch(() => {});
  };
}

export async function fetchAllStates(
  connection: Connection,
  states: Map<string, HaState>,
  viz: StateConsumer
): Promise<void> {
  try {
    const stateList = await connection.sendMessagePromise<HaState[]>({ type: "get_states" });
    for (const state of stateList) {
      states.set(state.entity_id, state);
    }
    viz.updateStates(states);
    debugLog("system", `Received ${stateList.length} states`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog("system", "Failed to fetch states: " + message);
  }
}

export function watchConnection(
  connection: Connection,
  handlers: {
    onDisconnected(): void;
    onReady(): void;
    onAuthFailed?(): void;
  }
): () => void {
  const onDisconnected = () => {
    debugLog("system", "Connection lost, reconnecting...");
    handlers.onDisconnected();
  };
  // Fires on every successful reconnect; listeners are attached after the
  // initial connect, so the initial connection does not trigger it.
  const onReady = () => {
    debugLog("system", "Connection restored");
    handlers.onReady();
  };
  // The library only emits reconnect-error for fatal auth failures;
  // other errors keep retrying with backoff.
  const onReconnectError = () => {
    debugLog("auth", "Reconnection failed: invalid authentication");
    handlers.onAuthFailed?.();
  };

  connection.addEventListener("disconnected", onDisconnected);
  connection.addEventListener("ready", onReady);
  if (handlers.onAuthFailed) {
    connection.addEventListener("reconnect-error", onReconnectError);
  }

  return () => {
    connection.removeEventListener("disconnected", onDisconnected);
    connection.removeEventListener("ready", onReady);
    if (handlers.onAuthFailed) {
      connection.removeEventListener("reconnect-error", onReconnectError);
    }
  };
}
