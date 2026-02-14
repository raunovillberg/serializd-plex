/**
 * HTTP Status Error Spec
 *
 * Tests that the extension gracefully handles HTTP error responses.
 *
 * Expected behavior:
 * - HTTP 500: Graceful handling, no crash
 * - HTTP 401: Graceful handling, no crash
 * - Page remains functional
 * - No broken DOM state
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

const ERROR_500_URL = `${FIXTURE_SERVER}/web/error500#!/server/local/details?key=%2Flibrary%2Fmetadata%2F19902`;
const ERROR_401_URL = `${FIXTURE_SERVER}/web/error401#!/server/local/details?key=%2Flibrary%2Fmetadata%2F19903`;
const VALID_URL = `${FIXTURE_SERVER}/web/show#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10001`;

describe('HTTP Status Error Handling', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  afterEach(async function () {
    await assertNoUnmatchedRequests();
  });

  describe('HTTP 500 Internal Server Error', function () {
    it('does not crash on HTTP 500 response', async function () {
      await browser.url(ERROR_500_URL);
      await waitForReadiness();
      const bootstrap = await waitForBootstrap();

      // Bootstrap should complete (with error status)
      assert.equal(bootstrap.status, 500, 'Should receive 500 status');

      // Page should still be functional
      const pageInfo = await browser.execute(() => ({
        hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
        hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]')
      }));

      assert.ok(pageInfo.hasTitle, 'Page should have title element');
      assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
    });

    it('does not inject link on HTTP 500', async function () {
      await browser.url(ERROR_500_URL);
      await waitForReadiness();
      await waitForBootstrap();

      await browser.pause(500);
      const link = await getInjectedLink();
      assert.equal(link, null, 'Should not inject link with 500 error');
    });
  });

  describe('HTTP 401 Unauthorized', function () {
    it('does not crash on HTTP 401 response', async function () {
      await browser.url(ERROR_401_URL);
      await waitForReadiness();
      const bootstrap = await waitForBootstrap();

      assert.equal(bootstrap.status, 401, 'Should receive 401 status');

      const pageInfo = await browser.execute(() => ({
        hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
        hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]')
      }));

      assert.ok(pageInfo.hasTitle, 'Page should have title element');
      assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
    });

    it('does not inject link on HTTP 401', async function () {
      await browser.url(ERROR_401_URL);
      await waitForReadiness();
      await waitForBootstrap();

      await browser.pause(500);
      const link = await getInjectedLink();
      assert.equal(link, null, 'Should not inject link with 401 error');
    });
  });

  describe('Recovery after errors', function () {
    it('recovers after navigating from error page to valid page', async function () {
      // Start on 500 error page
      await browser.url(ERROR_500_URL);
      await waitForReadiness();
      await waitForBootstrap();

      await browser.pause(300);

      // Navigate to valid page
      await browser.url(VALID_URL);
      await waitForReadiness();
      await waitForBootstrap();

      // Wait for injection
      await browser.pause(1500);
      const link = await getInjectedLink();
      assert.ok(link, 'Should inject link on valid page after error page');
      assert.ok(link.href.includes('serializd.com'), 'Link should point to Serializd');
    });
  });
});
