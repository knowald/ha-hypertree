# Changelog

## 0.5.1 - 2026-03-02

### Added

- Add HACS custom panel integration with Shadow DOM web component
- Add dual build: standalone webapp and HA panel (`npm run build:panel`)
- Add root element abstraction for Shadow DOM compatibility
- Add release workflow to publish panel to distribution repo

### Fixed

- Use async static path registration for HA compatibility
- Declare http and frontend dependencies in manifest

## 0.4.1 - 2026-03-02

### Added

- Add justfile with dev, build, cert, and dev-https commands
- Add local HTTPS dev server support via mkcert certificates

### Changed

- Replace pnpm with npm in all docs and scripts
- Improve protocol mismatch warning wording on login form

### Fixed

- Fix crash when transparent() receives shorthand hex colors like #666

## 0.4.0 - 2026-03-02

### Added

- Add unavailable entity pulse with dimmed grey appearance in both normal and constellation modes
- Add protocol mismatch warning on login form when entering HTTP URL from HTTPS page
- Add GitHub Actions workflow for GitHub Pages deployment
- Add mutual exclusion between Hulls and Constellation toggles

### Changed

- Default entities toggle to on
- Add spacing between settings panel groups

## 0.3.0 - 2026-03-01

### Added

- Add Barnes-Hut quadtree for O(n log n) repulsion, replacing O(n^2) all-pairs loop
- Add entities toggle (default off) to start with only areas, domains, and devices visible
- Cache constellation star sprites on offscreen canvases to avoid per-frame gradient creation

### Changed

- Tune default force parameters: repulsion 3000, spring length 64, stiffness 0.035, damping 0.8
- Tune default constellation parameters: glow brightness 2, star size 0.8, glow intensity 1.2, twinkle speed 0.1
- Increase default label size to 16 and entity dot size to 16

## 0.2.0 - 2026-03-01

### Added

- Add constellation mode to Force visualization with star-like nodes, twinkling, glowing edges, and cross spikes
- Add five choosable entity state-change effects: Supernova, Shooting Star, Flare, Pulse Wave, Color Shift
- Add force tuning sliders for repulsion, spring length, spring stiffness, and damping
- Add constellation sliders for glow brightness, star size, glow intensity, parent glow, effect scale, twinkle speed, and line glow
- Add label size and entity dot size sliders
- Add hover highlight on nodes with cursor change
- Add click to copy entity ID to clipboard
- Add right-click context menu with Copy ID, View History, and View Logbook
- Add search field with live entity highlighting
- Add randomize colors and reset all settings buttons
- Add collapsible settings panel with gear toggle
- Add localStorage persistence for all settings

### Changed

- Render parent nodes above child glow effects in constellation mode
- Draw inter-cluster and parent-to-parent edges in constellation mode
- Hide hull grouping select when hulls are off
- Hide star settings when constellation mode is off

### Fixed

- Fix gradient darkening by replacing transparent with color-matched zero-alpha stops
- Fix twinkle glitch when glow brightness exceeds 1 by clamping alpha values
- Fix uneven star brightness at zero twinkle speed

## 0.1.0 - 2025-12-15

### Added

- Add seven visualization modes: Force, Dendrogram, Globe, Hyperbolic, Matrix, Sunburst, Treemap
- Add real-time entity state updates over WebSocket
- Add debug console toggled with backtick key
