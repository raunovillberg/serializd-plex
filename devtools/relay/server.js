#!/usr/bin/env node

/**
 * DEV-ONLY helper for Serializd-Plex.
 *
 * Receives JSON log events at POST /log and appends them to:
 *   .devlogs/firefox-console.ndjson
 *
 * Start:
 *   node devtools/relay/server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SERIALIZD_DEV_RELAY_PORT || 8765);
const HOST = process.env.SERIALIZD_DEV_RELAY_HOST || '127.0.0.1';
const LOG_DIR = path.resolve(process.cwd(), '.devlogs');
const LOG_FILE = path.join(LOG_DIR, 'firefox-console.ndjson');

fs.mkdirSync(LOG_DIR, { recursive: true });

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

function appendLog(entry) {
  const clean = redactSensitiveData({
    receivedAt: new Date().toISOString(),
    ...entry
  });

  fs.appendFile(LOG_FILE, `${JSON.stringify(clean)}\n`, (err) => {
    if (err) {
      console.error('Serializd-Plex Relay: failed to append log:', err.message);
    }
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'serializd-dev-log-relay',
      logFile: LOG_FILE
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/log') {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'Empty body' });
        return;
      }

      try {
        const parsed = JSON.parse(body);
        appendLog(parsed);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        appendLog({
          source: 'relay',
          event: 'invalid-json-body',
          rawBody: body,
          error: error.message
        });
        sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
      }
    });

    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log('Serializd-Plex Relay: listening');
  console.log(`- URL: http://${HOST}:${PORT}/log`);
  console.log(`- Health: http://${HOST}:${PORT}/health`);
  console.log(`- Log file: ${LOG_FILE}`);
});
