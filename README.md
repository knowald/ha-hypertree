# HA Hypertree

![HA Hypertree](public/icon.png)

Interactive tree visualizations for your Home Assistant entity hierarchy.

Preview available at [hypertree.eightypercent.dev](https://hypertree.eightypercent.dev).

---

HA Hypertree connects to a Home Assistant instance and renders its areas, devices, and entities as a navigable tree. Seven visualization modes are available:

- **Force** - Force-directed graph layout
- **Dendrogram** - Hierarchical cluster diagram
- **Globe** - Spherical projection
- **Hyperbolic** - Poincare disk with click-to-focus navigation
- **Matrix** - Adjacency matrix
- **Sunburst** - Radial arc layout
- **Treemap** - Rectangular partitioning with zoom

Entity states update in real time over WebSocket.

## Setup

You need a [Long-Lived Access Token](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token) from your Home Assistant instance.

1. In Home Assistant, go to your profile page and create a Long-Lived Access Token.
2. Run the app (see below) and enter your HA URL and token in the login form.

Credentials are saved in your browser's local storage for auto-reconnect.

## Running

```sh
npm install
npm run dev
```

Then open the URL shown by Vite (usually `http://localhost:5173`).

### Production build

```sh
npm run build
npm run preview
```

The built files in `dist/` can be served by any static file server.

### Local HTTPS

To test the protocol mismatch warning or connect to an HTTPS HA instance from localhost, generate a local certificate with [mkcert](https://github.com/FiloSottile/mkcert) and start the dev server over HTTPS:

```sh
just dev-https
```

The dev server detects `.certs/` automatically and serves over HTTPS when the certificates are present.

## Interactions

- **Click** a node to copy its entity ID to the clipboard
- **Right-click** a node for a context menu with Copy ID, View History, and View Logbook

## Keyboard shortcuts

- `` ` `` (backtick) - Toggle debug console

## Privacy

This app is entirely client-side. Your browser connects directly to your Home Assistant instance via WebSocket. There is no backend, no analytics, and no telemetry.

## License

MIT
