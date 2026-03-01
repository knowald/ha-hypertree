# Changelog

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
