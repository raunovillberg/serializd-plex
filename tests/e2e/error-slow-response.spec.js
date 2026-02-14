/**
 * Slow Response Spec
 *
 * Tests that the extension handles slow metadata responses correctly.
 *
 * Expected behavior:
 * - Extension waits for response
 * - Retry behavior works correctly
 * - Stable completion even with 3s delay
 */

import assert from 'node:assert/strict';
import {
  resetMetrics,
  waitForReadiness,
  waitForBootstrap,
  waitForInjection,
  getInjectedLink,
  assertNoUnmatchedRequests,
  FIXTURE_SERVER
} from './helpers.mjs';

const SLOW_URL = `${FIXTURE_SERVER}/web/slow#!/server/local/details?key=%2Flibrary%2Fmetadata%2F19904`;

describe('Slow Response Handling', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  afterEach(async function () {
    await assertNoUnmatchedRequests();
  });

  it('page remains functional during slow response', async function () {
    await browser.url(SLOW_URL);
    await waitForReadiness();

    // Don't wait for bootstrap - check page immediately
    const pageInfo = await browser.execute(() => ({
      hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
      hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]')
    }));

    assert.ok(pageInfo.hasTitle, 'Page should have title element');
    assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
  });

  it('bootstrap completes after slow response', async function () {
    this.timeout(20000);

    const start = Date.now();
    await browser.url(SLOW_URL);
    await waitForReadiness();

    // Bootstrap should complete (after 3s delay)
    const bootstrap = await waitForBootstrap(15000);
    const totalTime = Date.now() - start;

    console.log(`Total time including page load: ${totalTime}ms`);

    assert.equal(bootstrap.status, 200, 'Should receive 200 after delay');
    assert.ok(totalTime >= 2500, `Should have waited at least 2.5s for slow response, was ${totalTime}ms`);
  });

  it('does not crash with slow response', async function () {
    this.timeout(20000);

    await browser.url(SLOW_URL);
    await waitForReadiness();
    await waitForBootstrap(15000);

    // Page should still be functional
    const pageInfo = await browser.execute(() => ({
      hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
      hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]'),
      hasErrors: window.__SERIALIZD_PLEX_ERROR__ || false
    }));

    assert.ok(pageInfo.hasTitle, 'Page should have title element');
    assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
    assert.ok(!pageInfo.hasErrors, 'Should not have extension errors');
  });
});
