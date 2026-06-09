import { describe, it, expect } from "vitest";
import { buildTree, buildTreeByDevice, flattenTree } from "./build";
import type { Registries, HaEntityRegistryEntry } from "../ha/types";

function entity(overrides: Partial<HaEntityRegistryEntry> & { entity_id: string }): HaEntityRegistryEntry {
  return {
    name: null,
    original_name: null,
    platform: "test",
    device_id: null,
    area_id: null,
    disabled_by: null,
    hidden_by: null,
    ...overrides,
  };
}

const registries: Registries = {
  areas: [
    { area_id: "kitchen", name: "Kitchen", aliases: [], picture: null },
    { area_id: "bedroom", name: "Bedroom", aliases: [], picture: null },
  ],
  devices: [
    { id: "dev-1", area_id: "kitchen", name: "Hue Bridge", name_by_user: null, disabled_by: null },
    { id: "dev-2", area_id: "bedroom", name: "Sensor Hub", name_by_user: "Renamed Hub", disabled_by: null },
  ],
  entities: [
    entity({ entity_id: "light.kitchen_ceiling", device_id: "dev-1", name: "Ceiling Light" }),
    entity({ entity_id: "sensor.kitchen_temp", area_id: "kitchen", original_name: "Kitchen Temp" }),
    entity({ entity_id: "light.bedroom", area_id: "bedroom" }),
    entity({ entity_id: "sensor.bedroom_hum", device_id: "dev-2" }),
    entity({ entity_id: "switch.orphan" }),
    entity({ entity_id: "sensor.dead", area_id: "kitchen", disabled_by: "user" }),
  ],
};

describe("buildTree", () => {
  const root = buildTree(registries);

  it("sorts areas alphabetically with Unassigned last", () => {
    expect(root.children.map((a) => a.label)).toEqual(["Bedroom", "Kitchen", "Unassigned"]);
  });

  it("groups entities by domain under each area, domains sorted", () => {
    const kitchen = root.children[1];
    expect(kitchen.children.map((d) => d.label)).toEqual(["light", "sensor"]);
    expect(kitchen.children[0].kind).toBe("domain");
  });

  it("assigns the device's area to entities without their own area_id", () => {
    const kitchen = root.children[1];
    const lightDomain = kitchen.children[0];
    expect(lightDomain.children.map((e) => e.entityId)).toEqual(["light.kitchen_ceiling"]);
  });

  it("puts entities without area or device under Unassigned", () => {
    const unassigned = root.children[2];
    expect(flattenTree(unassigned).filter((n) => n.kind === "entity").map((n) => n.entityId)).toEqual([
      "switch.orphan",
    ]);
  });

  it("excludes disabled entities", () => {
    const ids = flattenTree(root)
      .filter((n) => n.kind === "entity")
      .map((n) => n.entityId);
    expect(ids).not.toContain("sensor.dead");
    expect(ids).toHaveLength(5);
  });

  it("prefers name, then original_name, then entity_id as label", () => {
    const labels = flattenTree(root)
      .filter((n) => n.kind === "entity")
      .map((n) => n.label);
    expect(labels).toContain("Ceiling Light");
    expect(labels).toContain("Kitchen Temp");
    expect(labels).toContain("light.bedroom");
  });

  it("computes leafCount as the number of entity descendants", () => {
    expect(root.leafCount).toBe(5);
    const kitchen = root.children[1];
    expect(kitchen.leafCount).toBe(2);
    for (const domain of kitchen.children) {
      expect(domain.leafCount).toBe(domain.children.length);
    }
  });
});

describe("buildTreeByDevice", () => {
  const root = buildTreeByDevice(registries);

  it("groups entities by device with No device last", () => {
    const bedroom = root.children[0];
    expect(bedroom.children.map((d) => d.label)).toEqual(["Renamed Hub", "No device"]);
    expect(bedroom.children[0].kind).toBe("device");
  });

  it("prefers name_by_user over the device name", () => {
    const bedroom = root.children[0];
    expect(bedroom.children[0].label).toBe("Renamed Hub");
  });

  it("respects a direct entity area assignment over the device area", () => {
    const override: Registries = {
      ...registries,
      entities: [entity({ entity_id: "light.moved", device_id: "dev-1", area_id: "bedroom" })],
    };
    const tree = buildTreeByDevice(override);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].label).toBe("Bedroom");
  });

  it("excludes disabled entities", () => {
    const ids = flattenTree(root)
      .filter((n) => n.kind === "entity")
      .map((n) => n.entityId);
    expect(ids).not.toContain("sensor.dead");
  });
});

describe("flattenTree", () => {
  it("returns nodes in preorder depth-first order", () => {
    const root = buildTree(registries);
    const flat = flattenTree(root);
    expect(flat[0].id).toBe("root");
    expect(flat[1].kind).toBe("area");
    expect(flat[2].kind).toBe("domain");
    expect(flat[3].kind).toBe("entity");
    expect(flat).toHaveLength(1 + 3 + 5 + 5);
  });
});
