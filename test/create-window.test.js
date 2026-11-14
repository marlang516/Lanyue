'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindow } = require('../src/main/createWindow');

function createHarness({ isPackaged, devUrl }) {
  const previousDevUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
  else process.env.VITE_DEV_SERVER_URL = devUrl;

  const loadUrls = [];
  const warnings = [];
  const win = {
    webContents: {
      on() {},
      setWindowOpenHandler() {},
      getURL: () => 'file:///app/dist/renderer/index.html',
      reload() {},
    },
    loadFile: () => Promise.reject(new Error('renderer entry missing')),
    loadURL: (url) => {
      loadUrls.push(url);
      return Promise.resolve();
    },
    on() {},
    hide() {},
  };

  createWindow({
    app: { isPackaged, getAppPath: () => 'C:\\app' },
    BrowserWindow: function BrowserWindow() { return win; },
    logger: {
      log() {},
      warn: (...args) => warnings.push(args.join(' ')),
    },
    safeSend() {},
    getDownloadQueue: () => [],
    getDownloadQueueEngine: () => null,
    trayMod: { isQuittingApp: () => false, getTray: () => null },
    bootT0: Date.now(),
  });

  return new Promise((resolve) => {
    setImmediate(() => {
      if (previousDevUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
      else process.env.VITE_DEV_SERVER_URL = previousDevUrl;
      resolve({ loadUrls, warnings });
    });
  });
}

test('packaged main window does not load an environment-provided renderer URL', async () => {
  const { loadUrls } = await createHarness({
    isPackaged: true,
    devUrl: 'https://untrusted.example/',
  });

  assert.deepEqual(loadUrls, []);
});

test('development main window retains localhost Vite fallback', async () => {
  const { loadUrls } = await createHarness({
    isPackaged: false,
    devUrl: 'http://localhost:5181/',
  });

  assert.deepEqual(loadUrls, ['http://localhost:5181/']);
});

test('development main window rejects non-local renderer URLs', async () => {
  const { loadUrls } = await createHarness({
    isPackaged: false,
    devUrl: 'https://untrusted.example/',
  });

  assert.deepEqual(loadUrls, []);
});
