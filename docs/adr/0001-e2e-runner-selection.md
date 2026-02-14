# ADR 0001: E2E Test Runner Selection

## Status

Accepted (2026-02-12)

## Context

We need to select an E2E test runner for the Serializd-Plex Firefox extension that can:

1. Load Firefox extensions as temporary add-ons
2. Run in CI (GitHub Actions)
3. Provide reliable, deterministic test execution
4. Support fixture server integration for offline testing
5. Allow debugging when tests fail

## Decision

We will use **WebdriverIO (WDIO)** with **GeckoDriver** for Firefox extension E2E testing.

## Rationale

### Evaluation Matrix

| Criteria | WebdriverIO | Playwright | Selenium | Puppeteer |
|----------|-------------|------------|----------|-----------|
| Firefox extension loading | ✅ Native | ❌ Poor | ⚠️ Complex | ❌ Chrome-only |
| CI setup complexity | Low | Low | Medium | N/A |
| Debugging ergonomics | Good | Excellent | Fair | N/A |
| Maintenance burden | Low | Low | Medium | N/A |
| Firefox MV3 support | ✅ Full | ❌ Limited | ⚠️ Partial | ❌ None |
| Community/Docs | Excellent | Excellent | Good | N/A |

### Key Factors

1. **Firefox Extension Loading**: WebdriverIO's `installAddOn` command (via GeckoDriver) provides first-class support for loading temporary Firefox extensions. This is the standard approach recommended by Mozilla.

2. **GeckoDriver Integration**: WDIO uses GeckoDriver directly, which is maintained by Mozilla and has full support for Firefox's WebExtension API including MV3.

3. **CI Stability**: WDIO has mature CI integrations with built-in retry mechanisms, screenshot on failure, and detailed error reporting.

4. **Fixture Server Compatibility**: WDIO's `onPrepare`/`onComplete` hooks allow us to start/stop the fixture server alongside the test run.

5. **Debugging**: WDIO provides:
   - `--watch` mode for development
   - Screenshot capture on failure
   - DOM snapshot artifacts
   - Detailed command logging

### Alternatives Considered

**Playwright**: 
- Excellent for web apps but has poor Firefox extension support
- Chromium-centric; Firefox implementation is secondary
- No native way to load temporary extensions in Firefox

**Selenium WebDriver**:
- More verbose API than WDIO
- Requires more boilerplate for extension loading
- Older tooling with higher maintenance burden

**web-ext (Mozilla)**:
- Great for extension development (`web-ext run`, `web-ext lint`, `web-ext build`)
- Not designed for E2E assertions
- Would need to pair with another tool for actual testing

## Implementation

- **Runner**: WebdriverIO v9.x
- **Browser**: Firefox (driven by GeckoDriver via WebDriver protocol)
- **Test Framework**: Mocha (WDIO)
- **Extension loading**: build test addon `.xpi` then install with `browser.installAddOn(..., true)` in WDIO `before` hook
- **CI**: GitHub Actions with Firefox installed via `browser-actions/setup-firefox`

## Consequences

### Positive
- Reliable Firefox extension testing with official Mozilla tooling
- Single test stack (no need for multiple runners)
- Good developer experience with watch mode and detailed errors
- Strong CI support out of the box

### Negative
- Firefox-only (no Chrome testing) - acceptable since extension targets Firefox
- Requires GeckoDriver binary management (handled by WDIO)

### Risks
- GeckoDriver/Firefox compatibility can drift over time
- Mitigation: Keep Firefox setup explicit in CI and pin versions if instability appears

## References

- [WebdriverIO Firefox Extension Testing](https://webdriver.io/docs/firefox-extension-testing)
- [GeckoDriver Documentation](https://firefox-source-docs.mozilla.org/testing/geckodriver/)
- [MDN: WebExtensions Testing](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Testing)
