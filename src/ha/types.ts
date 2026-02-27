export interface HaArea {
  area_id: string;
  name: string;
  aliases: string[];
  picture: string | null;
}

export interface HaDevice {
  id: string;
  area_id: string | null;
  name: string | null;
  name_by_user: string | null;
  disabled_by: string | null;
}

export interface HaEntityRegistryEntry {
  entity_id: string;
  name: string | null;
  original_name: string | null;
  platform: string;
  device_id: string | null;
  area_id: string | null;
  disabled_by: string | null;
  hidden_by: string | null;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface Registries {
  areas: HaArea[];
  devices: HaDevice[];
  entities: HaEntityRegistryEntry[];
}
