# Serializd-Plex E2E Plan v4 (Deterministic, Offline, CI-Stable)

_Last updated: 2026-02-12_

_External review status: GLM-5 re-review = **SATISFIED** (no blocking changes required)._
## 0) Executive summary

This plan defines a deterministic end-to-end (E2E) testing strategy for the Firefox extension in this repository, with realistic fixtures derived from real Plex traffic.

Core approach:
1. **Prove automation stack first** (Firefox extension loading + readiness handshake in CI).
2. **Capture real Plex traffic once** (show/season/episode), then sanitize and commit replay fixtures.
3. **Replay only minimal required Plex surface** on localhost.
4. **Test core + failure paths** with strict timing contracts and no external network dependency.
5. **Continuously detect drift** against real Plex schema to avoid silent fixture rot.

---

## 1) Goals, non-goals, and constraints

### Goals
- Deterministic E2E tests for extension behavior on Plex-like routes.
- Offline-capable CI runs (localhost fixture server only).
- Realistic fixture fidelity by seeding from real Plex network captures.
- Explicit contracts for SPA navigation and metadata interception behavior.
- Stable, low-flake test suite with measurable timing budgets.

### Non-goals
- Building a full Plex emulator.
- Full visual parity with Plex UI.
- Exhaustively replaying all Plex endpoints.
- End-to-end authentication to real Plex in CI.

### Hard constraints
- No real tokens/keys/hostnames committed.
- Extension must be tested as an actual loaded Firefox addon (not unit-mocked content script only).
- Production behavior must remain unaffected by test hooks (test-only toggles guarded by dev/test flags).

---

## 2) Test architecture (target state)

### Components
1. **E2E runner** (Firefox-capable, CI-supported).
2. **Fixture capture pipeline** (`fixtures:capture` + `fixtures:generate`).
3. **Fixture replay server** (`tests/fixture-server.mjs`).
4. **E2E specs** (core + error paths + resilience).
5. **Drift checker** (`fixtures:drift-check`).

### Data flow
1. Real Plex browsing session (manual/semi-automated) -> HAR with response bodies.
2. Generator extracts relevant `library/metadata` entries -> sanitizes -> writes canonical fixtures.
3. Replay server serves fixture HTML/XML on localhost.
4. E2E runner loads extension + navigates fixture pages.
5. Tests assert DOM injections, URLs, retries, and error handling.

---

## 3) Contracts (must be explicit and testable)

## 3.1 Extension readiness marker protocol

### Purpose
Avoid race conditions where tests assert before content/background scripts are fully initialized.

### Contract
- Content script sets a readiness marker after `init()` enters steady state:
  - `window.__SERIALIZD_PLEX_READY__ = { version: '<ext-version>', ts: <epochMs>, href: <currentHref> }`
- Marker must be updated on SPA route changes.
- E2E helper polls for marker for up to **5000ms**, interval **100ms**.
- Failure mode: test hard-fails with current URL and DOM snapshot.

### Acceptance
- Smoke spec passes 10/10 locally and in CI with no marker timeout.

## 3.2 Metadata interception trigger contract

### Purpose
Ensure tests exercise real `background webRequest -> content message` path.

### Contract
Fixture page must issue a network request matching:
- path contains `/library/metadata/`
- query includes `X-Plex-Token=<fixture-token>`
- host is fixture host (`127.0.0.1` or mapped test domain)

Trigger mechanism (mandatory, deterministic):
- Each `/web/*` fixture HTML includes a tiny inline script that runs on load and performs:
  - `fetch('/library/metadata/<fixtureKey>?includeGuids=1&includeExternalMedia=1&X-Plex-Token=<fixture-token>')`
- The script stores request/response status to `window.__PLEX_FIXTURE_BOOTSTRAP__` for debugging.
- The request is intentionally real (not mocked in-page) so Firefox `webRequest.onCompleted` sees it.

Expected behavior:
- Background `onCompleted` listener captures request.
- Content script receives `plexApiIntercepted` message.
- Processing path uses intercepted server context or location-derived context.

### Acceptance
- For each scenario, assertion confirms injected link is based on captured metadata key (not only route fallback).

## 3.3 SPA reinjection timing budget contract

### Purpose
Make reinjection latency measurable and enforceable.

### Contract
For `pushState`/`popstate`/`hashchange` transitions:
- old injection removed and new injection present within **1200ms** (budget aligned with debounce + retry schedule).
- test records timestamps:
  - `t_nav`: navigation event trigger
  - `t_inject`: first detection of `.serializd-link-wrapper` with expected URL
- assert `t_inject - t_nav <= 1200ms` on normal fixture latency.

### Notes
- 1200ms budget intentionally accommodates 500ms debounce and occasional retry scheduling.

## 3.4 Cache and test-state isolation contract

### Purpose
Prevent cross-test contamination from `chrome.storage.local` caches (`cached_shows`, `cached_servers`) and fixture server counters.

### Contract
- Before each test:
  - clear extension storage namespace used by the extension
  - reset fixture server metrics (`/__metrics/reset` endpoint)
- After each test:
  - assert unmatched request count == 0 unless test explicitly expects otherwise
  - clear storage again (defensive double-clean)
- Tests must not assume previous test cache state.

### Acceptance
- Running full suite in random order yields identical pass/fail outcome.

## 3.5 Teardown contract

### Purpose
Guarantee deterministic cleanup and easier flake triage.

### Contract
After each test case:
- close page/tab contexts created by the spec
- clear extension storage keys used by the test
- reset fixture server metrics (`POST /__metrics/reset`)
- persist artifacts on failure only (DOM snapshot, blocked-egress list, unmatched routes)

After each test file:
- verify no orphan browser contexts
- verify fixture server request counters reset to zero baseline

### Acceptance
- No state leakage between test files over repeated runs.

---

## 4) Fixture scope policy (strict)

### Allowed endpoints (explicit allow-list)
- `GET /web/*` (fixture HTML pages)
- `GET /library/metadata/*` (fixture XML)
- `GET /health` (server liveness)
- `GET /__metrics` (request counters)
- `POST /__metrics/reset` (counter reset for per-test isolation)

### Explicitly denied high-risk routes
- `* /:/transcode/*`
- `* /:/timeline/*`

### Denied/unexpected endpoint handling
- Any unmatched request returns `501` with JSON body.
- Server logs unmatched request (method, path, query).
- Explicitly denied routes return `403` and are counted separately.
- Test fails if unmatched request count > 0 unless test explicitly whitelists expected misses.

### Why
This prevents hidden dependency creep and ensures replay server remains minimal.

---

## 5) Phase plan and detailed checklist

## Phase A — Runner lock + smoke gate (P0)

### Deliverables
- runner selection ADR (short markdown note)
- `tests/e2e/smoke.spec.*`
- CI job running smoke only

### Tasks
1. Evaluate runner options against:
   - reliable Firefox addon loading
   - CI setup complexity
   - debugging ergonomics
2. Implement smoke:
   - start fixture server with single simple page
   - load extension
   - wait for readiness marker
   - assert no unmatched requests
3. Stabilize:
   - 10 consecutive local runs
   - 10 CI reruns (or matrix rerun)

### Exit criteria
- Smoke passes reliably (>= 95% over reruns; target 100%).

---

## Phase B — Capture + sanitize + integrity validation (P1)

### Deliverables
- `npm run fixtures:capture`
- `npm run fixtures:generate`
- fixture schema docs
- sanitized fixtures committed

### Tasks
1. Capture (semi-automated acceptable):
   - browse canonical show/season/episode pages
   - export HAR with response bodies
   - store raw under ignored path: `tests/fixtures/raw/`
2. Generate:
   - parse HAR
   - select relevant `library/metadata` entries
   - sanitize secrets and personal identifiers
   - normalize stable IDs/placeholders
   - emit:
     - `tests/fixtures/plex/xml/<scenario>.xml`
     - `tests/fixtures/plex/routes.json`
     - `tests/fixtures/plex/pages.json`
     - `tests/fixtures/plex/manifest.json` with `fixtureVersion`
3. Integrity checks (generator hard-fails on violations):
   - XML parse validity
   - `parentRatingKey`/`grandparentRatingKey` referential sanity in fixture set
   - required attributes exist for each scenario
   - no remaining token-like strings

### Exit criteria
- Generator deterministic (same input -> byte-identical output).
- All integrity checks pass.

---

## Phase C — Replay server implementation (P1)

### Deliverables
- `tests/fixture-server.mjs`
- deterministic latency controls
- unmatched request ledger

### Tasks
1. Build HTTP server:
   - route `/web/*` -> scenario HTML templates
   - route `/library/metadata/*` -> fixture XML
2. Add latency profiles:
   - `fast` (1–5ms)
   - `normal` (50–150ms jitter)
   - `slow` (500ms default; per-route override to 3000ms)
3. Add observability endpoints:
   - `/health`
   - `/__metrics` (counts per route, unmatched requests)
4. Enforce allow-list/deny behavior.

### Exit criteria
- Server supports all planned tests and exposes unmatched requests reliably.

---

## Phase D — Core deterministic specs (P1)

### Deliverables
- `tests/e2e/show-injection.spec.*`
- `tests/e2e/season-episode-url.spec.*`
- `tests/e2e/spa-reinjection.spec.*`
- `tests/e2e/retry-late-metadata.spec.*`

### Test details
1. **Show injection**
   - validate wrapper appears in ratings container
   - validate URL format: `https://www.serializd.com/show/<id>` or test override base
2. **Season/episode URL construction**
   - validate `/season/<seasonTmdbId>/<seasonNum>` and optional `/episode/<episodeNum>`
3. **SPA reinjection**
   - drive `pushState`, `hashchange`, `popstate`
   - enforce 1200ms reinjection budget
4. **Late metadata retry**
   - initial response missing/insufficient data
   - later response available
   - verify eventual injection within retry policy
5. **Offline guard**
   - enforce runner-level request guard: reject any request whose host is not `127.0.0.1`/`localhost`
   - capture blocked URL list in test artifacts
   - fail test immediately if any external network attempt occurs

### Exit criteria
- All core tests green across fast/normal profiles.

---

## Phase E — Error-path + resilience specs (P1)

### Deliverables
- `tests/e2e/error-malformed-xml.spec.*`
- `tests/e2e/error-http-status.spec.*`
- `tests/e2e/error-slow-response.spec.*`
- `tests/e2e/resilience-extension-reload.spec.*`

### Test details
1. **Malformed XML**
   - verify no crash, safe fallback behavior
2. **HTTP 500 and 401**
   - verify graceful handling and no broken DOM state
3. **Slow response (3s)**
   - verify retry behavior and stable completion
4. **Extension reload resilience**
   - trigger reload at a deterministic point (after metadata trigger, before first successful injection)
   - reload mechanism decided in Phase A ADR (document concrete API/runner command)
   - after reload, wait for readiness marker reappearance (<= 5000ms)
   - verify injection eventually recovers for current route

### Exit criteria
- All error/resilience tests pass in normal profile.

---

## Phase F — CI hardening + drift detection (P2)

### Deliverables
- CI jobs for smoke/core/error/drift
- scripts:
  - `npm run test:e2e`
  - `npm run test:e2e:headed`
  - `npm run fixtures:capture`
  - `npm run fixtures:generate`
  - `npm run fixtures:drift-check`

### Drift-check policy
- Scheduled weekly CI job (non-blocking for PRs).
- Runs on dedicated environment with access to controlled Plex instance credentials via masked CI secrets.
- Steps:
  1. capture fresh sample from controlled environment (`fixtures:capture` in drift mode)
  2. run structural diff against fixture schema (not value-by-value)
  3. on drift: auto-open issue with diff summary and impacted scenarios
  4. attach sanitized diff artifact; do **not** fail unrelated PR checks
- PR CI remains blocking for deterministic fixture tests only.

### Timing fuzz policy
- Execute core subset under 3 latency profiles:
  - fast, normal, slow
- Slow profile includes at least one 3000ms route delay scenario.

### CI browser strategy
- Use Firefox in xvfb-backed headed mode for consistency with extension behavior.
- Keep optional headless lane as non-blocking signal until parity is proven.

### CI timeout policy
- Per-spec timeout: 30s default; 45s for slow-profile specs.
- Per-job timeout: 20 minutes.
- If timeout breaches occur twice in 7 days, open flake/perf issue automatically.

### Exit criteria
- Stable CI signal for 2 weeks without unexplained flakes.

---

## 6) Test-only product changes (minimal and guarded)

## 6.1 Serializd base URL override
- Add test-only override mechanism (env or build-define), default remains production URL.
- Guard with non-prod build path; production verification must fail if override is enabled.

## 6.2 Readiness marker injection
- Add marker only in dev/test builds or behind explicit test flag.
- Must not expose sensitive data.

## 6.3 Observability hooks
- Optional debug counters/events for test assertions, disabled in production builds.

---

## 7) Security and privacy controls

- Raw captures are never committed.
- Sanitizer enforces token and hostname redaction.
- CI validates no token-like secrets in fixture files.
- Documented placeholders for all sensitive identifiers.

---

## 8) Definition of done (strict)

1. E2E suite runs fully offline against localhost fixture server.
2. Core + error/resilience tests are green in CI.
3. Readiness + SPA + metadata trigger contracts are documented and enforced.
4. Fixture pipeline is reproducible, sanitized, and integrity-checked.
5. Drift detection is active with issue automation.
6. No production behavior regression from test hooks.

---

## 9) Open decisions to resolve before coding

1. Final runner/tooling choice (with rationale note).
2. Exact method for extension reload in resilience test.
3. Whether headless lane becomes blocking after stability period.

---

## 10) Suggested implementation order (first 2 weeks)

### Week 1
- Day 1-2: Phase A (runner lock + smoke)
- Day 3-4: Phase B (capture/generate/integrity)
- Day 5: Phase C (replay server baseline)

### Week 2
- Day 1-2: Phase D core tests
- Day 3: Phase E error/resilience tests
- Day 4-5: Phase F CI/drift wiring + documentation cleanup

---

## 11) Traceability matrix (requirement -> tests -> fixtures)

| Requirement | Test spec | Primary fixtures |
|---|---|---|
| Show badge injection | `show-injection.spec` | `pages.show.json`, `xml/show.xml` |
| Season/episode deep links | `season-episode-url.spec` | `pages.season.json`, `pages.episode.json`, `xml/season.xml`, `xml/episode.xml` |
| SPA navigation robustness | `spa-reinjection.spec` | `routes.spa.json`, `xml/show.xml`, `xml/season.xml` |
| Retry behavior | `retry-late-metadata.spec` | `routes.retry.json`, `xml/retry-initial.xml`, `xml/retry-success.xml` |
| XML robustness | `error-malformed-xml.spec` | `xml/malformed.xml` |
| HTTP failure handling | `error-http-status.spec` | `routes.http-errors.json` |
| Timeout resilience | `error-slow-response.spec` | `routes.slow.json`, `xml/show.xml` |
| Runtime recovery | `resilience-extension-reload.spec` | `pages.show.json`, `routes.reload.json`, `xml/show.xml` |

---

## 12) Success metrics

- Flake rate < 1% over rolling 100 CI runs.
- Mean E2E runtime <= 8 minutes.
- Drift issues detected before fixture-caused production regressions.
- Zero leaked secrets in fixtures.
