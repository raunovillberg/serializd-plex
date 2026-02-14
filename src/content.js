// Serializd-Plex Content Script
// Extracts TV show information from Plex pages and displays Serializd links
// - webRequest API captures Plex API calls (including auth tokens)
// - Plex.tv API for server connection details
// - Background script fetching for Plex metadata (bypasses mixed content)
// - includeGuids=1 parameter to get external GUIDs

const CACHE_TTL = 604800; // 7 days in seconds
const SERVER_CACHE_TTL = 600; // 10 minutes in seconds for server info caching
const MAX_CACHE_ENTRIES = 50; // Maximum number of server entries to cache
const DEBUG_ID_EXTRACTION = __DEV__;
const DEBUG_NAVIGATION = __DEV__;
const DEBUG_LOG_RELAY = __DEV_RELAY__;
const TEST_HOOKS_ENABLED = __TEST_HOOKS__;
const RETRY_DELAYS_MS = [350, 900, 1800]; // Retry window for timing-sensitive UI/data availability

function redactSensitiveForLog(str) {
  if (typeof str !== 'string') return str;

  return str
    .replace(/([?&]X-Plex-Token=)[^&\s]+/gi, '$1<redacted>')
    .replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>')
    .replace(/("X-Plex-Token"\s*:\s*")[^"]+(")/gi, '$1<redacted>$2')
    .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1<redacted>$2');
}

function getSafeErrorMessage(error) {
  if (!error) return 'Unknown error';

  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error);

  return redactSensitiveForLog(message);
}

let lastProcessedKey = null;
let lastObservedHref = window.location.href;
let lastKnownPlexToken = null;
let latestProcessRunId = 0;
const inFlightPageKeys = new Set();
let retryState = {
  href: null,
  attempts: 0,
  timeoutId: null
};

async function init() {
  await cleanExpiredServerCache();

  DEV_DEBUG: logNavigationDebug('init', {
    href: window.location.href,
    readyState: document.readyState
  });

  processTVShowPage('init');

  const observer = new MutationObserver(debounce((mutations) => {
    const currentHref = window.location.href;
    const hrefChanged = currentHref !== lastObservedHref;

    DEV_DEBUG: logNavigationDebug('mutation-observer', {
      href: currentHref,
      hrefChanged,
      previousHref: lastObservedHref,
      mutationCount: mutations?.length || 0
    });

    if (hrefChanged) {
      lastObservedHref = currentHref;
      // URL changed in Plex SPA; ensure we re-process even if title/year key collides.
      lastProcessedKey = null;
      clearRetryState('mutation-url-change');
      // Update readiness marker on SPA navigation
      setReadinessMarker();
    }

    processTVShowPage(hrefChanged ? 'mutation-url-change' : 'mutation-dom-change');
  }, 500));

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  window.addEventListener('hashchange', () => {
    const currentHref = window.location.href;
    DEV_DEBUG: logNavigationDebug('hashchange', {
      href: currentHref,
      previousHref: lastObservedHref
    });

    lastObservedHref = currentHref;
    lastProcessedKey = null;
    clearRetryState('hashchange');
    setReadinessMarker();
    processTVShowPage('hashchange');
  });

  window.addEventListener('popstate', () => {
    const currentHref = window.location.href;
    DEV_DEBUG: logNavigationDebug('popstate', {
      href: currentHref,
      previousHref: lastObservedHref
    });

    lastObservedHref = currentHref;
    lastProcessedKey = null;
    clearRetryState('popstate');
    setReadinessMarker();
    processTVShowPage('popstate');
  });

  // Set initial readiness marker for E2E tests
  setReadinessMarker();
}

async function processTVShowPage(trigger = 'unknown') {
  const title = extractTitle();
  const year = extractYear();
  const plexKey = getPlexMetadataKey();

  DEV_DEBUG: logNavigationDebug('process-start', {
    trigger,
    href: window.location.href,
    title,
    year,
    hasPlexKey: !!plexKey
  });

  // Some Plex season/episode pages don't expose a year in metadata-line1.
  // In that case we still continue if we have a Plex metadata key.
  if (!title || (!year && !plexKey)) {
    DEV_DEBUG: logNavigationDebug('process-skip-missing-metadata', {
      trigger,
      href: window.location.href,
      title,
      year,
      hasPlexKey: !!plexKey
    });

    if (title || plexKey) {
      schedulePageRetry('missing-metadata');
    }

    return;
  }

  const normalizedYear = year || 'unknown';
  const pageKey = getPageContextKey(title, normalizedYear, plexKey);

  // Skip if already processed this exact page context
  if (pageKey === lastProcessedKey) {
    DEV_DEBUG: logNavigationDebug('process-skip-same-page-key', {
      trigger,
      href: window.location.href,
      pageKey
    });
    return;
  }

  if (inFlightPageKeys.has(pageKey)) {
    DEV_DEBUG: logNavigationDebug('process-skip-in-flight', {
      trigger,
      href: window.location.href,
      pageKey
    });
    return;
  }

  const runId = ++latestProcessRunId;
  const runHref = window.location.href;
  const isStaleRun = () => runId !== latestProcessRunId || window.location.href !== runHref;

  inFlightPageKeys.add(pageKey);

  // Clean previous injected UI before re-rendering
  document.querySelectorAll('.serializd-link-wrapper').forEach((el) => el.remove());
  document.querySelectorAll('.serializd-fallback-container').forEach((el) => el.remove());

  try {
    let showTmdbId = null;
    let seasonTmdbId = null;
    let seasonNum = null;
    let episodeNum = null;

    if (plexKey) {
      const plexData = await fetchTMDBIdFromPlex(plexKey);
      if (plexData) {
        showTmdbId = plexData.showTmdbId;
        seasonTmdbId = plexData.seasonTmdbId;
        seasonNum = plexData.seasonNum;
        episodeNum = plexData.episodeNum;
      }
    }

    if (isStaleRun()) {
      DEV_DEBUG: logNavigationDebug('process-abort-stale-run', {
        reason: 'after-plex-fetch',
        trigger,
        runHref,
        currentHref: window.location.href,
        pageKey
      });
      return;
    }

    // If Plex metadata doesn't provide season/episode context, infer from visible UI text.
    // Gate this to likely season/episode pages to avoid forcing season links on show pages.
    const shouldInferFromDom =
      (seasonNum === null && year === null) ||
      (episodeNum === null && isLikelyEpisodePage());

    if (shouldInferFromDom) {
      const domContext = extractSeasonEpisodeContextFromDom();
      if (seasonNum === null && domContext.seasonNum !== null) {
        seasonNum = domContext.seasonNum;
      }
      if (episodeNum === null && domContext.episodeNum !== null) {
        episodeNum = domContext.episodeNum;
      }

      if (domContext.seasonNum !== null || domContext.episodeNum !== null) {
        DEV_DEBUG: logNavigationDebug('season-episode-context-inferred-from-dom', {
          href: window.location.href,
          seasonNum,
          episodeNum,
          sourceText: domContext.sourceText
        });
      }
    }

    const cached = await getCachedRating(title, normalizedYear);

    const hasSeasonEpisodeContext =
      seasonNum !== null ||
      episodeNum !== null ||
      seasonTmdbId !== null;

    // Avoid using cached show IDs for season/episode contexts; stale cache can poison deep links.
    if (!showTmdbId && cached?.tmdbId && !hasSeasonEpisodeContext) {
      showTmdbId = cached.tmdbId;
    }

    if (!showTmdbId) {
      DEV_DEBUG: logNavigationDebug('process-skip-no-show-tmdb', {
        trigger,
        href: window.location.href,
        title,
        year: normalizedYear,
        plexKey,
        hasInterceptedServer: !!interceptedPlexServer,
        hasKnownToken: !!lastKnownPlexToken
      });

      schedulePageRetry('no-show-tmdb');
      return;
    }

    if (isStaleRun()) {
      DEV_DEBUG: logNavigationDebug('process-abort-stale-run', {
        reason: 'after-show-id-resolution',
        trigger,
        runHref,
        currentHref: window.location.href,
        pageKey
      });
      return;
    }

    let cachedSeasonMapHit = false;
    let fetchedSeasonMapHit = false;

    if (
      !seasonTmdbId &&
      seasonNum !== null &&
      cached?.seasonMap?.[seasonNum] &&
      (!cached?.tmdbId || !showTmdbId || cached.tmdbId === showTmdbId)
    ) {
      seasonTmdbId = cached.seasonMap[seasonNum];
      cachedSeasonMapHit = true;
    }

    let url = buildSerializdUrl(showTmdbId, seasonTmdbId, seasonNum, episodeNum);

    const hasSeasonContext = seasonNum !== null;
    const canUseCachedSeasonUrl = !hasSeasonContext || !!seasonTmdbId;
    const cachedMatchesResolvedShow = !cached?.tmdbId || cached.tmdbId === showTmdbId;

    if (cached && cached.rating && !isExpired(cached, CACHE_TTL) && canUseCachedSeasonUrl && cachedMatchesResolvedShow) {
      DEV_DEBUG: logIdExtractionDebug('cache-hit', {
        title,
        year: normalizedYear,
        plexKey,
        showTmdbId,
        seasonTmdbId,
        seasonNum,
        episodeNum,
        url,
        cachedSeasonMapHit,
        fetchedSeasonMapHit
      });

      if (isStaleRun()) {
        DEV_DEBUG: logNavigationDebug('process-abort-stale-run', {
          reason: 'before-cache-hit-inject',
          trigger,
          runHref,
          currentHref: window.location.href,
          pageKey
        });
        return;
      }

      const injected = injectSerializdLink({
        url,
        tmdbId: showTmdbId,
        rating: cached.rating,
        isEpisode: hasSeasonContext
      });
      if (injected) {
        lastProcessedKey = pageKey;
        clearRetryState('inject-success-cache-hit');
      } else {
        schedulePageRetry('inject-failed-cache-hit');
      }
      return;
    }

    const ratingData = await fetchSerializdRating(showTmdbId);

    if (isStaleRun()) {
      DEV_DEBUG: logNavigationDebug('process-abort-stale-run', {
        reason: 'after-serializd-fetch',
        trigger,
        runHref,
        currentHref: window.location.href,
        pageKey
      });
      return;
    }

    if (!seasonTmdbId && seasonNum !== null && ratingData?.seasonMap?.[seasonNum]) {
      seasonTmdbId = ratingData.seasonMap[seasonNum];
      fetchedSeasonMapHit = true;
      url = buildSerializdUrl(showTmdbId, seasonTmdbId, seasonNum, episodeNum);
    }

    const cacheKey = getCacheKey(title, normalizedYear);

    if (ratingData && ratingData.rating) {
      await cacheRating(cacheKey, {
        tmdbId: showTmdbId,
        url,
        rating: ratingData.rating,
        seasonMap: ratingData.seasonMap,
        timestamp: Math.floor(Date.now() / 1000)
      });

      DEV_DEBUG: logIdExtractionDebug('fresh-fetch-with-rating', {
        title,
        year: normalizedYear,
        plexKey,
        showTmdbId,
        seasonTmdbId,
        seasonNum,
        episodeNum,
        url,
        cachedSeasonMapHit,
        fetchedSeasonMapHit
      });

      if (isStaleRun()) {
        DEV_DEBUG: logNavigationDebug('process-abort-stale-run', {
          reason: 'before-fresh-with-rating-inject',
          trigger,
          runHref,
          currentHref: window.location.href,
          pageKey
        });
        return;
      }

      const injected = injectSerializdLink({
        url,
        tmdbId: showTmdbId,
        rating: ratingData.rating,
        isEpisode: hasSeasonContext
      });
      if (injected) {
        lastProcessedKey = pageKey;
        clearRetryState('inject-success-fresh-with-rating');
      } else {
        schedulePageRetry('inject-failed-fresh-with-rating');
      }
    } else {
      await cacheRating(cacheKey, {
        tmdbId: showTmdbId,
        url,
        seasonMap: ratingData?.seasonMap,
        timestamp: Math.floor(Date.now() / 1000)
      });

      DEV_DEBUG: logIdExtractionDebug('fresh-fetch-no-rating', {
        title,
        year: normalizedYear,
        plexKey,
        showTmdbId,
        seasonTmdbId,
        seasonNum,
        episodeNum,
        url,
        cachedSeasonMapHit,
        fetchedSeasonMapHit
      });

      if (isStaleRun()) {
        DEV_DEBUG: logNavigationDebug('process-abort-stale-run', {
          reason: 'before-fresh-no-rating-inject',
          trigger,
          runHref,
          currentHref: window.location.href,
          pageKey
        });
        return;
      }

      const injected = injectSerializdLink({ url, tmdbId: showTmdbId, isEpisode: hasSeasonContext });
      if (injected) {
        lastProcessedKey = pageKey;
        clearRetryState('inject-success-fresh-no-rating');
      } else {
        schedulePageRetry('inject-failed-fresh-no-rating');
      }
    }

  } catch (error) {
    console.error('Serializd-Plex: Error processing page:', getSafeErrorMessage(error));
    DEV_RELAY: relayDebugLog('error', 'processTVShowPage', {
      message: error?.message || String(error),
      stack: error?.stack || null
    });
    schedulePageRetry('process-error');
  } finally {
    inFlightPageKeys.delete(pageKey);
  }
}

function relayDebugLog(channel, event, data = {}) {
  DEV_RELAY: {
    if (!DEBUG_LOG_RELAY) return;

    try {
      chrome.runtime.sendMessage({
        action: 'relayDebugLog',
        channel,
        event,
        data: {
          ...data,
          href: window.location.href,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      // Best-effort only
    }
  }
}

function logNavigationDebug(stage, data = {}) {
  DEV_DEBUG: {
    if (!DEBUG_NAVIGATION) return;

    const payload = {
      ...data,
      timestamp: new Date().toISOString()
    };

    console.log(`Serializd-Plex [NavDebug] ${stage}`, payload);
    relayDebugLog('nav', stage, payload);
  }
}

function logIdExtractionDebug(stage, data) {
  DEV_DEBUG: {
    if (!DEBUG_ID_EXTRACTION) return;

    const isEpisodeLike = data.seasonNum !== null || data.episodeNum !== null;
    const prefix = isEpisodeLike ? 'Serializd-Plex [EpisodeDebug]' : 'Serializd-Plex [ShowDebug]';

    console.groupCollapsed(`${prefix} ${stage}`);
    console.log('title/year:', `${data.title} (${data.year})`);
    console.log('plexKey:', data.plexKey || '(none)');
    console.log('showTmdbId:', data.showTmdbId);
    console.log('seasonTmdbId:', data.seasonTmdbId);
    console.log('seasonNum:', data.seasonNum);
    console.log('episodeNum:', data.episodeNum);
    console.log('resolvedUrl:', data.url);
    console.log('cachedSeasonMapHit:', data.cachedSeasonMapHit);
    console.log('fetchedSeasonMapHit:', data.fetchedSeasonMapHit);
    console.groupEnd();

    relayDebugLog('id-extraction', stage, {
      isEpisodeLike,
      ...data
    });
  }
}

function clearRetryState(reason = 'unspecified') {
  if (retryState.timeoutId) {
    clearTimeout(retryState.timeoutId);
  }

  if (retryState.href || retryState.attempts > 0) {
    DEV_DEBUG: logNavigationDebug('retry-cleared', {
      reason,
      href: retryState.href,
      attempts: retryState.attempts
    });
  }

  retryState = {
    href: null,
    attempts: 0,
    timeoutId: null
  };
}

function schedulePageRetry(reason) {
  const href = window.location.href;

  if (retryState.href !== href) {
    clearRetryState('href-changed');
    retryState.href = href;
  }

  if (retryState.timeoutId) {
    return;
  }

  if (retryState.attempts >= RETRY_DELAYS_MS.length) {
    DEV_DEBUG: logNavigationDebug('retry-exhausted', {
      reason,
      href,
      attempts: retryState.attempts
    });
    return;
  }

  const delay = RETRY_DELAYS_MS[retryState.attempts];
  retryState.attempts += 1;

  DEV_DEBUG: logNavigationDebug('retry-scheduled', {
    reason,
    href,
    attempt: retryState.attempts,
    delay
  });

  retryState.timeoutId = setTimeout(() => {
    retryState.timeoutId = null;

    if (window.location.href !== href) {
      clearRetryState('href-changed-before-retry-fired');
      return;
    }

    processTVShowPage(`retry:${reason}:${retryState.attempts}`);
  }, delay);
}

let interceptedPlexServer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'plexApiIntercepted') {
    const validatedToken = message.token && isValidPlexToken(message.token) ? message.token : null;
    if (validatedToken) {
      lastKnownPlexToken = validatedToken;
    }

    // Keep latest metadata request URL even when server URL itself is not usable.
    // Fallback key extraction may depend on this when the route lacks key= in location.
    if (message.url) {
      window.__LAST_PLEX_API_URL__ = message.url;
    }

    const isUsableServer = message.serverUrl && isValidPlexServerUrl(message.serverUrl);

    if (isUsableServer) {
      interceptedPlexServer = {
        url: message.serverUrl,
        token: validatedToken,
        serverId: message.serverId || null
      };
    } else {
      DEV_DEBUG: logNavigationDebug('ignored-intercepted-server-url', {
        url: message.url,
        serverUrl: message.serverUrl || null,
        hasToken: !!validatedToken
      });
    }
  }
  return false;
});

function getServerCacheKey(serverId) {
  return `serializd_plex_server_${serverId}`;
}

function getServerIdFromLocation() {
  const match = window.location.href.match(/\/server\/([^\/\?&]+)/);
  return match ? match[1] : null;
}

function getCurrentTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function isExpired(entry, ttl) {
  if (!entry?.timestamp) return true;
  return getCurrentTimestamp() - entry.timestamp > ttl;
}

function isValidServerCacheEntry(entry) {
  return !!(
    entry &&
    typeof entry === 'object' &&
    entry.address &&
    entry.port &&
    entry.scheme
  );
}

function pruneCacheEntries(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return 0;

  entries.sort(([, a], [, b]) => (a.timestamp || 0) - (b.timestamp || 0));

  const toRemove = entries.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    delete cache[entries[i][0]];
  }

  return toRemove;
}

async function getCachedServerInfo(serverId) {
  try {
    const result = await chrome.storage.local.get('cached_servers');
    const cache = result.cached_servers || {};
    const key = getServerCacheKey(serverId);
    const entry = cache[key];

    if (entry) {
      if (isExpired(entry, SERVER_CACHE_TTL)) {
        const newCache = { ...cache };
        delete newCache[key];
        await chrome.storage.local.set({ cached_servers: newCache });
        return null;
      }

      if (!isValidServerCacheEntry(entry)) {
        const newCache = { ...cache };
        delete newCache[key];
        await chrome.storage.local.set({ cached_servers: newCache });
        return null;
      }

      return entry;
    }

    return null;
  } catch (error) {
    return null;
  }
}

async function cacheServerInfo(serverId, serverInfo) {
  try {
    if (!serverInfo.address || !serverInfo.port || !serverInfo.scheme) {
      return false;
    }

    const result = await chrome.storage.local.get('cached_servers');
    const cache = result.cached_servers || {};
    const key = getServerCacheKey(serverId);

    pruneCacheEntries(cache);

    cache[key] = {
      address: serverInfo.address,
      port: serverInfo.port,
      scheme: serverInfo.scheme,
      localAddresses: serverInfo.localAddresses,
      timestamp: getCurrentTimestamp(),
      serverName: serverInfo.serverName || null
    };

    await chrome.storage.local.set({ cached_servers: cache });
    return true;
  } catch (error) {
    return false;
  }
}

function getPlexMetadataKey() {
  const extractMetadataKeyFromUrl = (url) => {
    if (!url || typeof url !== 'string') return null;

    const urlPatterns = [
      [/key=%2F(library%2Fmetadata%2F[\w.-]+)/i, true],
      [/key=(\/library\/metadata%2F[\w.-]+)/i, false],
      [/key=(\/library\/metadata\/[\w.-]+)/i, false],
      [/\/(library\/metadata\/[\w.-]+)/i, true]
    ];

    for (const [pattern, needsDecode] of urlPatterns) {
      const match = url.match(pattern);
      if (match) {
        if (needsDecode) {
          const decoded = decodeURIComponent(match[1]);
          return decoded.startsWith('/') ? decoded : '/' + decoded;
        }

        return match[1];
      }
    }

    return null;
  };

  // Prefer the current URL key over intercepted request key.
  // Intercepted key can be stale from a previous route.
  const urlKey = extractMetadataKeyFromUrl(window.location.href);
  const interceptedKey = extractMetadataKeyFromUrl(window.__LAST_PLEX_API_URL__);

  if (urlKey && interceptedKey && urlKey !== interceptedKey) {
    DEV_DEBUG: logNavigationDebug('plex-key-conflict-using-url-key', {
      href: window.location.href,
      urlKey,
      interceptedKey,
      lastInterceptedUrl: window.__LAST_PLEX_API_URL__
    });
  }

  if (urlKey) {
    return urlKey;
  }

  if (interceptedKey) {
    return interceptedKey;
  }

  return null;
}

/**
 * Build a safe Plex API URL from components
 * @param {string} scheme - URL scheme (http/https)
 * @param {string} address - Server address (IP or hostname)
 * @param {string|number} port - Server port
 * @param {string} plexKey - Plex metadata key (e.g., "/library/metadata/12345")
 * @returns {string|null} Constructed URL or null if invalid
 */
function buildPlexApiUrl(scheme, address, port, plexKey) {
  try {
    // Validate scheme
    if (!['http', 'https'].includes(scheme)) {
      return null;
    }

    // Validate port is numeric
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return null;
    }

    // Validate address doesn't contain path separators or query strings
    if (address.includes('/') || address.includes('?') || address.includes('#')) {
      return null;
    }

    // Build URL safely using URL API
    const baseUrl = `${scheme}://${address}:${portNum}`;
    const url = new URL(plexKey, baseUrl);

    // Add query parameters safely
    url.searchParams.set('includeGuids', '1');
    url.searchParams.set('includeExternalMedia', '1');

    return url.toString();
  } catch (e) {
    return null;
  }
}

function buildPlexApiUrlFromExisting(apiUrl, plexKey) {
  try {
    const url = new URL(apiUrl);
    url.pathname = plexKey;
    url.searchParams.set('includeGuids', '1');
    url.searchParams.set('includeExternalMedia', '1');
    return url.toString();
  } catch (e) {
    return null;
  }
}

function extractRelatedPlexKeys(xmlText) {
  const keys = [];

  const grandparentMatch = xmlText.match(/grandparentRatingKey=["'](\d+)["']/);
  if (grandparentMatch) {
    keys.push(`/library/metadata/${grandparentMatch[1]}`);
  }

  const parentMatch = xmlText.match(/parentRatingKey=["'](\d+)["']/);
  if (parentMatch) {
    const parentKey = `/library/metadata/${parentMatch[1]}`;
    if (!keys.includes(parentKey)) {
      keys.push(parentKey);
    }
  }

  return keys;
}

async function fetchPlexMetadataViaBackground(url, token) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'fetchPlexMetadata', url, token },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      }
    );
  });
}

async function fetchTMDBIdFromPlex(plexKey) {
  const locationServerId = getServerIdFromLocation();

  const url = interceptedPlexServer?.url || (locationServerId ? `https://plex.tv/api/servers/${locationServerId}` : null);
  const token = interceptedPlexServer?.token || lastKnownPlexToken;
  const serverId = interceptedPlexServer?.serverId || locationServerId || null;

  if (!url || !token) {
    DEV_DEBUG: logNavigationDebug('plex-fetch-missing-server-context', {
      href: window.location.href,
      plexKey,
      hasInterceptedServer: !!interceptedPlexServer,
      hasUrl: !!url,
      hasToken: !!token,
      locationServerId
    });
    return null;
  }

  let apiUrl;
  const isPlexTvServerApi = /^https:\/\/plex\.tv\/api\/servers\//i.test(url);

  DEV_DEBUG: logNavigationDebug('plex-fetch-context', {
    plexKey,
    serverId,
    baseUrl: url,
    isPlexTvServerApi
  });

  if (serverId && isPlexTvServerApi) {
    const cachedServerInfo = await getCachedServerInfo(serverId);

    if (cachedServerInfo) {
      const { address, port, scheme } = cachedServerInfo;
      apiUrl = buildPlexApiUrl(scheme, address, port, plexKey);
    } else {
      try {
        const connectionsResponse = await fetch(url, {
          headers: {
            'X-Plex-Token': token
          }
        });

        if (!connectionsResponse.ok) {
          return null;
        }

        const connectionsText = await connectionsResponse.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(connectionsText, 'text/xml');

        let connection = xmlDoc.querySelector('Connection');
        if (!connection) {
          connection = xmlDoc.querySelector('Server');
        }

        if (connection) {
          let serverAddress = connection.getAttribute('address');
          let serverPort = connection.getAttribute('port');
          const scheme = connection.getAttribute('scheme') || connection.getAttribute('protocol') || 'http';
          const localAddresses = connection.getAttribute('localAddresses');
          const serverName = connection.getAttribute('name') || connection.getAttribute('serverName') || null;

          if (!serverAddress && localAddresses) {
            serverAddress = localAddresses;
          }

          if (serverPort === '0' || !serverPort) {
            serverPort = '32400';
          }

          if (serverAddress && serverPort && scheme) {
            await cacheServerInfo(serverId, {
              address: serverAddress,
              port: serverPort,
              scheme: scheme,
              localAddresses: localAddresses,
              serverName: serverName
            });

            apiUrl = buildPlexApiUrl(scheme, serverAddress, serverPort, plexKey);
          } else {
            return null;
          }
        } else {
          return null;
        }
      } catch (error) {
        return null;
      }
    }
  } else {
    // For direct Plex server URLs, append plexKey to base URL.
    // Also used when falling back to location-derived server context.
    try {
      const baseUrl = new URL(url);
      const finalUrl = new URL(plexKey, baseUrl);
      finalUrl.searchParams.set('includeGuids', '1');
      finalUrl.searchParams.set('includeExternalMedia', '1');
      apiUrl = finalUrl.toString();

      DEV_DEBUG: logNavigationDebug('plex-direct-api-url-built', {
        plexKey,
        baseUrl: url,
        apiUrl
      });
    } catch (e) {
      apiUrl = null;
    }
  }

  if (!apiUrl) {
    DEV_DEBUG: logNavigationDebug('plex-fetch-no-api-url', {
      plexKey,
      baseUrl: url,
      serverId,
      isPlexTvServerApi
    });
    return null;
  }

  try {
    const response = await fetchPlexMetadataViaBackground(apiUrl, token);

    if (!response.success) {
      DEV_DEBUG: logNavigationDebug('plex-fetch-unsuccessful-response', {
        apiUrl,
        plexKey,
        status: response?.status ?? null
      });
      return null;
    }

    const primaryData = extractTMDBIdFromPlexXml(response.text);
    if (primaryData?.showTmdbId) {
      return primaryData;
    }

    const relatedKeys = extractRelatedPlexKeys(response.text);
    if (!relatedKeys.length) {
      DEV_DEBUG: logNavigationDebug('plex-no-related-keys-for-fallback', {
        plexKey,
        apiUrl,
        hadPrimaryData: !!primaryData
      });
      return primaryData;
    }

    DEV_DEBUG: logNavigationDebug('plex-fallback-related-keys', {
      href: window.location.href,
      sourcePlexKey: plexKey,
      relatedKeys
    });

    for (const relatedKey of relatedKeys) {
      const relatedApiUrl = buildPlexApiUrlFromExisting(apiUrl, relatedKey);
      if (!relatedApiUrl) continue;

      try {
        const relatedResponse = await fetchPlexMetadataViaBackground(relatedApiUrl, token);
        if (!relatedResponse.success) continue;

        const relatedData = extractTMDBIdFromPlexXml(relatedResponse.text);
        if (relatedData?.showTmdbId) {
          return {
            showTmdbId: relatedData.showTmdbId,
            seasonTmdbId: primaryData?.seasonTmdbId ?? relatedData.seasonTmdbId ?? null,
            seasonNum: primaryData?.seasonNum ?? relatedData.seasonNum ?? null,
            episodeNum: primaryData?.episodeNum ?? relatedData.episodeNum ?? null
          };
        }
      } catch (relatedError) {
        console.warn('Serializd-Plex: Related metadata fallback failed:', getSafeErrorMessage(relatedError));
      }
    }

    DEV_DEBUG: logNavigationDebug('plex-related-fallback-exhausted', {
      plexKey,
      relatedKeys,
      apiUrl,
      hadPrimaryData: !!primaryData
    });

    return primaryData;
  } catch (error) {
    console.error('Serializd-Plex: Error fetching from Plex API:', getSafeErrorMessage(error));
    DEV_RELAY: relayDebugLog('error', 'fetchTMDBIdFromPlex', {
      plexKey,
      message: error?.message || String(error),
      stack: error?.stack || null
    });
  }

  return null;
}

/**
 * Extract TMDB IDs and season/episode context from Plex metadata XML.
 * - showTmdbId: TMDB show ID used in Serializd show URLs
 * - seasonTmdbId: TMDB season ID used in Serializd season URLs
 * - seasonNum/episodeNum: numeric season + episode numbers from Plex
 * @param {string} xmlText - Plex API response XML
 * @returns {{showTmdbId:number|null, seasonTmdbId:number|null, seasonNum:number|null, episodeNum:number|null}|null}
 */
function extractTMDBIdFromPlexXml(xmlText) {
  const getIntAttr = (name) => {
    const match = xmlText.match(new RegExp(`${name}=["'](\\d+)["']`));
    return match ? parseInt(match[1], 10) : null;
  };

  const getStringAttr = (name) => {
    const match = xmlText.match(new RegExp(`${name}=["']([^"']+)["']`));
    return match ? match[1] : null;
  };

  const parseTmdbId = (guidValue) => {
    if (!guidValue || typeof guidValue !== 'string') return null;
    const match = guidValue.match(/tmdb:\/\/(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const typeMatch = xmlText.match(/type=["'](movie|show|season|episode)["']/);
  const contentType = typeMatch ? typeMatch[1] : null;

  if (contentType === 'movie') {
    return null;
  }

  const ownGuidAttr = getStringAttr('guid');
  const parentGuidAttr = getStringAttr('parentGuid');
  const grandparentGuidAttr = getStringAttr('grandparentGuid');

  const guidElementMatch = xmlText.match(/<Guid[^>]*id=["']tmdb:\/\/(\d+)["']/i);
  const ownGuidElementTmdbId = guidElementMatch ? parseInt(guidElementMatch[1], 10) : null;

  let showTmdbId = null;
  let seasonTmdbId = null;
  let seasonNum = null;
  let episodeNum = null;

  if (contentType === 'show') {
    showTmdbId = ownGuidElementTmdbId || parseTmdbId(ownGuidAttr);
  } else if (contentType === 'season') {
    seasonNum = getIntAttr('index');
    seasonTmdbId = ownGuidElementTmdbId || parseTmdbId(ownGuidAttr);
    showTmdbId = parseTmdbId(parentGuidAttr);
  } else if (contentType === 'episode') {
    seasonNum = getIntAttr('parentIndex');
    episodeNum = getIntAttr('index');

    showTmdbId = parseTmdbId(grandparentGuidAttr);
    seasonTmdbId = parseTmdbId(parentGuidAttr);
  }

  // Fallbacks for show-level items only.
  // For season/episode items, own tmdb GUID may be season/episode-level and not the show ID.
  if (!showTmdbId && (contentType === 'show' || !contentType)) {
    showTmdbId = ownGuidElementTmdbId || parseTmdbId(ownGuidAttr);
  }

  if (!showTmdbId && (contentType === 'show' || !contentType)) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
      const guidElements = xmlDoc.querySelectorAll('Guid');

      for (const guidEl of guidElements) {
        const guidId = guidEl.getAttribute('id');
        const tmdbId = parseTmdbId(guidId);
        if (tmdbId) {
          showTmdbId = tmdbId;
          break;
        }
      }
    } catch (xmlError) {
      // Ignore XML parsing errors
    }
  }

  const hasContext =
    seasonTmdbId !== null ||
    seasonNum !== null ||
    episodeNum !== null;

  if (!showTmdbId && !hasContext) {
    return null;
  }

  return { showTmdbId, seasonTmdbId, seasonNum, episodeNum };
}

function extractTitle() {
  const titleElement = document.querySelector('[data-testid="metadata-title"]');
  if (!titleElement) return null;

  let title = titleElement.textContent.trim();
  title = title.replace(/\s*\(\d{4}\)\s*$/, '');

  return title;
}

function extractYear() {
  const line1Element = document.querySelector('[data-testid="metadata-line1"]');
  if (!line1Element) return null;

  const yearMatch = line1Element.textContent.match(/(\d{4})/);
  return yearMatch ? yearMatch[1] : null;
}

function isLikelyEpisodePage() {
  const text = [
    document.querySelector('[data-testid="metadata-line1"]')?.textContent || '',
    document.querySelector('[data-testid="metadata-line2"]')?.textContent || '',
    document.querySelector('[data-testid="metadata-title"]')?.textContent || ''
  ].join(' ');

  return /\bEpisode\b/i.test(text) || /\bE\d{1,2}\b/i.test(text);
}

function extractSeasonEpisodeContextFromDom() {
  const titleEl = document.querySelector('[data-testid="metadata-title"]');
  const titleParentText = titleEl?.parentElement?.textContent || '';

  const lineCandidates = [
    document.querySelector('[data-testid="metadata-line1"]')?.textContent || '',
    document.querySelector('[data-testid="metadata-line2"]')?.textContent || '',
    titleEl?.textContent || '',
    titleParentText
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  // Heuristic: include body lines that explicitly mention season/episode markers.
  const bodyLines = (document.body?.innerText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /\bSeason\s+\d+\b|\bEpisode\s+\d+\b|\bS\s*\d+\s*[·•:\-\s]*E\s*\d+\b/i.test(s))
    .slice(0, 6);

  const sourceText = [...lineCandidates, ...bodyLines].join(' • ');

  let seasonNum = null;
  let episodeNum = null;

  // Patterns like "S1 E2", "S01E02", "S1 · E1"
  const compactMatch = sourceText.match(/\bS\s*0?(\d{1,2})\s*[·•:\-\s]*E\s*0?(\d{1,3})\b/i);
  if (compactMatch) {
    seasonNum = parseInt(compactMatch[1], 10);
    episodeNum = parseInt(compactMatch[2], 10);
    return { seasonNum, episodeNum, sourceText: sourceText.slice(0, 400) };
  }

  const seasonMatch =
    sourceText.match(/\bSeason\s+(\d{1,2})\b/i) ||
    sourceText.match(/\bS\s*0?(\d{1,2})\b/i);

  const episodeMatch =
    sourceText.match(/\bEpisode\s+(\d{1,3})\b/i) ||
    sourceText.match(/\bE\s*0?(\d{1,3})\b/i);

  if (seasonMatch) {
    seasonNum = parseInt(seasonMatch[1], 10);
  }

  if (episodeMatch) {
    episodeNum = parseInt(episodeMatch[1], 10);
  }

  return { seasonNum, episodeNum, sourceText: sourceText.slice(0, 400) };
}

function getCacheKey(title, year) {
  return `${title}-${year}`;
}

function getPageContextKey(title, year, plexKey) {
  if (plexKey) {
    return `plex:${plexKey}`;
  }
  return getCacheKey(title, year);
}

function buildSerializdUrl(showTmdbId, seasonTmdbId, seasonNum, episodeNum) {
  let url = `https://www.serializd.com/show/${showTmdbId}`;

  if (seasonNum === null || seasonTmdbId === null) {
    return url;
  }

  url += `/season/${seasonTmdbId}/${seasonNum}`;

  if (episodeNum !== null) {
    url += `/episode/${episodeNum}`;
  }

  return url;
}

async function cacheRating(key, data) {
  try {
    const result = await chrome.storage.local.get('cached_shows');
    const cache = result.cached_shows || {};
    cache[key] = {
      ...data,
      timestamp: Math.floor(Date.now() / 1000)
    };
    await chrome.storage.local.set({ cached_shows: cache });
  } catch (error) {
    console.error('Serializd-Plex: Cache write error:', getSafeErrorMessage(error));
  }
}

async function getCachedRating(title, year) {
  try {
    const result = await chrome.storage.local.get('cached_shows');
    const cache = result.cached_shows || {};
    const key = getCacheKey(title, year);
    const entry = cache[key];

    if (entry && !isExpired(entry, CACHE_TTL)) {
      return entry;
    }
    return null;
  } catch (error) {
    console.error('Serializd-Plex: Cache read error:', getSafeErrorMessage(error));
    return null;
  }
}

async function fetchSerializdRating(tmdbId) {
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'fetchSerializdRating', tmdbId },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        }
      );
    });

    // Return response even when success=false because it may still include seasonMap.
    if (response && typeof response === 'object') {
      return response;
    }

    return null;
  } catch (error) {
    console.error('Serializd-Plex: Error fetching rating:', getSafeErrorMessage(error));
    return null;
  }
}

function findSeasonEpisodeInlineAnchor() {
  const titleElement = document.querySelector('[data-testid="metadata-title"]');
  if (!titleElement) return null;

  const contextRoot = titleElement.parentElement?.parentElement || titleElement.parentElement;
  if (!contextRoot) return null;

  const likelyLines = [
    contextRoot.querySelector('[data-testid="metadata-line1"]'),
    contextRoot.querySelector('[data-testid="metadata-line2"]'),
    ...contextRoot.querySelectorAll('h1, h2, h3')
  ].filter(Boolean);

  for (const el of likelyLines) {
    const text = (el.textContent || '').trim();
    if (/\bSeason\s+\d+\b/i.test(text) || /\bSeason\s+\d+\s+Episode\s+\d+\b/i.test(text) || /\bS\s*\d+\s*[·•:\-\s]*E\s*\d+\b/i.test(text)) {
      return el;
    }
  }

  return null;
}

function injectSerializdLink(data) {
  let injectionTarget = document.querySelector('[data-testid="metadata-ratings"]');
  let injectionMode = 'metadata-ratings';
  let inlineAnchor = null;

  if (!injectionTarget && data?.isEpisode) {
    inlineAnchor = findSeasonEpisodeInlineAnchor();
    if (inlineAnchor) {
      injectionMode = 'season-episode-inline';
    }
  }

  if (!injectionTarget && !inlineAnchor) {
    const titleElement = document.querySelector('[data-testid="metadata-title"]');
    if (titleElement) {
      const fallbackContainer = document.createElement('div');
      fallbackContainer.classList.add('serializd-fallback-container');
      titleElement.insertAdjacentElement('afterend', fallbackContainer);
      injectionTarget = fallbackContainer;
      injectionMode = 'title-fallback';
    }
  }

  if (!injectionTarget && !inlineAnchor) {
    DEV_DEBUG: logNavigationDebug('inject-skip-no-suitable-container', {
      href: window.location.href,
      attemptedUrl: data?.url || null,
      isEpisode: !!data?.isEpisode
    });
    return false;
  }

  const linkWrapper = document.createElement('a');
  linkWrapper.href = data.url;
  linkWrapper.target = '_blank';
  linkWrapper.rel = 'noopener noreferrer';
  linkWrapper.classList.add('serializd-link-wrapper');

  if (inlineAnchor) {
    linkWrapper.classList.add('serializd-inline-wrapper');
  }

  const container = document.createElement('div');
  container.classList.add('serializd-rating-container');
  if (data.isEpisode) {
    container.classList.add('serializd-episode');
    container.title = 'View season/episode on Serializd';
  }

  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('icons/plex-icon-16.png');
  logo.setAttribute('width', '16px');
  logo.setAttribute('height', '16px');
  logo.classList.add('serializd-logo');

  container.appendChild(logo);

  if (data.rating) {
    const ratingSpan = document.createElement('span');
    ratingSpan.classList.add('serializd-rating');
    ratingSpan.textContent = data.rating.toFixed(2);
    container.appendChild(ratingSpan);
  }

  linkWrapper.appendChild(container);

  if (inlineAnchor) {
    inlineAnchor.appendChild(linkWrapper);
  } else {
    injectionTarget.appendChild(linkWrapper);
  }

  DEV_DEBUG: logNavigationDebug('inject-success', {
    href: window.location.href,
    injectedUrl: data.url,
    isEpisode: !!data.isEpisode,
    hasRating: typeof data.rating === 'number',
    injectionMode
  });

  return true;
}

function isValidPlexServerUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    if (hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    if (hostname === 'discover.provider.plex.tv' || hostname === 'metadata.provider.plex.tv') {
      return false;
    }

    if (hostname.endsWith('.plex.tv') || hostname === 'plex.tv') {
      return true;
    }

    if (hostname.endsWith('.plex.direct')) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

function isValidPlexToken(token) {
  if (!token || typeof token !== 'string') return false;
  return token.length >= 10 && token.length <= 500 && /^\S+$/.test(token);
}

async function cleanExpiredServerCache() {
  try {
    const result = await chrome.storage.local.get('cached_servers');
    const cache = result.cached_servers || {};
    let cleanedCount = 0;

    for (const [key, entry] of Object.entries(cache)) {
      if (isExpired(entry, SERVER_CACHE_TTL)) {
        delete cache[key];
        cleanedCount++;
      }
    }

    pruneCacheEntries(cache);

    if (cleanedCount > 0) {
      await chrome.storage.local.set({ cached_servers: cache });
    }

    return { cleanedCount };
  } catch (error) {
    return { cleanedCount: 0 };
  }
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function getExtensionVersionForMarker() {
  try {
    return globalThis?.chrome?.runtime?.getManifest?.()?.version || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

/**
 * Set the readiness marker for E2E tests.
 * Only active when TEST_HOOKS_ENABLED is true (dev/test builds with --test-hooks flag).
 * Marker format: { version, ts, href }
 */
function setReadinessMarker() {
  TEST_HOOKS: {
    if (!TEST_HOOKS_ENABLED) return;

    const marker = {
      version: getExtensionVersionForMarker(),
      ts: Date.now(),
      href: window.location.href
    };

    // Content-script realm marker (useful in extension context)
    window.__SERIALIZD_PLEX_READY__ = marker;

    // Page-visible marker for WebDriver assertions (Firefox content script runs in isolated realm)
    document.documentElement.setAttribute('data-serializd-plex-ready', JSON.stringify(marker));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
