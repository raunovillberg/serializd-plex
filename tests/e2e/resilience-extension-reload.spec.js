/**
 * Extension Reload Resilience Spec
 *
 * Tests that the extension recovers correctly after being reloaded.
 *
 * Expected behavior:
 * - After reload, readiness marker reappears within timeout
 * - Page remains functional
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetMetrics,
  waitForReadiness,
  FIXTURE_SERVER
} from './helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const addonPath = path.join(rootDir, '.tmp', 'e2e', 'serializd-plex-test.xpi');

const SHOW_URL = `${FIXTURE_SERVER}/web/show#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10001`;

async function reloadExtension() {
  const addonBase64 = fs.readFileSync(addonPath).toString('base64');
  await browser.installAddOn(addonBase64, true);
  await browser.pause(500);
}

describe('Extension Reload Resilience', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  it('readiness marker reappears after extension reload', async function () {
    this.timeout(20000);

    // Navigate to page and verify initial state
    await browser.url(SHOW_URL);
    const beforeReloadMarker = await waitForReadiness();

    // Verify page is functional before reload
    const pageInfoBefore = await browser.execute(() => ({
      hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
      hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]')
    }));
    assert.ok(pageInfoBefore.hasTitle, 'Page should have title before reload');

    // Reload extension
    await reloadExtension();

    // Readiness marker should be freshly re-emitted after reload
    const marker = await waitForReadiness({
      timeoutMs: 15000,
      afterTs: beforeReloadMarker.ts,
      expectedHrefIncludes: '/web/show'
    });

    assert.ok(marker, 'Readiness marker should reappear after reload');
    assert.ok(marker.version, 'Marker should have version');
    assert.ok(marker.ts, 'Marker should have timestamp');
    assert.ok(marker.href, 'Marker should have href');
  });

  it('page remains functional after extension reload', async function () {
    this.timeout(20000);

    await browser.url(SHOW_URL);
    const beforeReloadMarker = await waitForReadiness();

    // Reload extension
    await reloadExtension();

    // Wait for fresh readiness after reload
    await waitForReadiness({
      timeoutMs: 15000,
      afterTs: beforeReloadMarker.ts,
      expectedHrefIncludes: '/web/show'
    });

    // Page should still be functional
    const pageInfo = await browser.execute(() => ({
      hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
      hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]'),
      hasErrors: window.__SERIALIZD_PLEX_ERROR__ || false
    }));

    assert.ok(pageInfo.hasTitle, 'Page should have title after reload');
    assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
    assert.ok(!pageInfo.hasErrors, 'Should not have extension errors');
  });

  it('extension handles page refresh correctly', async function () {
    this.timeout(15000);

    // Load page
    await browser.url(SHOW_URL);
    const beforeRefreshMarker = await waitForReadiness();

    // Refresh page
    await browser.refresh();

    // Should work normally after refresh with a fresh marker
    const marker = await waitForReadiness({
      timeoutMs: 10000,
      afterTs: beforeRefreshMarker.ts,
      expectedHrefIncludes: '/web/show'
    });
    assert.ok(marker, 'Readiness marker should appear after refresh');

    const pageInfo = await browser.execute(() => ({
      hasTitle: !!document.querySelector('[data-testid="metadata-title"]'),
      hasRatings: !!document.querySelector('[data-testid="metadata-ratings"]')
    }));

    assert.ok(pageInfo.hasTitle, 'Page should have title after refresh');
    assert.ok(pageInfo.hasRatings, 'Page should have ratings container');
  });
});
