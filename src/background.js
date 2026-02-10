// Serializd-Plex Background Script (Service Worker)
// Handles API calls and data fetching

const DEV_LOG_RELAY_ENABLED = __DEV_RELAY__;

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

DEV_DEBUG: console.log('Serializd-Plex: Background script loaded');

let relayDevLog = () => {};

DEV_RELAY: {
  const DEV_LOG_RELAY_URL = 'http://127.0.0.1:8765/log';

  function redactSensitiveString(str) {
    if (typeof str !== 'string') return str;

    return str
      .replace(/([?&]X-Plex-Token=)[^&\s]+/gi, '$1<redacted>')
      .replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>')
      .replace(/("X-Plex-Token"\s*:\s*")[^"]+(")/gi, '$1<redacted>$2')
      .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1<redacted>$2');
  }

  function redactSensitiveData(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      return redactSensitiveString(value);
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redactSensitiveData(item, seen));
    }

    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/token/i.test(key)) {
        out[key] = val ? '<redacted>' : val;
      } else {
        out[key] = redactSensitiveData(val, seen);
      }
    }

    return out;
  }

  relayDevLog = async function relayDevLogImpl(entry) {
    if (!DEV_LOG_RELAY_ENABLED) return;

    const payload = redactSensitiveData({
      ...entry,
      timestamp: new Date().toISOString()
    });

    try {
      // text/plain avoids preflight for most cases
      await fetch(DEV_LOG_RELAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8'
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      // Keep silent to avoid noisy console loops
    }
  };
}

// Intercept Plex API responses to extract server URLs
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.url.includes('/library/metadata/')) {
      return;
    }

    try {
      const urlObj = new URL(details.url);
      const serverUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
      const token = urlObj.searchParams.get('X-Plex-Token') ||
                   details.responseHeaders?.find(h => h.name.toLowerCase() === 'x-plex-token')?.value;

      // Extract server ID from URL path (e.g., /server/<id>/... or from plex.direct subdomain)
      let serverId = null;
      const serverMatch = details.url.match(/\/server\/([^\/]+)/);
      if (serverMatch) {
        serverId = serverMatch[1];
      } else if (urlObj.hostname.endsWith('.plex.direct')) {
        // plex.direct format: <serverId>.<hash>.plex.direct
        serverId = urlObj.hostname.split('.')[0];
      }

      if (details.tabId >= 0) {
        chrome.tabs.sendMessage(details.tabId, {
          action: 'plexApiIntercepted',
          url: details.url,
          serverUrl: serverUrl,
          serverId: serverId,
          token: token
        }).catch(() => {
          // Tab might be closed or not have content script loaded
        });
      }

      DEV_RELAY: {
        relayDevLog({
          source: 'background',
          channel: 'intercept',
          event: 'plexApiIntercepted',
          data: {
            url: details.url,
            serverUrl,
            serverId,
            hasToken: !!token,
            tabId: details.tabId
          }
        });
      }
    } catch (e) {
      console.error('Serializd-Plex: Error parsing intercepted URL:', getSafeErrorMessage(e));
      DEV_RELAY: {
        relayDevLog({
          source: 'background',
          channel: 'error',
          event: 'intercept-parse-error',
          data: { message: e?.message || String(e), url: details.url }
        });
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Listen for content script requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  DEV_RELAY: {
    if (__DEV_RELAY__ && message.action === 'relayDebugLog') {
      relayDevLog({
        source: 'content',
        tabId: sender?.tab?.id ?? null,
        channel: message.channel,
        event: message.event,
        data: message.data
      });

      sendResponse({ ok: true });
      return false;
    }
  }

  if (message.action === 'fetchPlexMetadata') {
    fetchPlexMetadata(message.url, message.token)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === 'fetchSerializdRating') {
    fetchSerializdRating(message.tmdbId)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

/**
 * Fetch Plex metadata from server
 * @param {string} url - Plex API URL
 * @param {string} token - Plex token
 * @returns {Promise<Object>} Response with text and status
 */
async function fetchPlexMetadata(url, token) {
  try {
    DEV_RELAY: {
      relayDevLog({
        source: 'background',
        channel: 'plex',
        event: 'fetchPlexMetadata:start',
        data: { url, hasToken: !!token }
      });
    }

    const response = await fetch(url, {
      headers: {
        'X-Plex-Token': token
      }
    });

    if (!response.ok) {
      throw new Error(`Plex API error: ${response.status}`);
    }

    const text = await response.text();

    DEV_RELAY: {
      relayDevLog({
        source: 'background',
        channel: 'plex',
        event: 'fetchPlexMetadata:success',
        data: {
          url,
          status: response.status,
          payloadLength: text.length
        }
      });
    }

    return { success: true, text, status: response.status };
  } catch (error) {
    console.error('Serializd-Plex: Error fetching from Plex API:', getSafeErrorMessage(error));

    DEV_RELAY: {
      relayDevLog({
        source: 'background',
        channel: 'plex',
        event: 'fetchPlexMetadata:error',
        data: {
          url,
          message: error?.message || String(error)
        }
      });
    }

    throw error;
  }
}

/**
 * Fetch Serializd show page data.
 * Includes:
 * - show rating
 * - season number -> season TMDB ID mapping (for season/episode URLs)
 * @param {number} tmdbId - TMDB ID of the show
 * @returns {Promise<Object>} Rating + season map data
 */
async function fetchSerializdRating(tmdbId) {
  const url = `https://www.serializd.com/show/${tmdbId}`;

  try {
    DEV_RELAY: {
      relayDevLog({
        source: 'background',
        channel: 'serializd',
        event: 'fetchSerializdRating:start',
        data: { tmdbId, url }
      });
    }

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: 'Show not found on Serializd', url };
      }
      throw new Error(`Serializd HTTP error: ${response.status}`);
    }

    const html = await response.text();

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (!nextDataMatch) {
      return { success: false, error: 'Could not parse Serializd data', url };
    }

    let nextData;
    try {
      nextData = JSON.parse(nextDataMatch[1]);
    } catch (parseError) {
      return { success: false, error: 'Error parsing Serializd data', url };
    }

    const showDetails = nextData?.props?.pageProps?.data?.showDetails;
    const averageRating = nextData?.props?.pageProps?.data?.averageRating;
    const seasons = Array.isArray(showDetails?.seasons) ? showDetails.seasons : [];

    const seasonMap = {};
    for (const season of seasons) {
      if (
        Number.isInteger(season?.seasonNumber) &&
        Number.isInteger(season?.id)
      ) {
        seasonMap[season.seasonNumber] = season.id;
      }
    }

    if (typeof averageRating !== 'number') {
      DEV_RELAY: {
        relayDevLog({
          source: 'background',
          channel: 'serializd',
          event: 'fetchSerializdRating:no-rating',
          data: { tmdbId, url, seasonCount: Object.keys(seasonMap).length }
        });
      }

      return {
        success: false,
        error: 'No rating available',
        url,
        tmdbId,
        seasonMap
      };
    }

    const ratingOutOf5 = averageRating / 2;

    DEV_RELAY: {
      relayDevLog({
        source: 'background',
        channel: 'serializd',
        event: 'fetchSerializdRating:success',
        data: {
          tmdbId,
          url,
          ratingOutOf5,
          seasonCount: Object.keys(seasonMap).length
        }
      });
    }

    return {
      success: true,
      rating: ratingOutOf5,
      ratingOutOf10: averageRating,
      url,
      tmdbId,
      seasonMap
    };
  } catch (error) {
    console.error('Serializd-Plex: Error fetching Serializd rating:', getSafeErrorMessage(error));

    DEV_RELAY: {
      relayDevLog({
        source: 'background',
        channel: 'serializd',
        event: 'fetchSerializdRating:error',
        data: { tmdbId, url, message: error?.message || String(error) }
      });
    }

    throw error;
  }
}
