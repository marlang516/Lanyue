/**
 * 导入不能用 data.prefs 里的未修复副本盖掉顶层 repairIds 的结果，
 * 并且成功返回前必须把 prefs 同步落盘（set 本身是 300ms 防抖）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle() {}, on() {} },
      app: { getPath: () => os.tmpdir() },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad(request, parent, isMain);
};

const prefs = require('../src/utils/prefs');
const cloudSync = require('../src/main/ipc/cloudSync');
const { getInvokeHandler } = require('../src/main/ipc/register');

const dialog = { file: '' };
cloudSync.register({
  showOpenDialog: async () => ({ canceled: false, filePaths: [dialog.file] }),
  getUserDataDir: () => null,
});

function backupFile(payload) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'import-repair-')), 'backup.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  dialog.file = file;
}

test('顶层已修复的歌单/模板不被 data.prefs 副本盖回，且立即落盘', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'import-repair-ud-'));
  prefs.init(userData);
  backupFile({
    version: 3,
    app: 'music-downloader',
    data: {
      userPlaylists: [{ id: 'bad id!', name: '从顶层来' }],
      downloadTemplates: [{ id: 'tpl bad!', name: '模板顶层' }],
      activeTemplate: 'kept-template',
      prefs: {
        theme: 'neon',
        userPlaylists: [{ id: 'bad id!', name: 'prefs 副本' }],
        downloadTemplates: [{ id: 'tpl bad!', name: 'prefs 副本' }],
        activeDownloadTemplate: 'from-prefs',
      },
    },
  });
  try {
    const result = await getInvokeHandler('import-all-data')();
    assert.equal(result.success, true);
    const playlists = prefs.get('userPlaylists');
    assert.equal(playlists.length, 1);
    assert.equal(playlists[0].name, '从顶层来');
    assert.match(playlists[0].id, /^pl_fixed_[a-f0-9]+$/);
    const templates = prefs.get('downloadTemplates');
    assert.equal(templates[0].name, '模板顶层');
    assert.match(templates[0].id, /^tpl_fixed_[a-f0-9]+$/);
    assert.equal(prefs.get('activeDownloadTemplate'), 'kept-template');
    assert.equal(prefs.get('theme'), 'neon');
    const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'prefs.json'), 'utf8'));
    assert.equal(onDisk.userPlaylists[0].id, playlists[0].id);
    assert.equal(onDisk.theme, 'neon');
  } finally {
    prefs.destroy();
  }
});

test('顶层没有歌单时，prefs 里的那份仍然导入', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'import-repair-ud-'));
  prefs.init(userData);
  backupFile({
    version: 3,
    app: 'music-downloader',
    data: {
      prefs: {
        userPlaylists: [{ id: 'pl_only_prefs', name: '只有 prefs' }],
      },
    },
  });
  try {
    const result = await getInvokeHandler('import-all-data')();
    assert.equal(result.success, true);
    const playlists = prefs.get('userPlaylists');
    assert.equal(playlists[0].name, '只有 prefs');
    assert.equal(playlists[0].id, 'pl_only_prefs');
  } finally {
    prefs.destroy();
  }
});
