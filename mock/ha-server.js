import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

// --- CLI ---

const { values: args } = parseArgs({
  options: {
    entities: { type: "string", short: "e", default: "500" },
    port: { type: "string", short: "p", default: "8123" },
    interval: { type: "string", short: "i", default: "2000" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`Usage: node mock/ha-server.js [options]

Mock Home Assistant WebSocket server for ha-hypertree testing.

Options:
  -e, --entities <n>    Number of entities to generate (default: 500)
  -p, --port <n>        WebSocket server port (default: 8123)
  -i, --interval <ms>   State change interval in ms, 0 to disable (default: 2000)
  -h, --help            Show this help`);
  process.exit(0);
}

const entityCount = parseInt(args.entities, 10);
const port = parseInt(args.port, 10);
const stateInterval = parseInt(args.interval, 10);

// --- Data generation ---

const AREAS = [
  "Living Room",
  "Kitchen",
  "Master Bedroom",
  "Guest Bedroom",
  "Kids Room",
  "Bathroom",
  "Ensuite",
  "Garage",
  "Office",
  "Garden",
  "Hallway",
  "Laundry",
  "Attic",
  "Basement",
  "Patio",
  "Dining Room",
];

// Each domain definition: entity naming, typical state values, common attributes
const DOMAIN_DEFS = {
  light: {
    names: (area) => [
      `${area} Ceiling`,
      `${area} Lamp`,
      `${area} LED Strip`,
      `${area} Spot`,
    ],
    states: ["on", "off"],
    attributes: () => ({
      brightness: Math.floor(Math.random() * 255),
      color_temp: 300 + Math.floor(Math.random() * 200),
      supported_features: 44,
    }),
  },
  switch: {
    names: (area) => [`${area} Outlet`, `${area} Smart Plug`, `${area} Power`],
    states: ["on", "off"],
    attributes: () => ({}),
  },
  sensor: {
    names: (area) => [
      `${area} Temperature`,
      `${area} Humidity`,
      `${area} Illuminance`,
      `${area} Air Quality`,
      `${area} Power Usage`,
    ],
    states: null, // numeric
    attributes: (name) => {
      if (name.includes("Temperature"))
        return { unit_of_measurement: "\u00b0C", device_class: "temperature" };
      if (name.includes("Humidity"))
        return { unit_of_measurement: "%", device_class: "humidity" };
      if (name.includes("Illuminance"))
        return { unit_of_measurement: "lx", device_class: "illuminance" };
      if (name.includes("Air"))
        return { unit_of_measurement: "\u00b5g/m\u00b3", device_class: "pm25" };
      if (name.includes("Power"))
        return { unit_of_measurement: "W", device_class: "power" };
      return {};
    },
    stateValue: (name) => {
      if (name.includes("Temperature"))
        return (18 + Math.random() * 10).toFixed(1);
      if (name.includes("Humidity"))
        return (30 + Math.random() * 50).toFixed(0);
      if (name.includes("Illuminance"))
        return Math.floor(Math.random() * 1000).toString();
      if (name.includes("Air"))
        return (Math.random() * 50).toFixed(1);
      if (name.includes("Power"))
        return Math.floor(Math.random() * 3000).toString();
      return "0";
    },
  },
  binary_sensor: {
    names: (area) => [
      `${area} Motion`,
      `${area} Door`,
      `${area} Window`,
      `${area} Occupancy`,
    ],
    states: ["on", "off"],
    attributes: (name) => {
      if (name.includes("Motion")) return { device_class: "motion" };
      if (name.includes("Door")) return { device_class: "door" };
      if (name.includes("Window")) return { device_class: "window" };
      return { device_class: "occupancy" };
    },
  },
  climate: {
    names: (area) => [`${area} Thermostat`, `${area} AC`],
    states: ["heat", "cool", "auto", "off"],
    attributes: () => ({
      temperature: 20 + Math.floor(Math.random() * 5),
      current_temperature: (18 + Math.random() * 8).toFixed(1),
      hvac_modes: ["heat", "cool", "auto", "off"],
    }),
  },
  cover: {
    names: (area) => [`${area} Blinds`, `${area} Shutter`],
    states: ["open", "closed"],
    attributes: () => ({
      current_position: Math.floor(Math.random() * 100),
      supported_features: 15,
    }),
  },
  media_player: {
    names: (area) => [`${area} Speaker`, `${area} TV`],
    states: ["playing", "paused", "idle", "off"],
    attributes: () => ({
      volume_level: Math.random().toFixed(2),
      media_title: "Mock Track",
    }),
  },
  fan: {
    names: (area) => [`${area} Fan`],
    states: ["on", "off"],
    attributes: () => ({
      percentage: Math.floor(Math.random() * 4) * 33,
      supported_features: 1,
    }),
  },
  lock: {
    names: (area) => [`${area} Lock`],
    states: ["locked", "unlocked"],
    attributes: () => ({}),
  },
  vacuum: {
    names: (_area) => ["Robot Vacuum"],
    states: ["cleaning", "docked", "idle", "returning"],
    attributes: () => ({
      battery_level: Math.floor(Math.random() * 100),
      supported_features: 14204,
    }),
  },
  automation: {
    names: (area) => [
      `${area} Lights Auto`,
      `${area} Night Mode`,
    ],
    states: ["on", "off"],
    attributes: () => ({ last_triggered: new Date().toISOString() }),
  },
  camera: {
    names: (area) => [`${area} Camera`],
    states: ["idle", "recording"],
    attributes: () => ({ supported_features: 2 }),
  },
};

const PLATFORMS = [
  "mqtt",
  "hue",
  "zwave_js",
  "esphome",
  "tasmota",
  "shelly",
  "tuya",
  "zigbee2mqtt",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateData(count) {
  // Determine how many areas to use based on entity count
  const areaCount = Math.min(AREAS.length, Math.max(3, Math.ceil(count / 30)));
  const areas = AREAS.slice(0, areaCount).map((name) => ({
    area_id: name.toLowerCase().replace(/ /g, "_"),
    name,
    aliases: [],
    picture: null,
  }));

  const devices = [];
  const entities = [];
  const states = [];
  const domains = Object.keys(DOMAIN_DEFS);
  let generated = 0;
  let deviceIndex = 0;
  const entityIdSet = new Set();

  // Distribute entities across areas, cycling through domains.
  // Append a numeric suffix to avoid duplicates when count exceeds unique names.
  let round = 0;
  while (generated < count) {
    for (const area of areas) {
      if (generated >= count) break;

      for (const domain of domains) {
        if (generated >= count) break;

        const def = DOMAIN_DEFS[domain];
        const possibleNames = def.names(area.name);
        const nameIdx = round % possibleNames.length;
        const baseName = possibleNames[nameIdx];
        const friendlyName = round < possibleNames.length ? baseName : `${baseName} ${round}`;
        const slug = friendlyName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        const entityId = `${domain}.${slug}`;

        if (entityIdSet.has(entityId)) continue;
        entityIdSet.add(entityId);

        const deviceId = `device_${deviceIndex++}`;
        const platform = PLATFORMS[generated % PLATFORMS.length];

        devices.push({
          id: deviceId,
          area_id: area.area_id,
          name: friendlyName,
          name_by_user: null,
          disabled_by: null,
        });

        // ~10% of entities get area set directly rather than inheriting from device
        const directArea = Math.random() < 0.1 ? area.area_id : null;

        entities.push({
          entity_id: entityId,
          name: friendlyName,
          original_name: friendlyName,
          platform,
          device_id: directArea ? null : deviceId,
          area_id: directArea,
          disabled_by: null,
          hidden_by: null,
        });

        const now = new Date().toISOString();
        let state;
        if (def.stateValue) {
          state = def.stateValue(friendlyName);
        } else {
          state = def.states[Math.floor(Math.random() * def.states.length)];
        }

        const attrs = def.attributes
          ? def.attributes(friendlyName)
          : {};

        states.push({
          entity_id: entityId,
          state,
          attributes: { friendly_name: friendlyName, ...attrs },
          last_changed: now,
          last_updated: now,
        });

        generated++;
      }
    }
    round++;
  }

  // Sprinkle in a few disabled entities (not counted toward target)
  const disabledCount = Math.max(1, Math.floor(count * 0.02));
  for (let i = 0; i < disabledCount; i++) {
    const area = areas[i % areas.length];
    entities.push({
      entity_id: `sensor.disabled_${i}`,
      name: `Disabled Sensor ${i}`,
      original_name: null,
      platform: "test",
      device_id: null,
      area_id: area.area_id,
      disabled_by: "user",
      hidden_by: null,
    });
  }

  // Build automation configs that reference other entities.
  // The force viz fetches these via "automation/config" messages.
  const nonAutomationIds = entities
    .filter((e) => !e.disabled_by && !e.entity_id.startsWith("automation."))
    .map((e) => e.entity_id);
  const automationIds = entities
    .filter((e) => e.entity_id.startsWith("automation."))
    .map((e) => e.entity_id);

  const automationConfigs = new Map();
  for (const automationId of automationIds) {
    const triggerCount = 1 + Math.floor(Math.random() * 3);
    const conditionCount = Math.random() < 0.5 ? 1 : 0;
    const actionCount = 1 + Math.floor(Math.random() * 2);

    const triggers = [];
    for (let t = 0; t < triggerCount && nonAutomationIds.length > 0; t++) {
      triggers.push({
        platform: "state",
        entity_id: pickRandom(nonAutomationIds),
        to: "on",
      });
    }

    const conditions = [];
    for (let c = 0; c < conditionCount && nonAutomationIds.length > 0; c++) {
      conditions.push({
        condition: "state",
        entity_id: pickRandom(nonAutomationIds),
        state: "on",
      });
    }

    const actions = [];
    for (let a = 0; a < actionCount && nonAutomationIds.length > 0; a++) {
      actions.push({
        service: "homeassistant.turn_on",
        entity_id: pickRandom(nonAutomationIds),
      });
    }

    automationConfigs.set(automationId, {
      trigger: triggers,
      condition: conditions,
      action: actions,
    });
  }

  return { areas, devices, entities, states, automationConfigs };
}

// --- WebSocket server ---

const data = generateData(entityCount);
const enabledCount = data.entities.filter((e) => !e.disabled_by).length;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Mock HA server",
    entities: enabledCount,
    areas: data.areas.length,
    automations: data.automationConfigs.size,
  }));
});

const wss = new WebSocketServer({ server, path: "/api/websocket" });

wss.on("error", () => {
  // Handled by server "error" listener below — prevent unhandled throw from ws.
});

let connectionCount = 0;

wss.on("connection", (ws) => {
  const connId = ++connectionCount;
  let subscriptionId = null;
  let changeTimer = null;

  console.log(`[conn ${connId}] Client connected`);

  ws.send(JSON.stringify({ type: "auth_required", ha_version: "2024.12.0" }));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "auth":
        console.log(`[conn ${connId}] Auth accepted (token: ${msg.access_token.slice(0, 8)}...)`);
        ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2024.12.0" }));
        break;

      case "ping":
        ws.send(JSON.stringify({ type: "pong", id: msg.id }));
        break;

      case "supported_features":
        reply(ws, msg.id, null);
        break;

      case "config/area_registry/list":
        console.log(`[conn ${connId}] -> area registry (${data.areas.length} areas)`);
        reply(ws, msg.id, data.areas);
        break;

      case "config/device_registry/list":
        console.log(`[conn ${connId}] -> device registry (${data.devices.length} devices)`);
        reply(ws, msg.id, data.devices);
        break;

      case "config/entity_registry/list":
        console.log(`[conn ${connId}] -> entity registry (${data.entities.length} entries, ${enabledCount} enabled)`);
        reply(ws, msg.id, data.entities);
        break;

      case "get_states":
        console.log(`[conn ${connId}] -> states (${data.states.length} states)`);
        reply(ws, msg.id, data.states);
        break;

      case "subscribe_events":
        subscriptionId = msg.id;
        console.log(`[conn ${connId}] -> subscribed to ${msg.event_type} (id: ${msg.id})`);
        reply(ws, msg.id, null);

        if (stateInterval > 0) {
          changeTimer = setInterval(() => {
            emitStateChange(ws, subscriptionId);
          }, stateInterval);
        }
        break;

      case "automation/config": {
        const config = data.automationConfigs.get(msg.entity_id);
        if (config) {
          reply(ws, msg.id, { config });
        } else {
          ws.send(JSON.stringify({
            type: "result",
            id: msg.id,
            success: false,
            error: { code: "not_found", message: `Unknown automation: ${msg.entity_id}` },
          }));
        }
        break;
      }

      default:
        console.log(`[conn ${connId}] -> unhandled: ${msg.type}`);
        reply(ws, msg.id, null);
    }
  });

  ws.on("close", () => {
    console.log(`[conn ${connId}] Client disconnected`);
    if (changeTimer) clearInterval(changeTimer);
  });

  ws.on("error", (err) => {
    console.error(`[conn ${connId}] Error:`, err.message);
    if (changeTimer) clearInterval(changeTimer);
  });
});

function reply(ws, id, result) {
  ws.send(
    JSON.stringify({ type: "result", id, success: true, result }),
  );
}

function emitStateChange(ws, subId) {
  if (ws.readyState !== 1) return;

  const entry = data.states[Math.floor(Math.random() * data.states.length)];
  const domain = entry.entity_id.split(".")[0];
  const def = DOMAIN_DEFS[domain];
  if (!def) return;

  const oldState = { ...entry, attributes: { ...entry.attributes } };

  // Generate a plausible new state
  if (def.stateValue) {
    entry.state = def.stateValue(entry.attributes.friendly_name || "");
  } else if (def.states) {
    const other = def.states.filter((s) => s !== entry.state);
    entry.state = other[Math.floor(Math.random() * other.length)] || entry.state;
  }
  const now = new Date().toISOString();
  entry.last_changed = now;
  entry.last_updated = now;

  // Refresh attributes too
  if (def.attributes) {
    const newAttrs = def.attributes(entry.attributes.friendly_name || "");
    Object.assign(entry.attributes, newAttrs);
  }

  ws.send(
    JSON.stringify({
      type: "event",
      id: subId,
      event: {
        event_type: "state_changed",
        data: {
          entity_id: entry.entity_id,
          old_state: oldState,
          new_state: { ...entry, attributes: { ...entry.attributes } },
        },
        origin: "LOCAL",
        time_fired: now,
        context: { id: randomUUID(), user_id: null, parent_id: null },
      },
    }),
  );
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Try a different port with -p.`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `Mock HA server listening on http://localhost:${port}\n` +
      `  ${enabledCount} entities across ${data.areas.length} areas (${Object.keys(DOMAIN_DEFS).length} domains)\n` +
      `  ${data.automationConfigs.size} automations with configs\n` +
      `  State changes every ${stateInterval}ms${stateInterval === 0 ? " (disabled)" : ""}\n` +
      `  Connect with URL: http://localhost:${port} and any token value`,
  );
});
