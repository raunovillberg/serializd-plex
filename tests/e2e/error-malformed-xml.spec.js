/**
 * Malformed XML Error Spec
 *
 * Tests that the extension gracefully handles malformed XML responses.
 *
 * Expected behavior:
 * - No crash or uncaught exception
 * - Page remains functional
 * - Extension can recover on retry/navigation
 */

import assert from 'node:assert/strict';
import {
  resetMetrics,
  waitForReadiness,
  waitForBootstrap,
  getInjectedLink,
  assertNoUnmatchedRequests,
  FIXTURE_SERVER
} from './helpers.mjs';

// Route configured with malformed XML in routes.json
const MALFORMED_URL = `${FIXTURE_SERVER}/web/malformed#!/server/local/details?key=%2Flibrary%2Fmetadata%2F19901`;

describe('Malformed XML Error Handling', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  afterEach(async function () {
    await assertNoUnmatchedRequests();
  });

  it('does not crash when receiving malformed XML', async function () {
    await browser.url(MALFORMED_URL);
    await waitForReadiness();
    const bootstrap = await waitForBootstrap();

    // Bootstrap should complete (even if with error status)
    assert.ok(bootstrap.completed, 'Bootstrap should complete');

    // Page should still be functional - no crash
    const pageInfo = await browser.execute(() => ({
      hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
      hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]'),
      hasErrors: window.__SERIALIZD_PLEX_ERROR__ || false
    }));

    assert.ok(pageInfo.hasTitle, 'Page should have title element');
    assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
  });

  it('does not inject broken link on malformed response', async function () {
    await browser.url(MALFORMED_URL);
    await waitForReadiness();
    await waitForBootstrap();

    // Wait a bit for any potential (broken) injection attempt
    await browser.pause(500);

    const link = await getInjectedLink();
    // Should NOT have a link since XML was malformed
    assert.equal(link, null, 'Should not inject link with malformed data');
  });

  it('can recover after navigating away from malformed page', async function () {
    // Start on malformed page
    await browser.url(MALFORMED_URL);
    await waitForReadiness();
    await waitForBootstrap();

    // Ensure no injection happened on malformed page
    await browser.pause(300);

    // Navigate to valid show page
    const validUrl = `${FIXTURE_SERVER}/web/show#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10001`;
    await browser.url(validUrl);
    await waitForReadiness();
    await waitForBootstrap();

    // Wait longer for extension to process and inject
    await browser.pause(1500);

    // Should be able to inject on valid page
    const link = await getInjectedLink();
    assert.ok(link, 'Should inject link on valid page after malformed page');
    assert.ok(link.href.includes('serializd.com'), 'Link should point to Serializd');
  });
});
