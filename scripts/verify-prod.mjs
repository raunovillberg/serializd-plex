#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function readText(relPath) {
  return fs.readFile(path.join(rootDir, relPath), 'utf8');
}

const failures = [];

const manifest = JSON.parse(await readText('manifest.json'));
const relayHostPermission = 'http://127.0.0.1:8765/*';

if ((manifest.host_permissions || []).includes(relayHostPermission)) {
  failures.push(`manifest.json must not include ${relayHostPermission}`);
}

const contentBundle = await readText('scripts/content.js');
const backgroundBundle = await readText('scripts/background.js');
const combined = `${contentBundle}\n${backgroundBundle}`;

const forbiddenPatterns = [
  { label: 'relay localhost URL', regex: /127\.0\.0\.1:8765/ },
  { label: 'navigation debug marker', regex: /\[NavDebug\]/ },
  { label: 'id extraction debug marker', regex: /\[(EpisodeDebug|ShowDebug)\]/ },
  { label: 'relay debug message action', regex: /action:\s*['"]relayDebugLog['"]/ },
  { label: 'unstripped DEV_DEBUG label', regex: /DEV_DEBUG:/ },
  { label: 'unstripped DEV_RELAY label', regex: /DEV_RELAY:/ },
  { label: 'dev background loaded log', regex: /Background script loaded/ }
];

for (const { label, regex } of forbiddenPatterns) {
  if (regex.test(combined)) {
    failures.push(`Production bundle contains forbidden artifact: ${label}`);
  }
}

if (failures.length > 0) {
  console.error('Prod verification failed:\n');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Prod verification passed.');
