// Serializd-Plex Background Script (Service Worker)
// Handles API calls and data fetching

console.log('Serializd-Plex: Background script loaded');

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
    } catch (e) {
      console.error('Serializd-Plex: Error parsing intercepted URL:', e);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Listen for content script requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    const response = await fetch(url, {
      headers: {
        'X-Plex-Token': token
      }
    });

    if (!response.ok) {
      throw new Error(`Plex API error: ${response.status}`);
    }

    const text = await response.text();
    return { success: true, text, status: response.status };
  } catch (error) {
    console.error('Serializd-Plex: Error fetching from Plex API:', error);
    throw error;
  }
}

/**
 * Fetch Serializd rating for a show
 * @param {number} tmdbId - TMDB ID of the show
 * @returns {Promise<Object>} Rating data with rating value and url
 */
async function fetchSerializdRating(tmdbId) {
  const url = `https://www.serializd.com/show/${tmdbId}`;

  try {
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

    const averageRating = nextData?.props?.pageProps?.data?.averageRating;

    if (typeof averageRating !== 'number') {
      return { success: false, error: 'No rating available', url };
    }

    const ratingOutOf5 = averageRating / 2;

    return {
      success: true,
      rating: ratingOutOf5,
      ratingOutOf10: averageRating,
      url,
      tmdbId
    };
  } catch (error) {
    console.error('Serializd-Plex: Error fetching Serializd rating:', error);
    throw error;
  }
}
