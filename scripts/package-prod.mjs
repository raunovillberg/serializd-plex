#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const manifestPath = path.join(rootDir, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const version = manifest.version;
const output = `serializd-plex-v${version}.zip`;

execSync('rm -f serializd-plex-v*.zip', { cwd: rootDir, stdio: 'inherit' });

const zipCommand = [
  'zip -r',
  output,
  'manifest.json',
  'styles.css',
  'scripts/background.js',
  'scripts/content.js',
  'icons',
  '-x "*.DS_Store"'
].join(' ');

execSync(zipCommand, { cwd: rootDir, stdio: 'inherit' });

console.log(`Built: ${output}`);
