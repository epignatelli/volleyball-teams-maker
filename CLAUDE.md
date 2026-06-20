# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A collection of no-build, no-framework Progressive Web Apps (PWAs) for volleyball, served as static files from GitHub Pages.

```
index.html          ← landing page listing all apps
vb-lineups/         ← lineup builder app
  index.html
  app.js
  style.css
  manifest.json
  sw.js
  icons/
```

## Running locally

```sh
python3 -m http.server 8080
# landing page: http://localhost:8080
# vb-lineups:   http://localhost:8080/vb-lineups/
```

For KQOTC QR check-in testing, use `serve.py` instead — it exposes `GET /api/ip` so the app can auto-detect the LAN IP and generate a scannable QR code from other devices on the same network:

```sh
python3 serve.py
# also prints the LAN URL, e.g. http://192.168.1.42:8080
```

The service worker (`sw.js`) only activates over HTTPS or `localhost`.

## Adding a new app

1. Create `<app-name>/` with `index.html`, `app.js`, `style.css`, `manifest.json`, `sw.js`
2. Add a card for it in the root `index.html`

## Deployment

Push to GitHub Pages (`main` branch, root). No build step.

If the service worker cache gets stale after code changes, bump the `CACHE` constant in the app's `sw.js`. The activate handler purges old cache keys automatically.

## VB Lineups — architecture

**Two screens, one JS file.** `index.html` holds both screen divs (`#screen-setup`, `#screen-results`); CSS `.screen.active` toggles visibility. All state and logic is in `app.js`, executing as a plain script with globals.

**State:**
- `players` — array of `{ id, name, gender:'m'|'f', positions: Set<string> }`, persisted to `localStorage` under `vb-roster-v1`. Sets are not JSON-serialisable; boot re-hydrates them from arrays.
- `minWomen` — minimum women required on court per rotation, persisted under `vb-settings-v1`.
- `splitHitters` — boolean toggle for OH/OPP split mode, persisted under `vb-settings-v1`.
- `ALL_LINEUPS` — computed on "Build lineups", held in memory for the results screen.
- `filterState` — ephemeral per-session filter/sort state for the results screen.

**Lineup generation (`generateLineups`):** Brute-force combinatorial search — picks 1 setter, 3 hitters, 2 middles, 1 libero from the `positions` sets, then checks each rotation (libero substitutes for each middle) against `minWomen`. Marks a lineup `tight` when any rotation lands exactly at `minWomen`.

**CSS custom properties** (defined on `:root` in `style.css`) drive the entire color system — `--green` for women, `--purple` for men, `--amber` for rotation-sensitive warnings. Font: Barlow Condensed (loaded from Google Fonts).
