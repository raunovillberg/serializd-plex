#!/usr/bin/env node

/**
 * Fixture Capture Helper
 *
 * Guides the process of capturing HAR files from Plex for test fixture generation.
 *
 * Usage:
 *   npm run fixtures:capture
 *
 * This script will:
 * 1. Display instructions for capturing HAR in browser DevTools
 * 2. Wait for HAR file to be placed in tests/fixtures/raw/
 * 3. Validate the HAR contains relevant Plex responses
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const rawDir = path.join(rootDir, 'tests/fixtures/raw');

console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                        Plex Fixture Capture Helper                           ║
╚══════════════════════════════════════════════════════════════════════════════╝

This script helps capture network traffic from Plex for test fixtures.

STEP 1: Open Browser DevTools
─────────────────────────────
  • Open Firefox or Chrome
  • Press F12 or Cmd+Opt+I to open Developer Tools
  • Go to the "Network" tab
  • Check "Persist Logs" (or "Preserve log")

STEP 2: Configure for HAR Export
─────────────────────────────────
  • Right-click in the Network tab → check "Response Bodies"
  • This ensures XML response content is included in the HAR

STEP 3: Navigate Plex
─────────────────────
  Browse to capture these scenarios:
  • A TV show detail page (with TMDB ID in response)
  • A season page
  • An episode page

  Look for requests matching: /library/metadata/<id>

STEP 4: Export HAR
──────────────────
  • Right-click in Network tab → "Save All As HAR"
  • Save to: ${rawDir}

  Suggested filename: plex-capture-YYYY-MM-DD.har

STEP 5: Generate Fixtures
─────────────────────────
  After saving the HAR file, run:
    npm run fixtures:generate

╔══════════════════════════════════════════════════════════════════════════════╗
`);

// Ensure raw directory exists
fs.mkdirSync(rawDir, { recursive: true });

// Check for existing HAR files
const harFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.har'));

if (harFiles.length > 0) {
  console.log('Existing HAR files found in tests/fixtures/raw/:\n');
  harFiles.forEach(f => {
    const stat = fs.statSync(path.join(rawDir, f));
    const sizeKB = Math.round(stat.size / 1024);
    console.log(`  • ${f} (${sizeKB} KB)`);
  });
  console.log('\nYou can run "npm run fixtures:generate" to process these files.\n');
} else {
  console.log('No HAR files found yet. Follow the steps above to capture Plex traffic.\n');
}

// Optional: Watch mode
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Watch for new HAR files? (y/N) ', (answer) => {
  if (answer.toLowerCase() === 'y') {
    console.log('\nWatching for new .har files... Press Ctrl+C to stop.\n');
    fs.watch(rawDir, (eventType, filename) => {
      if (filename && filename.endsWith('.har')) {
        console.log(`\n✓ Detected new HAR file: ${filename}`);
        validateHarFile(path.join(rawDir, filename));
      }
    });
  } else {
    rl.close();
  }
});

function validateHarFile(harPath) {
  try {
    const content = fs.readFileSync(harPath, 'utf8');
    const har = JSON.parse(content);

    const entries = har?.log?.entries || [];
    const metadataEntries = entries.filter(e =>
      e.request?.url?.includes('/library/metadata/')
    );

    if (metadataEntries.length > 0) {
      console.log(`  Found ${metadataEntries.length} metadata requests:`);
      metadataEntries.forEach(e => {
        const url = new URL(e.request.url);
        console.log(`    • ${url.pathname}`);
      });
      console.log('\n  Ready to generate fixtures: npm run fixtures:generate\n');
    } else {
      console.log('  ⚠ No /library/metadata requests found in this HAR file.\n');
    }
  } catch (err) {
    console.log(`  ⚠ Could not parse HAR file: ${err.message}\n`);
  }
}
