# Mock HA server

A standalone mock Home Assistant WebSocket server for testing and demos without a real HA instance.

## Usage

```bash
npm run mock
```

Or with options:

```bash
npm run mock -- -e 1000 -p 8124 -i 500
```

| Option | Default | Description |
|--------|---------|-------------|
| `-e, --entities` | 500 | Number of entities to generate |
| `-p, --port` | 8123 | Server port |
| `-i, --interval` | 2000 | State change interval in ms (0 to disable) |
| `-h, --help` | | Show help |

Then point the app at `http://localhost:<port>` with any token value.

## What it provides

- Full HA WebSocket auth handshake (accepts any token)
- Area, device, and entity registries with realistic names across 12 domains
- Entity states with domain-appropriate values and attributes
- Periodic `state_changed` events
- Automation configs with trigger/condition/action references to other entities
- HTTP endpoint returning a JSON summary (for verifying the server is running)
