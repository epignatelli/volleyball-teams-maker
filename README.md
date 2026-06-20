# VB Lineup Builder

A Progressive Web App for generating valid volleyball lineup combinations.

## Features
- Filters by setter, libero, must-include hitters, must-include middles
- Multi-select for hitters and middles
- Rotation-sensitive detection (lineups where a middle swap could leave exactly 2 women)
- Sortable results
- Works offline after first visit
- Installable on iOS and Android home screens

## Deploy to GitHub Pages

1. Create a new repo on GitHub (e.g. `vb-lineups`)
2. Drop all these files into the root of the repo
3. Go to **Settings → Pages → Source** and set it to `main` branch, `/ (root)`
4. Your app will be live at `https://yourusername.github.io/vb-lineups/`

> ⚠️ If GitHub Pages serves the app from a subdirectory (e.g. `/vb-lineups/`), update the `start_url` in `manifest.json` to `./index.html` — it already uses a relative path so it should work fine.

## Install on iPhone
1. Open the URL in Safari
2. Tap the Share button → **Add to Home Screen**

## Install on Android
1. Open the URL in Chrome
2. Tap the banner or **⋮ → Add to Home screen**

## Customising players

Edit the top of `app.js`:

```js
const WOMEN   = new Set(['Marina','Josie','Maria','Taylor']);
const SETTERS = ['Dwain','Taylor'];
const HITTERS = ['Edu','Oz','Dwain','Loki','Marina','Josie'];
const MIDDLES = ['Edu','Oz','Loki','Marina'];
const LIBS    = ['Maria','Oz'];
```

The lineup logic regenerates automatically from whatever you put here.
