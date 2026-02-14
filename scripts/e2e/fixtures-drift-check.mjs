#!/usr/bin/env node

/**
 * Fixture Drift Check
 *
 * Compares current fixtures against fresh Plex responses.
 * Run this manually to detect API changes.
 *
 * Usage:
 *   npm run fixtures:drift-check
 *
 * Requirements:
 *   - PLEX_SERVER_URL environment variable (e.g., http://192.168.1.100:32400)
 *   - PLEX_TOKEN environment variable
 *
 * Example:
 *   PLEX_SERVER_URL=http://192.168.1.100:32400 PLEX_TOKEN=your-token npm run fixtures:drift-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const fixturesDir = path.join(rootDir, 'tests/fixtures/plex');

const PLEX_SERVER = process.env.PLEX_SERVER_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;

if (!PLEX_SERVER || !PLEX_TOKEN) {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                           Fixture Drift Check                                ║
╚══════════════════════════════════════════════════════════════════════════════╝

Usage:
  PLEX_SERVER_URL=<url> PLEX_TOKEN=<token> npm run fixtures:drift-check

Example:
  PLEX_SERVER_URL=http://192.168.1.100:32400 PLEX_TOKEN=abc123 npm run fixtures:drift-check

Environment Variables:
  PLEX_SERVER_URL  - Your Plex server URL (e.g., http://192.168.1.100:32400)
  PLEX_TOKEN       - Your Plex token (find in Plex Web > Settings > Privacy)

╔══════════════════════════════════════════════════════════════════════════════╗
`);
  process.exit(1);
}

// Load routes to know which metadata keys to check
const routesPath = path.join(fixturesDir, 'routes.json');
if (!fs.existsSync(routesPath)) {
  console.error('Error: No routes.json found. Run fixtures:generate first.');
  process.exit(1);
}

const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));

// Filter to routes with fixtures (not error simulations)
const checkRoutes = Object.entries(routes)
  .filter(([path, config]) => config.fixture && !config.errorStatus)
  .map(([path, config]) => ({ path, fixture: config.fixture, title: config.title }));

console.log('\n🔍 Drift Check: Comparing fixtures to live Plex server\n');
console.log(`Server: ${PLEX_SERVER}`);
console.log(`Checking ${checkRoutes.length} routes...\n`);

// Extract attribute names from XML (ignoring values)
function extractAttributes(xml) {
  const attrs = new Set();
  
  // Match all attribute-like patterns: name="value"
  const attrPattern = /(\w+)="[^"]*"/g;
  let match;
  while ((match = attrPattern.exec(xml)) !== null) {
    attrs.add(match[1]);
  }
  
  // Match self-closing tags and element names
  const tagPattern = /<\/?(\w+)/g;
  while ((match = tagPattern.exec(xml)) !== null) {
    attrs.add(`TAG:${match[1]}`);
  }
  
  return attrs;
}

// Compare attribute sets
function compareAttributes(fixtureAttrs, liveAttrs) {
  const added = [...liveAttrs].filter(a => !fixtureAttrs.has(a));
  const removed = [...fixtureAttrs].filter(a => !liveAttrs.has(a));
  return { added, removed };
}

let driftFound = false;
const driftReport = [];

for (const route of checkRoutes) {
  const fixturePath = path.join(fixturesDir, 'xml', route.fixture);
  
  if (!fs.existsSync(fixturePath)) {
    console.log(`  ⚠ Missing fixture: ${route.fixture}`);
    continue;
  }
  
  const fixtureXml = fs.readFileSync(fixturePath, 'utf8');
  const fixtureAttrs = extractAttributes(fixtureXml);
  
  // Fetch live response
  try {
    const url = `${PLEX_SERVER}${route.path}?includeGuids=1&includeExternalMedia=1&X-Plex-Token=${PLEX_TOKEN}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      console.log(`  ✗ ${route.path}: HTTP ${response.status}`);
      continue;
    }
    
    const liveXml = await response.text();
    const liveAttrs = extractAttributes(liveXml);
    
    const { added, removed } = compareAttributes(fixtureAttrs, liveAttrs);
    
    if (added.length > 0 || removed.length > 0) {
      driftFound = true;
      driftReport.push({
        path: route.path,
        title: route.title,
        added,
        removed
      });
      console.log(`  ⚠ DRIFT: ${route.path} (${route.title})`);
      if (added.length > 0) console.log(`      Added: ${added.join(', ')}`);
      if (removed.length > 0) console.log(`      Removed: ${removed.join(', ')}`);
    } else {
      console.log(`  ✓ ${route.path} (${route.title})`);
    }
  } catch (error) {
    console.log(`  ✗ ${route.path}: ${error.message}`);
  }
}

console.log('\n' + '─'.repeat(60));

if (driftFound) {
  console.log('\n⚠ DRIFT DETECTED!\n');
  console.log('The following changes were found:\n');
  
  for (const item of driftReport) {
    console.log(`📌 ${item.path} (${item.title})`);
    if (item.added.length > 0) {
      console.log(`   NEW attributes: ${item.added.join(', ')}`);
    }
    if (item.removed.length > 0) {
      console.log(`   REMOVED attributes: ${item.removed.join(', ')}`);
    }
    console.log('');
  }
  
  console.log('Recommended actions:');
  console.log('1. Run: npm run fixtures:capture');
  console.log('2. Capture the affected routes');
  console.log('3. Run: npm run fixtures:generate');
  console.log('4. Review changes and commit updated fixtures\n');
  
  process.exit(1);
} else {
  console.log('\n✅ No drift detected. Fixtures are up to date.\n');
  process.exit(0);
}
