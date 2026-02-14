/**
 * Season/Episode URL Spec
 *
 * Tests that the extension constructs correct Serializd URLs for season and episode pages.
 *
 * Expected URL formats:
 * - Show: https://www.serializd.com/show/<showTmdbId>
 * - Season: https://www.serializd.com/show/<showTmdbId>/season/<seasonTmdbId>/<seasonNum>
 * - Episode: https://www.serializd.com/show/<showTmdbId>/season/<seasonTmdbId>/<seasonNum>/episode/<episodeNum>
 */

import assert from 'node:assert/strict';
import {
  resetMetrics,
  waitForReadiness,
  waitForBootstrap,
  waitForInjection,
  assertNoUnmatchedRequests,
  FIXTURE_SERVER
} from './helpers.mjs';

const SEASON_URL = `${FIXTURE_SERVER}/web/season#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10002`;
const EPISODE_URL = `${FIXTURE_SERVER}/web/episode#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10003`;
const SHOW_URL = `${FIXTURE_SERVER}/web/show#!/server/local/details?key=%2Flibrary%2Fmetadata%2F10001`;

describe('Season/Episode URL Construction', function () {
  beforeEach(async function () {
    await resetMetrics();
  });

  afterEach(async function () {
    await assertNoUnmatchedRequests();
  });

  describe('Season page', function () {
    it('injects link with season deep link', async function () {
      await browser.url(SEASON_URL);
      await waitForReadiness();
      await waitForBootstrap();
      const link = await waitForInjection();

      assert.ok(link, 'Serializd link should be injected on season page');
      assert.ok(link.isEpisode, 'Link should be marked as episode/season type');

      // URL should contain /season/<tmdbId>/<seasonNum>
      const seasonMatch = link.href.match(/\/season\/(\d+)\/(\d+)/);
      assert.ok(seasonMatch, 'URL should contain season path with TMDB ID and season number');
    });

    it('season URL includes show ID', async function () {
      await browser.url(SEASON_URL);
      await waitForReadiness();
      await waitForBootstrap();
      const link = await waitForInjection();

      // Should have both show and season in URL
      const showMatch = link.href.match(/serializd\.com\/show\/(\d+)/);
      const seasonMatch = link.href.match(/\/season\/(\d+)\/(\d+)/);

      assert.ok(showMatch, 'URL should contain show ID');
      assert.ok(seasonMatch, 'URL should contain season ID and number');
    });
  });

  describe('Episode page', function () {
    it('injects link with episode deep link', async function () {
      await browser.url(EPISODE_URL);
      await waitForReadiness();
      await waitForBootstrap();
      const link = await waitForInjection();

      assert.ok(link, 'Serializd link should be injected on episode page');
      assert.ok(link.isEpisode, 'Link should be marked as episode type');

      // URL should contain /episode/<episodeNum>
      const episodeMatch = link.href.match(/\/episode\/(\d+)/);
      assert.ok(episodeMatch, 'URL should contain episode number');
    });

    it('episode URL includes season and show', async function () {
      await browser.url(EPISODE_URL);
      await waitForReadiness();
      await waitForBootstrap();
      const link = await waitForInjection();

      // Full URL format: /show/<id>/season/<id>/<num>/episode/<num>
      const showMatch = link.href.match(/serializd\.com\/show\/(\d+)/);
      const seasonMatch = link.href.match(/\/season\/(\d+)\/(\d+)/);
      const episodeMatch = link.href.match(/\/episode\/(\d+)/);

      assert.ok(showMatch, 'URL should contain show ID');
      assert.ok(seasonMatch, 'URL should contain season ID and number');
      assert.ok(episodeMatch, 'URL should contain episode number');
    });

    it('URL components are in correct order', async function () {
      await browser.url(EPISODE_URL);
      await waitForReadiness();
      await waitForBootstrap();
      const link = await waitForInjection();

      // Verify order: show -> season -> episode
      const showIndex = link.href.indexOf('/show/');
      const seasonIndex = link.href.indexOf('/season/');
      const episodeIndex = link.href.indexOf('/episode/');

      assert.ok(showIndex < seasonIndex, 'Show should come before season in URL');
      assert.ok(seasonIndex < episodeIndex, 'Season should come before episode in URL');
    });
  });

  describe('URL format validation', function () {
    it('uses https protocol', async function () {
      await browser.url(SHOW_URL);
      await waitForReadiness();
      await waitForBootstrap();
      const link = await waitForInjection();

      assert.ok(link.href.startsWith('https://'), 'URL should use HTTPS');
      assert.ok(link.href.includes('www.serializd.com'), 'URL should point to serializd.com');
    });

    it('opens in new tab', async function () {
      await browser.url(SHOW_URL);
      await waitForReadiness();
      await waitForBootstrap();
      await waitForInjection();

      const targetAttr = await browser.execute(() => {
        const wrapper = document.querySelector('.serializd-link-wrapper');
        return {
          target: wrapper?.target,
          rel: wrapper?.rel
        };
      });

      assert.equal(targetAttr.target, '_blank', 'Link should open in new tab');
      assert.ok(targetAttr.rel?.includes('noopener'), 'Link should have noopener');
      assert.ok(targetAttr.rel?.includes('noreferrer'), 'Link should have noreferrer');
    });
  });
});
