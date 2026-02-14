/**
 * Show Injection Spec
 *
 * Tests that the extension correctly injects Serializd links on show pages.
 *
 * Contract (from plan §3.2):
 * - Wrapper appears in ratings container
 * - URL format: https://www.serializd.com/show/<id>
 */

import assert from 'node:assert/strict';
import {
  resetMetrics,
  getMetrics,
  waitForReadiness,
  waitForBootstrap,
  waitForInjection,
  getInjectedLink,
  assertNoUnmatchedRequests,
  assertOfflineGuard,
  FIXTURE_SERVER
} from './helpers.mjs';

const SHOW_URL = `${FIXTURE_SERVER}/web/show#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10001`;

describe('Show Injection', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  afterEach(async function () {
    await assertNoUnmatchedRequests();
    await assertOfflineGuard();
  });

  it('injects Serializd link on show page', async function () {
    // Navigate to show fixture - use same URL format as smoke test
    await browser.url(SHOW_URL);

    // Wait for readiness marker
    await waitForReadiness();

    // Wait for bootstrap metadata request
    const bootstrap = await waitForBootstrap();
    assert.equal(bootstrap.error, null, 'Bootstrap request should not error');
    assert.equal(bootstrap.status, 200, 'Bootstrap request should return 200');

    // Wait for injection
    const link = await waitForInjection(10000);

    assert.ok(link, 'Serializd link should be injected');
    assert.ok(link.exists, 'Link wrapper should exist');
    assert.ok(link.href.includes('serializd.com/show/'), 'Link should point to Serializd show URL');

    // Verify URL format: https://www.serializd.com/show/<tmdbId>
    const urlMatch = link.href.match(/serializd\.com\/show\/(\d+)/);
    assert.ok(urlMatch, 'Link should have TMDB ID in URL');
  });

  it('injects link into ratings container', async function () {
    await browser.url(SHOW_URL);
    await waitForReadiness();
    await waitForBootstrap();
    await waitForInjection();

    // Check injection target is correct
    const injectionInfo = await browser.execute(() => {
      const ratingsContainer = document.querySelector('[data-testid="metadata-ratings"]');
      const linkWrapper = document.querySelector('.serializd-link-wrapper');

      return {
        hasRatingsContainer: !!ratingsContainer,
        linkInRatingsContainer: ratingsContainer?.contains(linkWrapper),
        linkParentClass: linkWrapper?.parentElement?.className || null
      };
    });

    assert.ok(injectionInfo.hasRatingsContainer, 'Page should have ratings container');
    assert.ok(injectionInfo.linkInRatingsContainer, 'Link should be inside ratings container');
  });

  it('includes Serializd logo in injected link', async function () {
    await browser.url(SHOW_URL);
    await waitForReadiness();
    await waitForBootstrap();
    await waitForInjection();

    const logoInfo = await browser.execute(() => {
      const container = document.querySelector('.serializd-rating-container');
      const logo = container?.querySelector('.serializd-logo');

      return {
        hasContainer: !!container,
        hasLogo: !!logo,
        logoSrc: logo?.src || null
      };
    });

    assert.ok(logoInfo.hasContainer, 'Should have rating container');
    assert.ok(logoInfo.hasLogo, 'Should have logo');
    assert.ok(logoInfo.logoSrc?.includes('icon-16.png'), 'Logo should be 16px icon');
  });
});
