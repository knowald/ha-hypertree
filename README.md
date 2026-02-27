# HA Hypertree

![HA Hypertree](icon.png)

Interactive tree visualizations for your Home Assistant entity hierarchy.

Preview available at [hypertree.eightypercent.dev](https://hypertree.eightypercent.dev).

---

HA Hypertree connects to a Home Assistant instance and renders its areas, devices, and entities as a navigable tree. Seven visualization modes are available:

- **Force** -- Force-directed graph layout
- **Dendrogram** -- Hierarchical cluster diagram
- **Globe** -- Spherical projection
- **Hyperbolic** -- Poincare disk with click-to-focus navigation
- **Matrix** -- Adjacency matrix
- **Sunburst** -- Radial arc layout
- **Treemap** -- Rectangular partitioning with zoom

Entity states update in real time over WebSocket.

## Setup

You need a [Long-Lived Access Token](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token) from your Home Assistant instance.

1. In Home Assistant, go to your profile page and create a Long-Lived Access Token.
2. Run the app (see below) and enter your HA URL and token in the login form.

Credentials are saved in your browser's local storage for auto-reconnect.

## Running

```sh
pnpm install
pnpm dev
```

Then open the URL shown by Vite (usually `http://localhost:5173`).

### Production build

```sh
pnpm build
pnpm preview
```

The built files in `dist/` can be served by any static file server.

## Privacy

This app is entirely client-side. Your browser connects directly to your Home Assistant instance via WebSocket. There is no backend, no analytics, and no telemetry.

## License

MIT
