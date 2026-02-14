# Plex Test Fixtures

This directory contains sanitized, deterministic fixtures for E2E testing.

## Structure

```
plex/
├── manifest.json     # Fixture version and metadata
├── routes.json       # Route definitions for fixture server
├── pages.json        # Page/URL fixture definitions
└── xml/
    ├── show.xml      # Show metadata response
    ├── season.xml    # Season metadata response
    └── episode.xml   # Episode metadata response
```

## Fixture Schema

### manifest.json

```json
{
  "fixtureVersion": "1.0.0",
  "generated": "2026-02-13T00:00:00.000Z",
  "source": "har-capture",
  "scenarios": ["show", "season", "episode"]
}
```

### routes.json

Defines which XML fixture to serve for each metadata key:

```json
{
  "/library/metadata/10001": { "fixture": "show.xml", "scenario": "show" },
  "/library/metadata/10002": { "fixture": "season.xml", "scenario": "season" },
  "/library/metadata/10003": { "fixture": "episode.xml", "scenario": "episode" }
}
```

**Per-route latency override** (for slow-response tests):

```json
{
  "/library/metadata/10003": { 
    "fixture": "episode.xml", 
    "scenario": "episode",
    "latencyMs": 3000
  }
}
```

When `latencyMs` is set, that route will always have the specified delay, overriding the global `FIXTURE_LATENCY` profile.

**HTTP error simulation** (for error-path tests):

```json
{
  "/library/metadata/19999": {
    "scenario": "error-500",
    "errorStatus": 500,
    "errorBody": { "error": "Internal Server Error" }
  }
}
```

## Fixture Server

The fixture server (`tests/fixture-server.mjs`) supports:

**Latency profiles** (via `FIXTURE_LATENCY` env var):
- `fast` (default): 1-5ms
- `normal`: 50-150ms with jitter
- `slow`: 500ms fixed

**Endpoints**:
- `GET /web/*` - HTML fixture pages with bootstrap script
- `GET /library/metadata/*` - XML metadata fixtures
- `GET /health` - Server health check
- `GET /__metrics` - Request counters and unmatched requests
- `POST /__metrics/reset` - Reset all metrics

### pages.json

Defines test page configurations:

```json
{
  "show": {
    "path": "/web/show",
    "title": "Test Show",
    "year": "2024",
    "metadataKey": "/library/metadata/10001"
  }
}
```

### XML Fixtures

Sanitized Plex API responses. Key sanitizations:

- `ratingKey`, `parentRatingKey`, `grandparentRatingKey` → stable numeric IDs
- `guid` → `tmdb://XXXXX` format with stable TMDB IDs
- `key` → stable path references
- All tokens removed
- Hostnames normalized to fixture server

## Regenerating Fixtures

```bash
# 1. Capture HAR from Plex (see scripts/e2e/fixtures-capture.mjs)
npm run fixtures:capture

# 2. Generate sanitized fixtures from HAR
npm run fixtures:generate

#    (also writes tests/fixtures/raw/id-map.json for local drift checks)
```

## Drift Check

Detect when Plex API responses change compared to your fixtures:

```bash
PLEX_SERVER_URL=http://192.168.1.100:32400 PLEX_TOKEN=your-token npm run fixtures:drift-check
```

This compares the **structure** (attribute names, element names) of your fixtures against live Plex responses. It does NOT compare values.

`fixtures:drift-check` uses `tests/fixtures/raw/id-map.json` (gitignored) to map sanitized fixture IDs back to your live Plex metadata keys.

**What it detects:**
- New attributes added by Plex
- Attributes removed by Plex
- New XML elements

**What it ignores:**
- Value changes (IDs, titles, etc.)
- Order of attributes

**When to run:**
- Before releases
- When you notice the extension behaving differently
- After Plex updates

## Integrity Checks

The generator enforces:

- XML parse validity
- Referential integrity (parent/grandparent keys exist in fixture set)
- Required attributes present (`ratingKey`, `title`, `type`)
- No token-like strings remaining
