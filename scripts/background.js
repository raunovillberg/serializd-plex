// src/background.js
function redactSensitiveForLog(str) {
  if (typeof str !== "string") return str;
  return str.replace(/([?&]X-Plex-Token=)[^&\s]+/gi, "$1<redacted>").replace(/([?&]token=)[^&\s]+/gi, "$1<redacted>").replace(/("X-Plex-Token"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2").replace(/("token"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2");
}
function getSafeErrorMessage(error) {
  if (!error) return "Unknown error";
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
  return redactSensitiveForLog(message);
}
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.url.includes("/library/metadata/")) {
      return;
    }
    try {
      const urlObj = new URL(details.url);
      const serverUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ":" + urlObj.port : ""}`;
      const token = urlObj.searchParams.get("X-Plex-Token") || details.responseHeaders?.find((h) => h.name.toLowerCase() === "x-plex-token")?.value;
      let serverId = null;
      const serverMatch = details.url.match(/\/server\/([^\/]+)/);
      if (serverMatch) {
        serverId = serverMatch[1];
      } else if (urlObj.hostname.endsWith(".plex.direct")) {
        serverId = urlObj.hostname.split(".")[0];
      }
      if (details.tabId >= 0) {
        chrome.tabs.sendMessage(details.tabId, {
          action: "plexApiIntercepted",
          url: details.url,
          serverUrl,
          serverId,
          token
        }).catch(() => {
        });
      }
    } catch (e) {
      console.error("Serializd-Plex: Error parsing intercepted URL:", getSafeErrorMessage(e));
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchPlexMetadata") {
    fetchPlexMetadata(message.url, message.token).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.action === "fetchSerializdRating") {
    fetchSerializdRating(message.tmdbId).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});
async function fetchPlexMetadata(url, token) {
  try {
    const response = await fetch(url, {
      headers: {
        "X-Plex-Token": token
      }
    });
    if (!response.ok) {
      throw new Error(`Plex API error: ${response.status}`);
    }
    const text = await response.text();
    return { success: true, text, status: response.status };
  } catch (error) {
    console.error("Serializd-Plex: Error fetching from Plex API:", getSafeErrorMessage(error));
    throw error;
  }
}
async function fetchSerializdRating(tmdbId) {
  const url = `https://www.serializd.com/show/${tmdbId}`;
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: "Show not found on Serializd", url };
      }
      throw new Error(`Serializd HTTP error: ${response.status}`);
    }
    const html = await response.text();
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (!nextDataMatch) {
      return { success: false, error: "Could not parse Serializd data", url };
    }
    let nextData;
    try {
      nextData = JSON.parse(nextDataMatch[1]);
    } catch (parseError) {
      return { success: false, error: "Error parsing Serializd data", url };
    }
    const showDetails = nextData?.props?.pageProps?.data?.showDetails;
    const averageRating = nextData?.props?.pageProps?.data?.averageRating;
    const seasons = Array.isArray(showDetails?.seasons) ? showDetails.seasons : [];
    const seasonMap = {};
    for (const season of seasons) {
      if (Number.isInteger(season?.seasonNumber) && Number.isInteger(season?.id)) {
        seasonMap[season.seasonNumber] = season.id;
      }
    }
    if (typeof averageRating !== "number") {
      return {
        success: false,
        error: "No rating available",
        url,
        tmdbId,
        seasonMap
      };
    }
    const ratingOutOf5 = averageRating / 2;
    return {
      success: true,
      rating: ratingOutOf5,
      ratingOutOf10: averageRating,
      url,
      tmdbId,
      seasonMap
    };
  } catch (error) {
    console.error("Serializd-Plex: Error fetching Serializd rating:", getSafeErrorMessage(error));
    throw error;
  }
}
