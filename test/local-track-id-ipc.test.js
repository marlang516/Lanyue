/**
 * 本地曲目 id 去路径化 · 主进程持久化边界
 *
 * 旧版本把本地歌的 id 存成绝对路径，键（id:source）随歌单导出/同步/
 * 助手摘要外泄磁盘布局。新形状 id = localTrackId(filePath)（路径哈希）。
 * 本测试钉住主进程两个边界：
 *   1. _loadPlaylists 读出即迁移 —— 旧形状存量（含 relink 过的失联行）
 *      在 get-user-playlists 时升为哈希 id，并随写回落盘；
 *   2. aggregate-cross-source 的本地组折叠不再产路径 id。
 *
 * electron 用桩替代（同 favorites.test.js）；cookie 适配器注入空集合，
 * 避免聚合择优依赖真实登录态。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-ltid-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userDataDir },
      shell: { trashItem: async () => {}, showItemInFolder() {} },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const prefs = require('../src/utils/prefs');
const libraryIndex = require('../src/utils/libraryIndex');
const ipcPlaylist = require('../src/main/ipc/playlist');
ipcPlaylist.register({
  domain: require('../src/main/ipc/playlist/domain'),
  infra: require('../src/main/ipc/playlist/infra').createInfra({
    cookie: { getLoggedInSources: () => [] },
  }),
});

const { FAVORITES_ID } = ipcPlaylist;
const { localTrackId } = require('../src/shared/localTrackId.mjs');

const { ENVELOPE_KEY } = require('../src/shared/ipcContract');
const invoke = (channel) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  return async (...args) => {
    const env = await fn(...args);
    if (env && typeof env === 'object' && env[ENVELOPE_KEY] === 1) {
      if (!env.ok) throw new Error(env.error);
      return env.data;
    }
    return env;
  };
};

/** 每个用例换一份干净的 userData（prefs 与曲库索引同目录） */
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-ltid-'));
  prefs.init(dir);
  libraryIndex.init(dir);
  return dir;
}

test('get-user-playlists：旧形状本地收藏（id=路径）读出即升为哈希 id，filePath 保留', async () => {
  fresh();
  const p = 'C:\\music\\fav.mp3';
  prefs.set('userPlaylists', [{
    id: FAVORITES_ID, name: '收藏', system: true,
    songs: [
      { id: p, source: 'local', title: 'A', filePath: p },
      { id: 1001, source: 'netease', title: 'N' },
    ],
  }]);
  const pls = await invoke('get-user-playlists')();
  const fav = pls.find(x => x.id === FAVORITES_ID);
  assert.strictEqual(fav.songs[0].id, localTrackId(p));
  assert.strictEqual(fav.songs[0].filePath, p, '播放仍靠 filePath，必须保留');
  assert.strictEqual(fav.songs[0].title, 'A');
  assert.strictEqual(fav.songs[1].id, 1001, '在线曲不受影响');
  // 迁移结果已随写回落盘：再读形状稳定
  const again = await invoke('get-user-playlists')();
  assert.strictEqual(again.find(x => x.id === FAVORITES_ID).songs[0].id, localTrackId(p));
});

test('get-user-playlists：普通歌单同样迁移；relink 过的行按当前 filePath 收敛', async () => {
  fresh();
  const oldP = 'C:\\music\\old.mp3';
  const newP = 'D:\\moved\\new.mp3';
  prefs.set('userPlaylists', [
    { id: FAVORITES_ID, name: '收藏', system: true, songs: [] },
    { id: 'pl1', name: '普通', songs: [{ id: oldP, source: 'local', title: 'M', filePath: newP }] },
  ]);
  const pls = await invoke('get-user-playlists')();
  const pl = pls.find(x => x.id === 'pl1');
  assert.strictEqual(pl.songs[0].id, localTrackId(newP), 'id 收敛到当前路径的哈希');
  assert.strictEqual(pl.songs[0].filePath, newP);
});

test('get-user-playlists：新形状（哈希 id）原样通过，不重复迁移', async () => {
  fresh();
  const p = 'C:\\music\\ok.mp3';
  const row = { id: localTrackId(p), source: 'local', title: 'OK', filePath: p };
  prefs.set('userPlaylists', [{ id: FAVORITES_ID, name: '收藏', system: true, songs: [row] }]);
  const pls = await invoke('get-user-playlists')();
  assert.deepStrictEqual(pls.find(x => x.id === FAVORITES_ID).songs, [row]);
});

test('aggregate-cross-source：本地组折叠 id=路径哈希，不再外泄磁盘路径', async () => {
  const dir = fresh();
  const p = 'E:\\lib\\song.mp3';
  fs.writeFileSync(path.join(dir, 'library-index.json'), JSON.stringify({
    dirPath: 'E:\\lib', lastScan: 1,
    songs: [{ filePath: p, title: 'S', artist: 'X', durationMs: 1000 }],
  }));
  const r = await invoke('aggregate-cross-source')(null, { includeLocal: true });
  const local = r.songs.filter(s => s.source === 'local');
  assert.strictEqual(local.length, 1);
  assert.strictEqual(local[0].id, localTrackId(p));
  assert.strictEqual(local[0].filePath, p);
});