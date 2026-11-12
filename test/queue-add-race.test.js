/**
 * M2：入队查重与 push 之间隔着 await，并发时同一首歌会入队两次。
 *
 * add-to-queue 先查重再 `await history.findDownloadedAsync`，让出事件循环后
 * 直接 push；add-playlist-to-queue 的 existingIds 是循环开始前的快照。
 * 两次并发调用（连点按钮 / 单曲与批量同时发）都能通过各自的查重，
 * 于是同一 source+id 出现两个 pending 任务，调度器对同一 .tmp 以 'w' 并发写。
 *
 * 修法：await 之后、push 之前对**活队列**复查一次。
 * 本测试用门控 history 桩把「双双通过查重」的窗口钉成确定性复现。
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

/** 每个用例一份新队列 + 重新注册（handler 闭包持最新 deps） */
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

/** history 判活全部卡在门上，直到 release() —— 保证并发双方都已通过查重 */
function gatedHistory() {
  let release;
  const gate = new Promise((r) => { release = r; });
  historyStub.findDownloadedAsync = async () => { await gate; return null; };
  return () => release();
}

test('M2: 并发两次 add-to-queue 同一首歌只入队一次', async () => {
  const queue = setup();
  const release = gatedHistory();
  const song = { id: 's1', source: 'netease', title: '晴天', artist: '周杰伦' };
  const p1 = call('add-to-queue', {}, song);
  const p2 = call('add-to-queue', {}, { ...song });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(queue.length, 1, `同一首歌入了 ${queue.length} 次`);
  const results = [r1.data, r2.data];
  assert.strictEqual(results.filter((r) => r.queued).length, 1);
  assert.strictEqual(results.filter((r) => r.duplicated).length, 1);
});

test('M2: 并发两批 add-playlist-to-queue 重叠歌曲只入队一次', async () => {
  const queue = setup();
  const release = gatedHistory();
  const a = { id: 'a', source: 'qq', title: 'A' };
  const b = { id: 'b', source: 'qq', title: 'B' };
  const c = { id: 'c', source: 'qq', title: 'C' };
  const p1 = call('add-playlist-to-queue', {}, { songs: [a, b] });
  const p2 = call('add-playlist-to-queue', {}, { songs: [a, c] });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  const aCount = queue.filter((s) => s.id === 'a').length;
  assert.strictEqual(aCount, 1, `重叠歌曲 a 入了 ${aCount} 次`);
  assert.strictEqual(queue.length, 3);
  assert.strictEqual(r1.data.queued + r2.data.queued, 3);
});

test('M2: 单曲入队与批量入队并发重叠也只入队一次', async () => {
  const queue = setup();
  const release = gatedHistory();
  const a = { id: 'a', source: 'kugou', title: 'A' };
  const p1 = call('add-to-queue', {}, a);
  const p2 = call('add-playlist-to-queue', {}, { songs: [a] });
  release();
  await Promise.all([p1, p2]);
  assert.strictEqual(queue.filter((s) => s.id === 'a').length, 1);
});

test('顺序场景不回归：历史已下载仍返回 alreadyDownloaded 且不入队', async () => {
  const queue = setup();
  historyStub.findDownloadedAsync = async () => ({ savePath: 'C:/x.mp3', finishedAt: 123 });
  const r = await call('add-to-queue', {}, { id: 'z', source: 'qq', title: 'Z' });
  assert.strictEqual(r.data.alreadyDownloaded, true);
  assert.strictEqual(r.data.savePath, 'C:/x.mp3');
  assert.strictEqual(queue.length, 0);
});

test('顺序场景不回归：批量内部重复与队内重复仍被跳过', async () => {
  const queue = setup();
  historyStub.findDownloadedAsync = async () => null;
  queue.push({ id: 'a', source: 'qq', taskId: 't0', status: 'pending' });
  const a = { id: 'a', source: 'qq', title: 'A' };
  const b = { id: 'b', source: 'qq', title: 'B' };
  const r = await call('add-playlist-to-queue', {}, { songs: [a, b, { ...b }] });
  assert.strictEqual(r.data.queued, 1, '只应入队 b 一次');
  assert.strictEqual(r.data.skipped, 2, '队内已有的 a + 批内重复的 b');
  assert.strictEqual(queue.length, 2);
});