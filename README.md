# Serializd for Plex

Firefox extension that adds [Serializd](https://serializd.com) ratings to your Plex media library.

![Screenshot showing Serializd rating displayed on a Plex title page](screenshots/screenshot.png)

> Major inspiration by [Plexboxd](https://github.com/lennysgarage/Plexboxd/tree/firefox)!

## Installation

Since this extension isn't signed by Mozilla yet, you'll need to load it temporarily:

1. Firefox address bar: `about:debugging`
2. **"This Firefox"** in the left sidebar
3. **"Load Temporary Add-on..."** button
4. `manifest.json` file from this repository

The extension will remain active until you restart Firefox.

## Important Notes

- **Plex setup matters**: This extension depends on specific DOM structure in Plex. If your Plex server or client version differs significantly, the ratings may not appear. Works on my machine as of Plex version 4.147.1 & Firefox 147.0.2.
- **TMDb dependency**: The extension matches Plex titles to Serializd using TMDb IDs. If your Plex library doesn't have TMDb metadata, this won't work.

## Implementation Details
Under the hood:

**Web scraping**: This extension scrapes the Serializd website to fetch ratings. It does not use an official API. This means:
- It could break if Serializd changes their site layout
- It makes direct HTTP requests to serializd.com from your browser
- The scraping logic is... _imperfect_ (a clanker did it)

**How ratings appear**: The extension runs a content script on Plex pages, extracts the TMDb ID from the page metadata, queries Serializd's search endpoint, scrapes the rating from the search results, and injects it into the Plex UI next to other ratings.

**Caching**: Ratings are cached in browser storage to minimize requests to Serializd (TTL: 7 days).

## Privacy policy
- No personal data is collected or transmitted.
- Plex viewing data is processed, but only locally.
- Serializd.com is only queried for public ratings.
- All caching happens in your browser's local storage.
- No analytics, tracking, or third-party data sharing.
