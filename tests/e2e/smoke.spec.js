/**
 * Phase A Smoke Test
 *
 * Baseline test to verify the E2E testing infrastructure works:
 * - Fixture server starts and serves content
 * - Firefox loads extension
 * - Extension sets readiness marker
 * - No unmatched requests
 */

import assert from 'node:assert/strict';
import {
  resetMetrics,
  getMetrics,
  waitForReadiness,
  waitForBootstrap,
  navigateToFixture,
  assertNoUnmatchedRequests
} from './helpers.mjs';

describe('Phase A smoke', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  it('loads extension on localhost fixture and sets readiness marker', async function () {
    // Health check
    const metrics = await getMetrics();

    // Navigate to test fixture
    await navigateToFixture('/web/test#!/server/local/details?key=%2Flibrary%2Fmetadata%2F99999');

    // Wait for readiness marker
    const marker = await waitForReadiness();
    assert.ok(marker?.href.includes('/web/test'), 'Marker href should include test path');

    // Wait for bootstrap metadata request
    const bootstrap = await waitForBootstrap();
    assert.equal(bootstrap.error, null, 'Bootstrap should not error');
    assert.equal(bootstrap.status, 200, 'Bootstrap should return 200');

    // Verify no unmatched requests
    await assertNoUnmatchedRequests();

    // Verify metadata request was made
    const finalMetrics = await getMetrics();
    const hasMetadataRequest = finalMetrics.requests.some(req =>
      req.path.startsWith('/library/metadata/')
    );
    assert.equal(hasMetadataRequest, true, 'Should have metadata request to fixture server');
  });
});
