# Serializd for Plex

Firefox extension that adds [Serializd](https://serializd.com) links/ratings to Plex TV show, season, and episode pages.

[Now officially available as a Firefox Add-on!](https://addons.mozilla.org/en-US/firefox/addon/serializd-plex/) 

![Screenshot showing Serializd rating displayed on a Plex title page](screenshots/screenshot.png)

> Major inspiration by [Plexboxd](https://github.com/lennysgarage/Plexboxd/tree/firefox)!

## Local development

Install dependencies once:

```bash
npm install
```

Build extension scripts + manifest for local testing:

```bash
npm run build:dev
```

Load in Firefox:

1. Open `about:debugging`
2. Go to **This Firefox**
3. Click **Load Temporary Add-on...**
4. Select `manifest.json`

## Dev log relay (optional)

If you want verbose development logs streamed to a local file:

1. Build with relay permission enabled:

```bash
npm run build:dev:relay
```

2. Start relay server:

```bash
node devtools/relay/server.js
```

Logs are appended to `.devlogs/firefox-console.ndjson`.

## Production release

Create a clean production artifact:

```bash
npm run release
```

This does all of the following:
- bundles `src/content.js` and `src/background.js` with dev flags disabled
- keeps production JS **non-minified** (recommended for extension review transparency)
- verifies production output keeps relay/debug features disabled
- packages only runtime extension files into `serializd-plex-v<version>.zip`

Packaged runtime files are limited to:
- `manifest.json`
- `styles.css`
- `scripts/content.js`
- `scripts/background.js`
- `icons/*`

## Notes

- The extension depends on Plex DOM/API behavior and TMDB-linked metadata.
- Serializd data is fetched by scraping the public website (no official API).
- Ratings/cache data is stored locally in browser storage.

## Privacy policy

- No personal data is collected or sold.
- Plex metadata is processed locally to build Serializd links.
- No analytics or third-party tracking is included.
