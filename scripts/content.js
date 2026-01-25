// Serializd-Plex Content Script
// Extracts TV show information from Plex pages and displays Serializd links
// - webRequest API captures Plex API calls (including auth tokens)
// - Plex.tv API for server connection details
// - Background script fetching for Plex metadata (bypasses mixed content)
// - includeGuids=1 parameter to get external GUIDs

const CACHE_TTL = 604800; // 7 days in seconds
const SERVER_CACHE_TTL = 600; // 10 minutes in seconds for server info caching
const MAX_CACHE_ENTRIES = 50; // Maximum number of server entries to cache

let lastProcessedKey = null;

async function init() {
  await cleanExpiredServerCache();
  processTVShowPage();

  const observer = new MutationObserver(debounce(() => {
    processTVShowPage();
  }, 500));

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

async function processTVShowPage() {
  const title = extractTitle();
  const year = extractYear();

  if (!title || !year) {
    return;
  }

  const pageKey = getCacheKey(title, year);

  // Skip if already processed this exact show
  if (pageKey === lastProcessedKey) {
    return;
  }
  lastProcessedKey = pageKey;

  const existingContainer = document.querySelector('.serializd-rating-container');
  if (existingContainer) {
    existingContainer.remove();
  }

  try {
    const plexKey = getPlexMetadataKey();
    let tmdbId = null;

    if (plexKey) {
      const plexTmdbId = await fetchTMDBIdFromPlex(plexKey);
      if (plexTmdbId) {
        tmdbId = plexTmdbId;
      }
    }

    if (!tmdbId) {
      const cached = await getCachedRating(title, year);
      if (cached && cached.tmdbId) {
        tmdbId = cached.tmdbId;
      }
    }

    if (!tmdbId) {
      return;
    }

    const url = `https://www.serializd.com/show/${tmdbId}`;

    const cached = await getCachedRating(title, year);
    if (cached && cached.rating && !isExpired(cached, CACHE_TTL)) {
      injectSerializdLink({ url, tmdbId, rating: cached.rating });
      return;
    }

    const ratingData = await fetchSerializdRating(tmdbId);

    if (ratingData && ratingData.rating) {
      const cacheKey = getCacheKey(title, year);
      await cacheRating(cacheKey, {
        tmdbId,
        url,
        rating: ratingData.rating,
        timestamp: Math.floor(Date.now() / 1000)
      });

      injectSerializdLink({ url, tmdbId, rating: ratingData.rating });
    } else {
      const cacheKey = getCacheKey(title, year);
      await cacheRating(cacheKey, {
        tmdbId,
        url,
        timestamp: Math.floor(Date.now() / 1000)
      });

      injectSerializdLink({ url, tmdbId });
    }

  } catch (error) {
    console.error('Serializd-Plex: Error processing page:', error);
  }
}

let interceptedPlexServer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'plexApiIntercepted') {
    window.__LAST_PLEX_API_URL__ = message.url;

    if (message.serverUrl && isValidPlexServerUrl(message.serverUrl)) {
      const validatedToken = message.token && isValidPlexToken(message.token) ? message.token : null;

      interceptedPlexServer = {
        url: message.serverUrl,
        token: validatedToken
      };
    }
  }
  return false;
});

function getServerCacheKey(serverId) {
  return `serializd_plex_server_${serverId}`;
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
  if (window.__LAST_PLEX_API_URL__) {
    const match = window.__LAST_PLEX_API_URL__.match(/\/library\/metadata\/([a-f0-9]+)/);
    if (match) {
      return `/library/metadata/${match[1]}`;
    }
  }

  const urlPatterns = [
    [/key=%2F(library%2Fmetadata%2F[a-f0-9]+)/, true],
    [/key=(\/library\/metadata%2F[a-f0-9]+)/, false],
    [/key=(\/library\/metadata\/[a-f0-9]+)/, false],
    [/\/library\/metadata\/([a-f0-9]+)/, true]
  ];

  for (const [pattern, needsDecode] of urlPatterns) {
    const match = window.location.href.match(pattern);
    if (match) {
      if (needsDecode) {
        const decoded = decodeURIComponent(match[1]);
        return decoded.startsWith('/') ? decoded : '/' + decoded;
      } else {
        return match[1];
      }
    }
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

async function fetchTMDBIdFromPlex(plexKey) {
  if (!interceptedPlexServer) {
    return null;
  }

  const { url, token, serverId } = interceptedPlexServer;
  let apiUrl;

  if (serverId) {
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
    // For direct server URLs, append plexKey to base URL
    try {
      const baseUrl = new URL(url);
      const finalUrl = new URL(plexKey, baseUrl);
      finalUrl.searchParams.set('includeGuids', '1');
      finalUrl.searchParams.set('includeExternalMedia', '1');
      apiUrl = finalUrl.toString();
    } catch (e) {
      apiUrl = null;
    }
  }

  if (!apiUrl) {
    return null;
  }

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'fetchPlexMetadata', url: apiUrl, token },
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

    if (!response.success) {
      return null;
    }

    return extractTMDBIdFromPlexXml(response.text);
  } catch (error) {
    console.error('Serializd-Plex: Error fetching from Plex API:', error);
  }

  return null;
}

/**
 * Extract TMDB ID from Plex metadata XML
 * @param {string} xmlText - Plex API response XML
 * @returns {number|null} TMDB ID or null
 */
function extractTMDBIdFromPlexXml(xmlText) {
  // Skip movies - Serializd only supports TV shows
  const typeMatch = xmlText.match(/type=["'](movie|show)["']/);
  if (typeMatch && typeMatch[1] === 'movie') {
    return null;
  }

  // Method 1: Look for <Guid id="tmdb://..."> child elements (most reliable)
  const guidElementMatch = xmlText.match(/<Guid[^>]*id=["']tmdb:\/\/([a-f0-9]+)["']/i);
  if (guidElementMatch) {
    return parseInt(guidElementMatch[1]);
  }

  // Method 2: Look for guid="..." attribute on Video element
  const guidMatch = xmlText.match(/guid=["']([^"']+)["']/);
  if (guidMatch) {
    const tmdbMatch = guidMatch[1].match(/tmdb:\/\/([a-f0-9]+)/);
    if (tmdbMatch) {
      return parseInt(tmdbMatch[1]);
    }
  }

  // Method 3: Parse XML and search all Guid elements
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    const guidElements = xmlDoc.querySelectorAll('Guid');

    for (const guidEl of guidElements) {
      const guidId = guidEl.getAttribute('id');
      if (!guidId) continue;

      const tmdbMatch = guidId.match(/tmdb:\/\/([a-f0-9]+)/i);
      if (tmdbMatch) {
        return parseInt(tmdbMatch[1]);
      }
    }
  } catch (xmlError) {
    // Ignore XML parsing errors
  }

  return null;
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

function getCacheKey(title, year) {
  return `${title}-${year}`;
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
    console.error('Serializd-Plex: Cache write error:', error);
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
    console.error('Serializd-Plex: Cache read error:', error);
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

    if (response.success) {
      return response;
    }
    return null;
  } catch (error) {
    console.error('Serializd-Plex: Error fetching rating:', error);
    return null;
  }
}

function injectSerializdLink(data) {
  const ratingsContainer = document.querySelector('[data-testid="metadata-ratings"]');
  if (!ratingsContainer) {
    return;
  }

  const linkWrapper = document.createElement('a');
  linkWrapper.href = data.url;
  linkWrapper.target = '_blank';
  linkWrapper.rel = 'noopener noreferrer';

  const container = document.createElement('div');
  container.classList.add('serializd-rating-container');

  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('icons/icon-16.png');
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
  ratingsContainer.appendChild(linkWrapper);
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
