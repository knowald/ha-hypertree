import type { Connection } from "home-assistant-js-websocket";
import { debugLog } from "../debug";

export type AutomationRelation = "trigger" | "condition" | "action";

export interface AutomationEdge {
  automationEntityId: string;
  targetEntityId: string;
  relation: AutomationRelation;
}

interface AutomationConfig {
  trigger?: unknown[];
  triggers?: unknown[];
  condition?: unknown[];
  conditions?: unknown[];
  action?: unknown[];
  actions?: unknown[];
}

interface AutomationConfigResponse {
  config: AutomationConfig;
}

function extractEntityIds(obj: unknown, found: Set<string>): void {
  if (obj == null || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) extractEntityIds(item, found);
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "entity_id") {
      if (typeof value === "string") {
        found.add(value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string") found.add(v);
        }
      }
    } else {
      extractEntityIds(value, found);
    }
  }
}

const BATCH_SIZE = 10;

export async function fetchAutomationEdges(
  connection: Connection,
  automationEntityIds: string[],
  knownEntityIds: Set<string>,
): Promise<AutomationEdge[]> {
  const edges: AutomationEdge[] = [];

  for (let i = 0; i < automationEntityIds.length; i += BATCH_SIZE) {
    const batch = automationEntityIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((entityId) =>
        connection.sendMessagePromise<AutomationConfigResponse>({
          type: "automation/config",
          entity_id: entityId,
        })
      )
    );

    let fulfilled = 0;
    let rejected = 0;
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status !== "fulfilled") {
        rejected++;
        if (rejected === 1) debugLog("system", `Automation: first rejection for ${batch[j]}`, result.reason);
        continue;
      }
      fulfilled++;

      const raw = result.value;
      // The response may be { config: {...} } or the config directly
      const config: AutomationConfig = (raw as AutomationConfigResponse).config ?? (raw as AutomationConfig);
      const entityId = batch[j];

      if (fulfilled === 1) debugLog("system", `Automation: sample config keys`, Object.keys(config).join(", "));

      const sections: { items: unknown[] | undefined; relation: AutomationRelation }[] = [
        { items: config.trigger ?? config.triggers, relation: "trigger" },
        { items: config.condition ?? config.conditions, relation: "condition" },
        { items: config.action ?? config.actions, relation: "action" },
      ];

      for (const { items, relation } of sections) {
        if (!items) continue;
        const found = new Set<string>();
        extractEntityIds(items, found);
        for (const targetId of found) {
          if (targetId !== entityId && knownEntityIds.has(targetId)) {
            edges.push({ automationEntityId: entityId, targetEntityId: targetId, relation });
          }
        }
      }
    }
    debugLog("system", `Automation: batch ${i / BATCH_SIZE + 1}: ${fulfilled} ok, ${rejected} failed`);
  }

  return edges;
}
