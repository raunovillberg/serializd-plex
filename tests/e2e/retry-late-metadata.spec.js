/**
 * Late Metadata Retry Spec
 *
 * Tests that the extension correctly retries when metadata is initially unavailable.
 *
 * Contract:
 * - Initial response missing/insufficient data triggers retry
 * - Later response available
 * - Eventual injection within retry policy
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

const SHOW_URL = `${FIXTURE_SERVER}/web/show#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10001`;
const SEASON_URL = `${FIXTURE_SERVER}/web/season#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10002`;
const EPISODE_URL = `${FIXTURE_SERVER}/web/episode#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10003`;

describe('Late Metadata Retry', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  afterEach(async function () {
    await assertNoUnmatchedRequests();
  });

  describe('Retry behavior', function () {
    it('eventually injects link even with delayed data', async function () {
      // Navigate to show page
      await browser.url(SHOW_URL);

      // Wait for bootstrap to complete
      const bootstrap = await waitForBootstrap(10000);
      assert.equal(bootstrap.error, null, 'Bootstrap should complete without error');

      // Wait for injection with extended timeout
      const link = await waitForInjection(10000);

      assert.ok(link, 'Should eventually inject link');
      assert.ok(link.href.includes('serializd.com'), 'Link should point to Serializd');
    });

    it('waits for readiness marker before injection', async function () {
      await browser.url(SHOW_URL);

      // Readiness marker should be set
      const marker = await waitForReadiness();
      assert.ok(marker, 'Readiness marker should be present');
      assert.ok(marker.version, 'Marker should have version');
      assert.ok(marker.ts, 'Marker should have timestamp');
      assert.ok(marker.href, 'Marker should have href');

      // Then injection should happen
      const link = await waitForInjection();
      assert.ok(link, 'Link should be injected after readiness');
    });
  });

  describe('Extension resilience', function () {
    it('does not break page when metadata fetch takes time', async function () {
      await browser.url(SHOW_URL);
      await waitForReadiness();

      // Check page is still functional
      const pageInfo = await browser.execute(() => ({
        hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
        hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]'),
        hasErrors: window.__SERIALIZD_PLEX_ERROR__ || false
      }));

      assert.ok(pageInfo.hasTitle, 'Page should have title element');
      assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
      assert.ok(!pageInfo.hasErrors, 'Should not have extension errors');
    });

    it('handles multiple sequential page loads', async function () {
      // Load show page
      await browser.url(SHOW_URL);
      await waitForReadiness();
      await waitForBootstrap();
      let link = await waitForInjection();
      assert.ok(link, 'Should inject on show page');

      // Load season page
      await browser.url(SEASON_URL);
      await waitForReadiness();
      await waitForBootstrap();
      link = await waitForInjection();
      assert.ok(link, 'Should inject on season page');

      // Load episode page
      await browser.url(EPISODE_URL);
      await waitForReadiness();
      await waitForBootstrap();
      link = await waitForInjection();
      assert.ok(link, 'Should inject on episode page');
    });
  });
});
