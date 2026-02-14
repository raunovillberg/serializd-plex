#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

const outDir = path.join(rootDir, '.tmp', 'e2e');
const stagingDir = path.join(outDir, 'addon-staging');
const xpiPath = path.join(outDir, 'serializd-plex-test.xpi');

const runtimePaths = [
  'manifest.json',
  'styles.css',
  'scripts/content.js',
  'scripts/background.js',
  'icons'
];

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

for (const relPath of runtimePaths) {
  const srcPath = path.join(rootDir, relPath);
  const destPath = path.join(stagingDir, relPath);

  if (!fs.existsSync(srcPath)) {
    console.error(`Missing runtime file for addon package: ${relPath}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(srcPath, destPath, { recursive: true });
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(xpiPath, { force: true });

const zipResult = spawnSync('zip', ['-r', '-q', xpiPath, '.'], {
  cwd: stagingDir,
  stdio: 'inherit'
});

if (zipResult.error || zipResult.status !== 0) {
  console.error('Failed to create test addon XPI. Ensure `zip` is installed.');
  process.exit(zipResult.status || 1);
}

console.log(`Created test addon: ${xpiPath}`);
