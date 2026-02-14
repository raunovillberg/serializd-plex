/**
 * E2E Test Helpers
 *
 * Common utilities for Serializd-Plex E2E tests.
 */

import assert from 'node:assert/strict';
import axios from 'axios';

export const FIXTURE_SERVER = process.env.FIXTURE_SERVER_URL || 'http://127.0.0.1:32400';
export const READINESS_TIMEOUT_MS = 5000;
export const READINESS_POLL_MS = 100;
export const REINJECTION_BUDGET_MS = 1200;

/**
 * Reset fixture server metrics before/after each test
 */
export async function resetMetrics() {
  await axios.post(`${FIXTURE_SERVER}/__metrics/reset`);
}

/**
 * Get current metrics from fixture server
 */
export async function getMetrics() {
  const response = await axios.get(`${FIXTURE_SERVER}/__metrics`);
  return response.data;
}

/**
 * Wait for extension readiness marker
 */
export async function waitForReadiness(timeoutMs = READINESS_TIMEOUT_MS) {
  await browser.waitUntil(async () => {
    const markerJson = await browser.execute(() =>
      document.documentElement.getAttribute('data-serializd-plex-ready')
    );

    if (!markerJson) return false;

    try {
      const marker = JSON.parse(markerJson);
      return !!(marker && marker.version && marker.ts && marker.href);
    } catch {
      return false;
    }
  }, {
    timeout: timeoutMs,
    interval: READINESS_POLL_MS,
    timeoutMsg: 'Readiness marker was not set within timeout'
  });

  return await browser.execute(() => {
    const markerJson = document.documentElement.getAttribute('data-serializd-plex-ready');
    return markerJson ? JSON.parse(markerJson) : null;
  });
}

/**
 * Wait for fixture bootstrap request to complete
 */
export async function waitForBootstrap(timeoutMs = 5000) {
  await browser.waitUntil(async () => {
    const bootstrap = await browser.execute(() => window.__PLEX_FIXTURE_BOOTSTRAP__ || null);
    return !!bootstrap?.completed;
  }, {
    timeout: timeoutMs,
    interval: 100,
    timeoutMsg: 'Fixture bootstrap metadata request did not complete'
  });

  return await browser.execute(() => window.__PLEX_FIXTURE_BOOTSTRAP__ || null);
}

/**
 * Navigate to a fixture page and wait for readiness
 */
export async function navigateToFixture(path, key = null) {
  let url = `${FIXTURE_SERVER}${path}`;

  // Add key to URL hash so extension can extract it (Plex SPA style)
  if (key) {
    url += `#!/server/localhost/details?key=${encodeURIComponent(key)}`;
  }

  await browser.url(url);
  await waitForReadiness();
}

/**
 * Get injected Serializd link wrapper element
 */
export async function getInjectedLink() {
  return await browser.execute(() => {
    const wrapper = document.querySelector('.serializd-link-wrapper');
    if (!wrapper) return null;

    return {
      href: wrapper.href,
      exists: true,
      hasRating: !!wrapper.querySelector('.serializd-rating'),
      isEpisode: !!wrapper.querySelector('.serializd-episode')
    };
  });
}

/**
 * Wait for Serializd link to be injected
 */
export async function waitForInjection(timeoutMs = 8000) {
  await browser.waitUntil(async () => {
    const link = await getInjectedLink();
    return !!link;
  }, {
    timeout: timeoutMs,
    interval: 100,
    timeoutMsg: 'Serializd link was not injected within timeout'
  });

  return await getInjectedLink();
}

/**
 * Assert no unmatched or denied requests
 */
export async function assertNoUnmatchedRequests() {
  const metrics = await getMetrics();

  assert.equal(
    metrics.unmatchedCount,
    0,
    `Expected zero unmatched requests, got ${metrics.unmatchedCount}: ${JSON.stringify(metrics.unmatchedRequests)}`
  );

  assert.equal(
    metrics.deniedCount,
    0,
    `Expected zero denied requests, got ${metrics.deniedCount}: ${JSON.stringify(metrics.deniedRequests)}`
  );
}

/**
 * Assert no external network requests (offline guard)
 * This checks that all requests went to localhost/127.0.0.1
 */
export async function assertOfflineGuard() {
  const metrics = await getMetrics();

  // All recorded requests should be to localhost
  for (const req of metrics.requests) {
    // Path should start with / (relative to fixture server)
    assert.ok(
      req.path.startsWith('/') || req.path.startsWith('http://127.0.0.1') || req.path.startsWith('http://localhost'),
      `External network request detected: ${req.path}`
    );
  }
}

/**
 * Trigger SPA navigation via pushState
 */
export async function triggerPushState(path) {
  await browser.execute((newPath) => {
    window.history.pushState({}, '', newPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * Trigger hash change
 */
export async function triggerHashChange(hash) {
  await browser.execute((newHash) => {
    window.location.hash = newHash;
  }, hash);
}

/**
 * Get current URL path/hash
 */
export async function getCurrentPath() {
  return await browser.execute(() => ({
    pathname: window.location.pathname,
    hash: window.location.hash,
    href: window.location.href
  }));
}

/**
 * Measure time for reinjection after navigation
 */
export async function measureReinjectionTime(navigationFn) {
  const start = Date.now();

  // Trigger navigation
  await navigationFn();

  // Wait for new injection
  await waitForInjection(2000);

  const elapsed = Date.now() - start;
  return elapsed;
}
