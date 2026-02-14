#!/usr/bin/env node

/**
 * Fixture Generator
 *
 * Parses HAR files from tests/fixtures/raw/ and generates sanitized test fixtures.
 *
 * Usage:
 *   npm run fixtures:generate [--har=<filename>]
 *
 * Output:
 *   tests/fixtures/plex/xml/*.xml    - Sanitized metadata responses
 *   tests/fixtures/plex/routes.json  - Route definitions
 *   tests/fixtures/plex/pages.json   - Page configurations
 *   tests/fixtures/plex/manifest.json - Version metadata
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const rawDir = path.join(rootDir, 'tests/fixtures/raw');
const plexDir = path.join(rootDir, 'tests/fixtures/plex');
const xmlDir = path.join(plexDir, 'xml');

// Configuration
const PLACEHOLDER_TOKEN = 'FIXTURE-TOKEN-PLACEHOLDER';
const PLACEHOLDER_HOST = '127.0.0.1';
const PLACEHOLDER_PORT = '32400';

// ID mapping for stable placeholders
const idMapping = new Map();
let nextStableId = 10001;

// Track all ratingKeys in fixture set for referential integrity
const ratingKeysInSet = new Set();

function getStableId(originalKey) {
  // All IDs map to the same stable ID regardless of context (ratingKey, parent, grandparent)
  if (!idMapping.has(originalKey)) {
    idMapping.set(originalKey, nextStableId++);
  }
  return idMapping.get(originalKey);
}

function sanitizeToken(str) {
  if (typeof str !== 'string') return str;
  // Replace X-Plex-Token query params
  return str.replace(/([?&]X-Plex-Token=)[^&\s]+/gi, `$1${PLACEHOLDER_TOKEN}`);
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Replace host with fixture server
    parsed.host = `${PLACEHOLDER_HOST}:${PLACEHOLDER_PORT}`;
    // Remove token from query
    parsed.searchParams.delete('X-Plex-Token');
    parsed.searchParams.set('X-Plex-Token', PLACEHOLDER_TOKEN);
    return parsed.toString();
  } catch {
    return url;
  }
}

function sanitizePath(path) {
  // Replace numeric IDs in /library/metadata/NNNN paths
  return path.replace(/\/library\/metadata\/(\d+)/g, (match, id) => {
    const stableId = getStableId(id);
    return `/library/metadata/${stableId}`;
  });
}

function sanitizeXml(xmlContent) {
  let sanitized = xmlContent;

  // Replace ratingKey attributes
  sanitized = sanitized.replace(
    /ratingKey="(\d+)"/g,
    (match, id) => {
      const stableId = getStableId(id);
      ratingKeysInSet.add(stableId);
      return `ratingKey="${stableId}"`;
    }
  );

  // Replace grandparentRatingKey FIRST (before parentRatingKey to avoid substring matching)
  sanitized = sanitized.replace(
    /grandparentRatingKey="(\d+)"/g,
    (match, id) => {
      const stableId = getStableId(id);
      return `grandparentRatingKey="${stableId}"`;
    }
  );

  // Replace parentRatingKey with negative lookbehind to avoid matching grandparentRatingKey
  sanitized = sanitized.replace(
    /(?<!grand)parentRatingKey="(\d+)"/g,
    (match, id) => {
      const stableId = getStableId(id);
      return `parentRatingKey="${stableId}"`;
    }
  );

  // Replace key attributes (paths)
  sanitized = sanitized.replace(
    /key="([^"]+)"/g,
    (match, keyPath) => {
      const sanitizedPath = sanitizePath(keyPath);
      return `key="${sanitizedPath}"`;
    }
  );

  // Remove/replace any remaining tokens
  sanitized = sanitized.replace(/X-Plex-Token[=:]\s*[a-zA-Z0-9_-]{10,}/gi, `X-Plex-Token=${PLACEHOLDER_TOKEN}`);

  // Replace any hostnames that look like Plex servers
  sanitized = sanitized.replace(
    /https?:\/\/[a-zA-Z0-9.-]+\.plex\.direct:\d+/g,
    `http://${PLACEHOLDER_HOST}:${PLACEHOLDER_PORT}`
  );
  sanitized = sanitized.replace(
    /https?:\/\/[a-zA-Z0-9.-]+\.plex\.tv/g,
    `http://${PLACEHOLDER_HOST}:${PLACEHOLDER_PORT}`
  );
  sanitized = sanitized.replace(
    /https?:\/\/\d+\.\d+\.\d+\.\d+:\d+/g,
    `http://${PLACEHOLDER_HOST}:${PLACEHOLDER_PORT}`
  );

  return sanitized;
}

function detectContentType(xmlContent) {
  if (/<Directory[^>]*type="show"/.test(xmlContent)) return 'show';
  if (/<Directory[^>]*type="season"/.test(xmlContent)) return 'season';
  if (/<Video[^>]*type="episode"/.test(xmlContent)) return 'episode';
  if (/<Video[^>]*type="movie"/.test(xmlContent)) return 'movie';
  return 'unknown';
}

function extractTitle(xmlContent) {
  const match = xmlContent.match(/title="([^"]+)"/);
  return match ? match[1] : 'Unknown';
}

function extractYear(xmlContent) {
  const match = xmlContent.match(/year="(\d{4})"/);
  return match ? match[1] : null;
}

function validateXml(xmlContent, filename) {
  const errors = [];

  // Check for token-like strings
  const tokenPatterns = [
    /[a-zA-Z0-9_-]{20,}/g, // Long alphanumeric strings could be tokens
  ];

  // But allow our placeholder
  const withoutPlaceholders = xmlContent.replace(PLACEHOLDER_TOKEN, '');
  const withoutGuids = withoutPlaceholders.replace(/tmdb:\/\/\d+/g, '');

  // Check for potential leaked tokens (Plex tokens are typically 16-24 chars)
  const potentialTokens = withoutGuids.match(/[a-zA-Z0-9]{16,}/g);
  if (potentialTokens) {
    // Filter out common false positives (URLs, already-sanitized placeholders)
    const likelyTokens = potentialTokens.filter(t => 
      !t.startsWith('http') && 
      !t.includes('FIXTURE-TOKEN') &&
      !/^\\d+$/.test(t) // pure numbers are likely IDs, not tokens
    );
    if (likelyTokens.length > 0) {
      errors.push(`Potential leaked token found in ${filename}: ${likelyTokens[0].slice(0, 8)}...`);
    }
  }

  // Check required attributes
  if (!xmlContent.includes('ratingKey=')) {
    errors.push(`Missing ratingKey attribute in ${filename}`);
  }
  if (!xmlContent.includes('title=')) {
    errors.push(`Missing title attribute in ${filename}`);
  }

  return errors;
}

function validateReferentialIntegrity(routes) {
  const errors = [];

  // For each fixture, check that parentRatingKey and grandparentRatingKey references exist
  for (const [route, config] of Object.entries(routes)) {
    const xmlPath = path.join(xmlDir, config.fixture);
    if (!fs.existsSync(xmlPath)) continue;

    const content = fs.readFileSync(xmlPath, 'utf8');

    // Check parentRatingKey references
    const parentMatches = content.matchAll(/parentRatingKey="(\d+)"/g);
    for (const match of parentMatches) {
      const parentId = parseInt(match[1], 10);
      if (!ratingKeysInSet.has(parentId)) {
        errors.push(`${config.fixture}: parentRatingKey=${parentId} not found in fixture set`);
      }
    }

    // Check grandparentRatingKey references
    const grandparentMatches = content.matchAll(/grandparentRatingKey="(\d+)"/g);
    for (const match of grandparentMatches) {
      const grandparentId = parseInt(match[1], 10);
      if (!ratingKeysInSet.has(grandparentId)) {
        errors.push(`${config.fixture}: grandparentRatingKey=${grandparentId} not found in fixture set`);
      }
    }
  }

  return errors;
}

function parseHarFile(harPath) {
  const content = fs.readFileSync(harPath, 'utf8');
  const har = JSON.parse(content);

  const entries = har?.log?.entries || [];
  const metadataEntries = entries.filter(e => {
    const url = e.request?.url || '';
    return url.includes('/library/metadata/') && !url.includes('/children');
  });

  const results = [];

  for (const entry of metadataEntries) {
    const url = entry.request?.url;
    if (!url) continue;

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;

    // Get response content
    const responseText = entry.response?.content?.text;
    if (!responseText) {
      console.log(`  ⚠ No response body for ${path}, skipping`);
      continue;
    }

    // Validate XML can be parsed
    try {
      // Basic XML validation - check it starts properly
      if (!responseText.trim().startsWith('<?xml') && !responseText.trim().startsWith('<MediaContainer')) {
        console.log(`  ⚠ Response for ${path} doesn't appear to be XML, skipping`);
        continue;
      }
    } catch (err) {
      console.log(`  ⚠ Invalid XML in response for ${path}: ${err.message}`);
      continue;
    }

    results.push({
      originalPath: path,
      responseText,
      url
    });
  }

  return results;
}

function generateFixtures(harFiles) {
  console.log('\nGenerating fixtures...\n');

  // Ensure output directories exist
  fs.mkdirSync(xmlDir, { recursive: true });

  const routes = {};
  const pages = {};
  const scenarios = new Set();

  // First pass: collect all metadata and build ID mapping
  const allMetadata = [];
  for (const harFile of harFiles) {
    console.log(`Processing: ${harFile}`);
    const metadata = parseHarFile(path.join(rawDir, harFile));
    allMetadata.push(...metadata);
    console.log(`  Found ${metadata.length} metadata responses`);
  }

  if (allMetadata.length === 0) {
    console.log('\n⚠ No metadata responses found in HAR files.');
    console.log('Make sure you captured requests to /library/metadata/* endpoints.\n');
    process.exit(1);
  }

  // Second pass: sanitize and write fixtures
  console.log('\nSanitizing and writing fixtures...\n');

  for (const item of allMetadata) {
    const sanitizedXml = sanitizeXml(item.responseText);
    const contentType = detectContentType(sanitizedXml);
    const title = extractTitle(sanitizedXml);
    const year = extractYear(sanitizedXml);

    // Determine stable path
    const pathMatch = item.originalPath.match(/\/library\/metadata\/(\d+)/);
    if (!pathMatch) continue;

    const originalId = pathMatch[1];
    const stableId = getStableId(originalId);
    const stablePath = `/library/metadata/${stableId}`;

    // Generate filename
    const filename = `${contentType}-${stableId}.xml`;

    // Validate
    const validationErrors = validateXml(sanitizedXml, filename);
    if (validationErrors.length > 0) {
      console.log(`  ✗ Validation failed for ${filename}:`);
      validationErrors.forEach(err => console.log(`    - ${err}`));
      process.exit(1);
    }

    // Write XML file
    fs.writeFileSync(path.join(xmlDir, filename), sanitizedXml, 'utf8');
    console.log(`  ✓ Wrote ${filename} (${contentType}: "${title}"${year ? ` (${year})` : ''})`);

    // Add to routes
    routes[stablePath] = {
      fixture: filename,
      scenario: contentType,
      title,
      year
    };

    scenarios.add(contentType);

    // Add to pages config
    const pageKey = contentType;
    if (!pages[pageKey]) {
      pages[pageKey] = {
        path: `/web/${pageKey}`,
        title,
        year,
        metadataKey: stablePath
      };
    }
  }

  // Validate referential integrity
  console.log('\nValidating referential integrity...');
  const integrityErrors = validateReferentialIntegrity(routes);
  if (integrityErrors.length > 0) {
    console.log('\n✗ Referential integrity errors:');
    integrityErrors.forEach(err => console.log(`  - ${err}`));
    console.log('\nNote: You may need to capture additional parent/season metadata.\n');
    process.exit(1);
  }
  console.log('  ✓ All references valid\n');

  // Write routes.json
  fs.writeFileSync(
    path.join(plexDir, 'routes.json'),
    JSON.stringify(routes, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ Wrote routes.json');

  // Write pages.json
  fs.writeFileSync(
    path.join(plexDir, 'pages.json'),
    JSON.stringify(pages, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ Wrote pages.json');

  // Write manifest.json (use fixed timestamp for deterministic builds)
  const manifest = {
    fixtureVersion: '1.0.0',
    generated: '2026-02-13T00:00:00.000Z',
    source: 'har-capture',
    scenarios: Array.from(scenarios).sort(),
    idMappingSize: idMapping.size
  };
  fs.writeFileSync(
    path.join(plexDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );
  console.log('  ✓ Wrote manifest.json');

  console.log(`\n✓ Generated fixtures for ${Object.keys(routes).length} metadata entries\n`);
}

// Main
const args = process.argv.slice(2);
let harFiles = [];

const harArg = args.find(a => a.startsWith('--har='));
if (harArg) {
  const harName = harArg.split('=')[1];
  harFiles = [harName];
} else {
  harFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.har'));
}

if (harFiles.length === 0) {
  console.log('\n⚠ No HAR files found in tests/fixtures/raw/');
  console.log('Run "npm run fixtures:capture" first to capture Plex traffic.\n');
  process.exit(1);
}

generateFixtures(harFiles);
