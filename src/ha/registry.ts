import type { Connection } from "home-assistant-js-websocket";
import type { HaArea, HaDevice, HaEntityRegistryEntry, Registries } from "./types";

export async function fetchRegistries(connection: Connection): Promise<Registries> {
  const [areas, devices, entities] = await Promise.all([
    connection.sendMessagePromise<HaArea[]>({ type: "config/area_registry/list" }),
    connection.sendMessagePromise<HaDevice[]>({ type: "config/device_registry/list" }),
    connection.sendMessagePromise<HaEntityRegistryEntry[]>({
      type: "config/entity_registry/list",
    }),
  ]);

  return { areas, devices, entities };
}
