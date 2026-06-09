import { describe, it, expect, vi } from "vitest";
import type { Connection } from "home-assistant-js-websocket";
import { fetchAutomationEdges, type AutomationEdge } from "./automation";

vi.mock("../debug", () => ({ debugLog: () => {} }));

function fakeConnection(configs: Record<string, unknown>): Connection {
  return {
    sendMessagePromise: async (msg: { entity_id: string }) => {
      const config = configs[msg.entity_id];
      if (config === undefined) throw new Error("not found");
      return config;
    },
  } as unknown as Connection;
}

function edgeSet(edges: AutomationEdge[]): string[] {
  return edges.map((e) => `${e.automationEntityId} -${e.relation}-> ${e.targetEntityId}`).sort();
}

const KNOWN = new Set([
  "automation.morning",
  "automation.night",
  "binary_sensor.motion",
  "light.hall",
  "light.bedroom",
  "sensor.lux",
]);

describe("fetchAutomationEdges", () => {
  it("extracts trigger, condition, and action entities with their relation", async () => {
    const connection = fakeConnection({
      "automation.morning": {
        config: {
          trigger: [{ platform: "state", entity_id: "binary_sensor.motion" }],
          condition: [{ condition: "numeric_state", entity_id: "sensor.lux" }],
          action: [{ service: "light.turn_on", target: { entity_id: "light.hall" } }],
        },
      },
    });
    const edges = await fetchAutomationEdges(connection, ["automation.morning"], KNOWN);
    expect(edgeSet(edges)).toEqual([
      "automation.morning -action-> light.hall",
      "automation.morning -condition-> sensor.lux",
      "automation.morning -trigger-> binary_sensor.motion",
    ]);
  });

  it("supports plural section keys and a response without the config wrapper", async () => {
    const connection = fakeConnection({
      "automation.morning": {
        triggers: [{ platform: "state", entity_id: "binary_sensor.motion" }],
        actions: [{ service: "light.turn_on", entity_id: "light.hall" }],
      },
    });
    const edges = await fetchAutomationEdges(connection, ["automation.morning"], KNOWN);
    expect(edgeSet(edges)).toEqual([
      "automation.morning -action-> light.hall",
      "automation.morning -trigger-> binary_sensor.motion",
    ]);
  });

  it("finds entity ids in arrays and deeply nested structures", async () => {
    const connection = fakeConnection({
      "automation.morning": {
        config: {
          trigger: [{ platform: "state", entity_id: ["binary_sensor.motion", "sensor.lux"] }],
          action: [
            {
              choose: [
                {
                  conditions: [],
                  sequence: [{ service: "light.turn_on", target: { entity_id: "light.bedroom" } }],
                },
              ],
            },
          ],
        },
      },
    });
    const edges = await fetchAutomationEdges(connection, ["automation.morning"], KNOWN);
    expect(edgeSet(edges)).toEqual([
      "automation.morning -action-> light.bedroom",
      "automation.morning -trigger-> binary_sensor.motion",
      "automation.morning -trigger-> sensor.lux",
    ]);
  });

  it("skips unknown entities and self references", async () => {
    const connection = fakeConnection({
      "automation.morning": {
        config: {
          trigger: [{ entity_id: "binary_sensor.motion" }],
          action: [
            { entity_id: "automation.morning" },
            { entity_id: "light.unknown_to_registry" },
          ],
        },
      },
    });
    const edges = await fetchAutomationEdges(connection, ["automation.morning"], KNOWN);
    expect(edgeSet(edges)).toEqual(["automation.morning -trigger-> binary_sensor.motion"]);
  });

  it("emits one edge per relation even when an entity repeats within a section", async () => {
    const connection = fakeConnection({
      "automation.morning": {
        config: {
          trigger: [{ entity_id: "light.hall" }, { entity_id: "light.hall" }],
          action: [{ entity_id: "light.hall" }],
        },
      },
    });
    const edges = await fetchAutomationEdges(connection, ["automation.morning"], KNOWN);
    expect(edgeSet(edges)).toEqual([
      "automation.morning -action-> light.hall",
      "automation.morning -trigger-> light.hall",
    ]);
  });

  it("tolerates individual config fetch failures", async () => {
    const connection = fakeConnection({
      "automation.night": {
        config: { trigger: [{ entity_id: "binary_sensor.motion" }] },
      },
    });
    const edges = await fetchAutomationEdges(connection, ["automation.morning", "automation.night"], KNOWN);
    expect(edgeSet(edges)).toEqual(["automation.night -trigger-> binary_sensor.motion"]);
  });

  it("processes more automations than one batch", async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `automation.auto_${i}`);
    const known = new Set([...ids, "light.hall"]);
    const configs: Record<string, unknown> = {};
    for (const id of ids) {
      configs[id] = { config: { action: [{ entity_id: "light.hall" }] } };
    }
    const edges = await fetchAutomationEdges(fakeConnection(configs), ids, known);
    expect(edges).toHaveLength(23);
    expect(new Set(edges.map((e) => e.automationEntityId)).size).toBe(23);
  });
});
