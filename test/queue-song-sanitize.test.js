/**
 * M3：入队载荷不得携带引擎内部状态字段。
 *
 * add-playlist-to-queue 的元素没有形状校验（t.arr 只钳长度），handler 直接
 * `{...s}` 展开入队。渲染层（或任何能调 IPC 的一方）塞进 `_processing:true`
 * 会让调度器把这条 pending 任务当成「协程在途」永久跳过；`_cancelRequested`
 * 会让它刚入队就被取消；error/savePath/finishedAt 等状态字段 likewise 不该由
 * 外部注入。队列状态必须由引擎独占。
 *
 * 为什么不能照搬单曲 add-to-queue 的封闭白名单 shape：歌单弹层批量载荷合法地
 * 携带 playlistName/trackNo/trackTotal 与各平台扩展字段（pay/mid/fee…），
 * 封闭白名单会把它们判成「未知字段」整批拒绝 —— 那是把整条批量下载打断。
 * 正确做法是在入队边界剥离内部/状态字段，保留开放歌曲形状。
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const handlers = new Map();
const historyStub = { findDownloadedAsync: async () => null };
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} } };
  }
  if (/utils\/history$/.test(request)) return historyStub;
  return originalLoad(request, parent, isMain);
};

const { register } = require('../src/main/ipc/download/queue');
const call = (channel, event = {}, ...args) => handlers.get(channel)(event, ...args);

function setup() {
  const queue = [];
  register({
    getQueue: () => queue,
    persistQueue: () => {},
    processQueue: () => {},
    progress: { emitQueueUpdated: () => {} },
  });
  return queue;
}

/** 合法歌曲 + 歌单元数据 + 平台扩展字段，再混入引擎内部/状态字段 */
function maliciousSong() {
  return {
    id: 's1', source: 'qq', title: '晴天', artist: '周杰伦',
    playlistName: '我的歌单', trackNo: 3, trackTotal: 10, pay: 1, mid: 'abc',
    // ── 以下都不该进队列 ──
    _processing: true,
    _cancelRequested: true,
    _altSource: 'kugou',
    status: 'done',
    taskId: 'fake-task',
    progress: 99,
    error: '注入的错误',
    errorCode: 'X',
    savePath: 'C:/evil.mp3',
    finishedAt: 123,
  };
}

test('M3: 批量入队剥离内部/状态字段，保留合法歌曲与歌单元数据', async () => {
  const queue = setup();
  const r = await call('add-playlist-to-queue', {}, { songs: [maliciousSong()] });
  assert.strictEqual(r.data.queued, 1);
  assert.strictEqual(queue.length, 1);
  const item = queue[0];
  // 内部调度标记必须被剥离
  assert.strictEqual(item._processing, undefined, '_processing 不得注入（否则任务被永久跳过）');
  assert.strictEqual(item._cancelRequested, undefined, '_cancelRequested 不得注入');
  assert.strictEqual(item._altSource, undefined, '_altSource 不得注入');
  // 引擎自有状态字段必须被重置/剥离
  assert.strictEqual(item.status, 'pending');
  assert.notStrictEqual(item.taskId, 'fake-task', 'taskId 必须由引擎生成');
  assert.strictEqual(item.progress, 0);
  assert.strictEqual(item.error, undefined);
  assert.strictEqual(item.errorCode, undefined);
  assert.strictEqual(item.savePath, undefined);
  assert.strictEqual(item.finishedAt, undefined);
  // 合法字段必须保留（封闭白名单会误杀这些，故不能照搬单曲 shape）
  assert.strictEqual(item.title, '晴天');
  assert.strictEqual(item.playlistName, '我的歌单');
  assert.strictEqual(item.trackNo, 3);
  assert.strictEqual(item.pay, 1);
  assert.strictEqual(item.mid, 'abc');
});

test('M3: 干净批量载荷不受影响（正常歌单仍全部入队）', async () => {
  const queue = setup();
  const songs = [
    { id: 'a', source: 'qq', title: 'A', playlistName: 'P', trackNo: 1 },
    { id: 'b', source: 'netease', title: 'B', playlistName: 'P', trackNo: 2 },
  ];
  const r = await call('add-playlist-to-queue', {}, { songs });
  assert.strictEqual(r.data.queued, 2);
  assert.strictEqual(queue.length, 2);
  assert.strictEqual(queue[0].playlistName, 'P');
  assert.strictEqual(queue[1].title, 'B');
});