import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer } from './fixture-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const addonPath = path.join(rootDir, '.tmp', 'e2e', 'serializd-plex-test.xpi');

const fixturePort = Number(process.env.FIXTURE_SERVER_PORT || 32400);
const fixtureHost = process.env.FIXTURE_SERVER_HOST || '127.0.0.1';

export const config = {
  runner: 'local',
  specs: [],
  maxInstances: 1,
  capabilities: [{
    browserName: 'firefox',
    acceptInsecureCerts: true,
    'moz:firefoxOptions': {
      args: [
        ...(process.env.CI ? ['-headless'] : [])
      ],
      prefs: {
        'toolkit.telemetry.reportingpolicy.firstRun': false,
        'browser.shell.checkDefaultBrowser': false,
        'browser.startup.page': 0,
        'browser.startup.homepage': 'about:blank',
        'xpinstall.signatures.required': false,
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
        'extensions.webextensions.restrictedDomains': ''
      }
    }
  }],

  logLevel: process.env.CI ? 'error' : 'warn',
  bail: 0,
  baseUrl: `http://${fixtureHost}:${fixturePort}`,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 30000
  },

  onPrepare: async () => {
    await startServer(fixturePort, fixtureHost);
    console.log(`Fixture server started on http://${fixtureHost}:${fixturePort}`);
  },

  before: async () => {
    const addonBase64 = fs.readFileSync(addonPath).toString('base64');
    await browser.installAddOn(addonBase64, true);

    // Give extension time to initialize background script and set up listeners
    await browser.pause(500);
  },

  onComplete: async () => {
    await stopServer();
    console.log('Fixture server stopped');
  }
};
