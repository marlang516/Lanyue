/**
 * 检查更新把 DataCloneError 印到设置页
 *
 * electron-updater 6.8.11 的 doCheckForUpdates 在 resolve 之前同步
 * emit('update-available')。监听器里 webContents.send 一抛，异常冒出
 * emit，checkForUpdates() 被拒绝；updater.js 的 catch 把 err.message
 * 原样放进 { success:false, error }，设置页就显示
 * "An object could not be cloned."。
 *
 * 这里不拉真 electron-updater：用一次同步 emit 复现「监听器抛错 = 检查被拒绝」，
 * 钉住三件事：
 *   a. 字符串说明、以及 {version, note}[] 都收成可 JSON 的普通值；
 *   b. 函数、或带着 Promise 的对象被丢掉，收包本身不抛；
 *   c. webContents.send 抛错不会拒绝检查（下载同理）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const sent = [];
let sendImpl = (channel, payload) => { sent.push({ channel, payload }); };

const autoUpdater = new EventEmitter();
let onCheck = async () => ({ isUpdateAvailable: false });
let onDownload = async () => [];
autoUpdater.checkForUpdates = () => onCheck();
autoUpdater.downloadUpdate = () => onDownload();
autoUpdater.quitAndInstall = () => {};
autoUpdater.setFeedURL = () => {};

const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle() {}, on() {} },
      BrowserWindow: {
        getAllWindows: () => [{
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, send: (ch, payload) => sendImpl(ch, payload) },
        }],
      },
    };
  }
  if (request === 'electron-updater') return { autoUpdater };
  return originalLoad(request, parent, isMain);
};

const { getInvokeHandler } = require('../src/main/ipc/register');
require('../src/main/updater');

const check = getInvokeHandler('check-for-update');
const download = getInvokeHandler('download-update');

function assertPlain(payload) {
  assert.deepStrictEqual(structuredClone(payload), payload);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), payload);
}

/** 与 doCheckForUpdates 一样：先同步 emit，再 resolve。监听器一抛，检查就拒绝。 */
function armCheck(info) {
  sent.length = 0;
  onCheck = async () => {
    autoUpdater.emit('update-available', info);
    return {
      isUpdateAvailable: true,
      downloadPromise: Promise.resolve([]),
      cancellationToken: { cancel() {} },
    };
  };
}

test('字符串说明原样过 IPC，且可 JSON / structuredClone', async () => {
  sendImpl = (channel, payload) => { sent.push({ channel, payload }); };
  const notes = '第一行\n第二行';
  armCheck({
    version: '1.1.3',
    releaseNotes: notes,
    files: [{ url: new URL('https://github.com/marlang516/Lanyue/releases/download/v1.1.3/Lanyue.exe') }],
  });
  const result = await check();
  assert.deepStrictEqual(result, { success: true });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].channel, 'update-available');
  assert.deepStrictEqual(sent[0].payload, { version: '1.1.3', releaseNotes: notes });
  assertPlain(sent[0].payload);
});

test('fullChangelog 的 {version, note}[] 收成纯字符串字段', async () => {
  sendImpl = (channel, payload) => { sent.push({ channel, payload }); };
  armCheck({
    version: 1.2,
    releaseNotes: [
      { version: '1.2.0', note: '新版本' },
      { version: '1.1.3', note: null },
      { version: 'skip', note: Promise.resolve('不该出现') },
      { version: () => 'no', note: 'no' },
      '不是条目',
    ],
  });
  const result = await check();
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(sent[0].payload, {
    version: '1.2',
    releaseNotes: [
      { version: '1.2.0', note: '新版本' },
      { version: '1.1.3', note: '' },
    ],
  });
  assertPlain(sent[0].payload);
});

test('函数、或带着 Promise 的说明被丢掉，收包不抛', async () => {
  sendImpl = (channel, payload) => { sent.push({ channel, payload }); };
  armCheck({ version: '1.1.3', releaseNotes: () => 'nope' });
  let result = await check();
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(sent[0].payload, { version: '1.1.3' });
  assert.ok(!('releaseNotes' in sent[0].payload));
  assertPlain(sent[0].payload);

  armCheck({
    version: '1.1.3',
    releaseNotes: { version: '1.1.3', note: '正文', pending: Promise.resolve(1) },
  });
  result = await check();
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(sent[0].payload, { version: '1.1.3' });
  assertPlain(sent[0].payload);
});

test('webContents.send 抛 DataCloneError 不会拒绝检查', async () => {
  sendImpl = () => { throw new Error('An object could not be cloned.'); };
  armCheck({ version: '1.1.3', releaseNotes: '说明' });
  const result = await check();
  assert.deepStrictEqual(result, { success: true });
  assertPlain(result);
});

test('webContents.send 抛错也不会拒绝下载', async () => {
  sendImpl = () => { throw new Error('An object could not be cloned.'); };
  onDownload = async () => {
    autoUpdater.emit('download-progress', {
      percent: 40,
      bytesPerSecond: 12,
      cancellationToken: { cancel() {} },
    });
    autoUpdater.emit('update-downloaded', {
      version: '1.1.3',
      downloadedFile: '/tmp/Lanyue.exe',
      files: [{ url: new URL('https://example.com/a.exe') }],
    });
    return ['/tmp/Lanyue.exe'];
  };
  const result = await download();
  assert.deepStrictEqual(result, { success: true });
  assertPlain(result);
});

test('守卫：五条更新事件都走 safeSend，不再把 releaseNotes 原样送过 IPC', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/updater.js'), 'utf8');
  const code = src.split('\n').filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  for (const ch of [
    'update-available',
    'update-not-available',
    'update-download-progress',
    'update-downloaded',
    'update-error',
  ]) {
    assert.ok(code.includes(`safeSend('${ch}'`), `缺少 safeSend('${ch}')`);
  }
  assert.ok(!/releaseNotes:\s*info\.releaseNotes/.test(code), '不许再把 info.releaseNotes 原样放进 IPC');
  assert.ok(!/webContents\.send\(/.test(code), '更新事件只许经 safeSend 出口');
});
