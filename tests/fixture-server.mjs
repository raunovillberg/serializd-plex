#!/usr/bin/env node

/**
 * Fixture Replay Server
 *
 * Serves sanitized Plex fixtures for E2E testing.
 * Loads fixtures from tests/fixtures/plex/ directory.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const fixturesDir = path.join(rootDir, 'tests/fixtures/plex');

const PORT = Number(process.env.FIXTURE_SERVER_PORT || 32400);
const HOST = process.env.FIXTURE_SERVER_HOST || '127.0.0.1';
const FIXTURE_TOKEN = 'FIXTURE-TOKEN-PLACEHOLDER';

// Latency profiles (ms)
const LATENCY_PROFILE = process.env.FIXTURE_LATENCY || 'fast';
const LATENCY_CONFIGS = {
  fast: { min: 1, max: 5 },
  normal: { min: 50, max: 150 },
  slow: { min: 500, max: 500 }  // Fixed 500ms as per plan
};

// Loaded fixture data
let routesConfig = null;
let pagesConfig = null;

const metrics = {
  requests: [],
  unmatchedRequests: [],
  deniedRequests: [],
  startTime: Date.now()
};

const DENIED_ROUTES = [/\/:\/transcode\//i, /\/:\/timeline\//i];
const ALLOWED_ROUTES = [
  /^\/web\//i,
  /^\/library\/metadata\//i,
  /^\/health$/i,
  /^\/__metrics$/i,
  /^\/__metrics\/reset$/i,
  /^\/favicon\.ico$/i
];

function loadFixtures() {
  // Load routes.json
  const routesPath = path.join(fixturesDir, 'routes.json');
  if (fs.existsSync(routesPath)) {
    routesConfig = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  } else {
    routesConfig = {};
  }

  // Load pages.json
  const pagesPath = path.join(fixturesDir, 'pages.json');
  if (fs.existsSync(pagesPath)) {
    pagesConfig = JSON.parse(fs.readFileSync(pagesPath, 'utf8'));
  } else {
    pagesConfig = {};
  }
}

function recordRequest(method, path, status, type = 'normal') {
  const entry = { method, path, status, timestamp: Date.now() };
  metrics.requests.push(entry);
  if (type === 'unmatched') metrics.unmatchedRequests.push(entry);
  if (type === 'denied') metrics.deniedRequests.push(entry);
}

function resetAllMetrics() {
  metrics.requests = [];
  metrics.unmatchedRequests = [];
  metrics.deniedRequests = [];
  metrics.startTime = Date.now();
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendXml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(body);
}

function isDenied(pathname) {
  return DENIED_ROUTES.some((p) => p.test(pathname));
}

function isAllowed(pathname) {
  return ALLOWED_ROUTES.some((p) => p.test(pathname));
}

function getLatency(pathname = null) {
  // Check for per-route latency override
  if (pathname && routesConfig[pathname]?.latencyMs) {
    return routesConfig[pathname].latencyMs;
  }
  
  // Fall back to profile-based latency
  const config = LATENCY_CONFIGS[LATENCY_PROFILE] || LATENCY_CONFIGS.fast;
  return Math.floor(Math.random() * (config.max - config.min + 1)) + config.min;
}

async function applyLatency(pathname = null) {
  const ms = getLatency(pathname);
  if (ms > 0) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

function buildFixtureHtml(pathname, metadataKey = null) {
  // Extract scenario from path
  const scenario = pathname.replace('/web/', '') || 'test';

  // Look up page config for metadata key
  let pageConfig = pagesConfig[scenario];
  let title = pageConfig?.title || 'Smoke Test Show';
  let year = pageConfig?.year || '2024';
  let key = metadataKey || pageConfig?.metadataKey || '/library/metadata/99999';

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Plex Fixture ${pathname}</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div data-testid="metadata-title">${title}</div>
    <div data-testid="metadata-line1">${year}</div>
    <div data-testid="metadata-ratings"></div>

    <script>
      (function bootstrapFixtureRequest() {
        const status = {
          attempted: false,
          completed: false,
          status: null,
          error: null
        };

        status.attempted = true;
        window.__PLEX_FIXTURE_BOOTSTRAP__ = status;

        // Delay to allow content script to initialize and set up message listener
        setTimeout(function() {
          // Add cache-busting parameter to ensure request hits server
          const cacheBuster = '_t=' + Date.now();
          fetch('${key}?includeGuids=1&includeExternalMedia=1&X-Plex-Token=${FIXTURE_TOKEN}&' + cacheBuster)
            .then((response) => {
              status.completed = true;
              status.status = response.status;
              window.__PLEX_FIXTURE_BOOTSTRAP__ = status;
            })
            .catch((error) => {
              status.completed = true;
              status.error = error?.message || String(error);
              window.__PLEX_FIXTURE_BOOTSTRAP__ = status;
            });
        }, 100);
      })();
    </script>
  </body>
</html>`;
}

function buildFallbackMetadataXml(metadataKey) {
  // Fallback for when no fixture file exists
  const keyNum = metadataKey.replace('/library/metadata/', '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="1">
  <Directory
    ratingKey="${keyNum}"
    key="${metadataKey}"
    guid="tmdb://1396"
    type="show"
    title="Smoke Test Show"
    year="2024"
    index="1"
  >
    <Guid id="tmdb://1396" />
  </Directory>
</MediaContainer>`;
}

function getMetadataXml(pathname) {
  // Look up route configuration
  const routeConfig = routesConfig[pathname];

  // Check for error simulation (for error-path tests)
  if (routeConfig?.errorStatus) {
    return { errorStatus: routeConfig.errorStatus, body: routeConfig.errorBody || { error: 'Simulated error' } };
  }

  if (routeConfig?.fixture) {
    const fixturePath = path.join(fixturesDir, 'xml', routeConfig.fixture);
    if (fs.existsSync(fixturePath)) {
      return fs.readFileSync(fixturePath, 'utf8');
    }
  }

  // Fallback to inline generation for backward compatibility
  return buildFallbackMetadataXml(pathname);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // Apply latency profile (supports per-route override)
  await applyLatency(pathname);

  if (isDenied(pathname)) {
    recordRequest(req.method, pathname, 403, 'denied');
    return sendJson(res, 403, {
      error: 'Forbidden',
      message: 'Route explicitly denied in fixture server',
      path: pathname
    });
  }

  if (!isAllowed(pathname)) {
    recordRequest(req.method, pathname, 501, 'unmatched');
    return sendJson(res, 501, {
      error: 'Not Implemented',
      path: pathname,
      method: req.method
    });
  }

  if (pathname === '/health') {
    recordRequest(req.method, pathname, 200);
    return sendJson(res, 200, {
      ok: true,
      uptimeMs: Date.now() - metrics.startTime,
      latencyProfile: LATENCY_PROFILE
    });
  }

  if (pathname === '/__metrics') {
    recordRequest(req.method, pathname, 200);
    return sendJson(res, 200, {
      totalRequests: metrics.requests.length,
      unmatchedCount: metrics.unmatchedRequests.length,
      deniedCount: metrics.deniedRequests.length,
      requests: metrics.requests,
      unmatchedRequests: metrics.unmatchedRequests,
      deniedRequests: metrics.deniedRequests
    });
  }

  if (pathname === '/__metrics/reset') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    }

    resetAllMetrics();
    return sendJson(res, 200, { ok: true, reset: true });
  }

  if (pathname === '/favicon.ico') {
    recordRequest(req.method, pathname, 204);
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith('/web/')) {
    // Extract metadata key from query if present
    const queryKey = url.searchParams.get('key');
    const decodedKey = queryKey ? decodeURIComponent(queryKey) : null;

    recordRequest(req.method, pathname, 200);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(buildFixtureHtml(pathname, decodedKey));
  }

  if (pathname.startsWith('/library/metadata/')) {
    const result = getMetadataXml(pathname);
    
    // Handle error simulation
    if (result && typeof result === 'object' && result.errorStatus) {
      recordRequest(req.method, pathname, result.errorStatus);
      return sendJson(res, result.errorStatus, result.body);
    }
    
    // Normal XML response
    recordRequest(req.method, pathname, 200);
    return sendXml(res, 200, result);
  }

  recordRequest(req.method, pathname, 501, 'unmatched');
  return sendJson(res, 501, { error: 'Not Implemented', path: pathname });
}

const server = http.createServer(handleRequest);

export async function startServer(port = PORT, host = HOST) {
  // Load fixtures before starting
  loadFixtures();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({ server, host, port });
    });
  });
}

export async function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export function getFixturesInfo() {
  return {
    routes: routesConfig,
    pages: pagesConfig
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  startServer().then(({ host, port }) => {
    console.log(`Fixture server running at http://${host}:${port}`);
    console.log(`Latency profile: ${LATENCY_PROFILE}`);
    console.log(`Loaded ${Object.keys(routesConfig).length} routes, ${Object.keys(pagesConfig).length} pages`);
  });
}
