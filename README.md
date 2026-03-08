# HA Hypertree

![HA Hypertree](public/icon.png)

Interactive tree visualizations for your Home Assistant entity hierarchy.

Preview available at [hypertree.eightypercent.dev](https://hypertree.eightypercent.dev).

---

HA Hypertree connects to a Home Assistant instance and renders its areas, devices, and entities as an interactive force-directed graph. Entity states update in real time over WebSocket.

Features include domain/area/state filtering, search with optional filter mode, automation edge visualization, and constellation rendering with customizable star effects.

## Installation

### HACS (Home Assistant)

Install as a custom panel directly in Home Assistant via [HACS](https://hacs.xyz):

1. In HACS, go to the three-dot menu and select **Custom repositories**.
2. Add `https://github.com/knowald/ha-hypertree-hacs` with category **Integration**.
3. Install "HA Hypertree" from the HACS store.
4. Restart Home Assistant.
5. Go to **Settings > Devices & Services > Add Integration** and search for "HA Hypertree".

A new "Hypertree" entry appears in the sidebar. No token or login needed, the panel uses your existing HA session.

### Standalone

You can also run it as a standalone webapp. You need a [Long-Lived Access Token](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token) from your Home Assistant instance.

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

- **Click** a node to copy its ID to the clipboard
- **Shift+click** an area or device node to collapse/expand its children
- **Right-click** a node for a context menu (Copy ID, View History, View Logbook, Open in HA, Collapse/Expand)

Collapsed nodes show a dashed ring and a badge with the hidden entity count.

## Keyboard shortcuts

- `` ` `` (backtick) - Toggle debug console

## Privacy

This app is entirely client-side. Your browser connects directly to your Home Assistant instance via WebSocket. There is no backend, no analytics, and no telemetry.

## License

MIT
