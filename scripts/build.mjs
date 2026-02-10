#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function getArg(name) {
  const prefix = `${name}=`;
  const entry = process.argv.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

const modeArg = getArg('--mode') || 'dev';
if (!['dev', 'prod'].includes(modeArg)) {
  console.error('Usage: node scripts/build.mjs --mode=<dev|prod> [--relay]');
  process.exit(1);
}

const isProd = modeArg === 'prod';
const relayRequested = process.argv.includes('--relay');
const relayEnabled = !isProd && relayRequested;

if (isProd && relayRequested) {
  console.error('Refusing to build prod bundle with relay enabled.');
  process.exit(1);
}

const define = {
  __DEV__: isProd ? 'false' : 'true',
  __DEV_RELAY__: relayEnabled ? 'true' : 'false'
};

const commonBuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['firefox140'],
  minify: false,
  sourcemap: isProd ? false : 'inline',
  legalComments: 'none',
  define,
  dropLabels: isProd ? ['DEV_DEBUG', 'DEV_RELAY'] : [],
  logLevel: 'info'
};

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(rootDir, 'src/content.js')],
  outfile: path.join(rootDir, 'scripts/content.js')
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(rootDir, 'src/background.js')],
  outfile: path.join(rootDir, 'scripts/background.js')
});

const manifestBasePath = path.join(rootDir, 'manifest.base.json');
const manifestOutPath = path.join(rootDir, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestBasePath, 'utf8'));

const relayHostPermission = 'http://127.0.0.1:8765/*';
manifest.host_permissions = manifest.host_permissions || [];

if (relayEnabled && !manifest.host_permissions.includes(relayHostPermission)) {
  manifest.host_permissions.push(relayHostPermission);
}

await fs.writeFile(manifestOutPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Build complete: mode=${modeArg}, relay=${relayEnabled}`);
