/**
 * 搜索结果播放不得因为 Vue 代理在 IPC 边界抛 DataCloneError。
 *
 * 假 getDownloadUrlSmart 对歌曲参数做 structuredClone，和 Electron invoke 一样。
 * 旧桩不克隆，所以抓不到「An object could not be cloned.」。
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./esm-ts-resolve.mjs', import.meta.url).href, {
  parentURL: import.meta.url,
});

const audios = [];

class FakeAudio {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.duration = 180;
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.paused = true;
    this.preload = '';
    this.readyState = 0;
    this.error = null;
    this.playCount = 0;
    this.listeners = new Map();
    audios.push(this);
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener() {}

  emit(type) {
    for (const fn of this.listeners.get(type) || []) fn();
  }

  play() {
    this.paused = false;
    this.playCount += 1;
    this.readyState = 4;
    queueMicrotask(() => this.emit('play'));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    queueMicrotask(() => this.emit('pause'));
  }

  load() {
    this.readyState = this.src ? 2 : 0;
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

const g = globalThis;
g.window = g;
g.Audio = FakeAudio;

const payloads = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

g.window.__LY_MOCK__ = {
  async getDownloadUrlSmart(song) {
    // 与 ipcRenderer.invoke 相同：参数必须能结构化克隆。代理会在这里抛。
    const cloned = structuredClone(song);
    payloads.push({ song, cloned });
    return {
      url: `https://cdn.example/${song.id}.mp3`,
      source: song.source,
      id: song.id,
    };
  },
  async proxyPlay(url, _referer, refresh) {
    const id = String(url).split('/').pop().replace('.mp3', '');
    const quality = refresh && refresh.quality ? refresh.quality : '';
    return { fileUrl: `lanyue-stream://${id}?q=${quality}` };
  },
  async getLyrics() { return { lrc: '' }; },
  async getPref() { return null; },
  async setPref() { return true; },
  async savePlayQueue() { return true; },
  async trayUpdatePlayState() { return null; },
  async syncMiniPlayer() { return null; },
  async syncDesktopLyric() { return null; },
};

function audible() {
  return audios.find((a) => !a.paused && !a.muted && a.volume > 0 && a.src) || null;
}

async function waitFor(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (fn()) return;
    await delay(5);
  }
  throw new Error('timeout: ' + label + (player.error ? `（player.error=${player.error}）` : ''));
}

const { isProxy, reactive } = await import('vue');
const { player, playFromList, playSong } = await import('../src/renderer/app/stores/player.ts');

const DUP = 'netease\u241f1';

function searchSong(id) {
  return reactive({
    id,
    source: 'qq',
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 269000,
    cover: '',
    pay: { payplay: 1 },
    _dupOf: [DUP],
    _altSource: { source: 'netease', id: '186016' },
    _crossSource: true,
  });
}

function assertNotProxy(song) {
  assert.equal(isProxy(song), false, '送过 IPC 的歌曲不能仍是代理');
  assert.equal(isProxy(song.pay), false, 'pay 必须是普通对象');
  assert.equal(isProxy(song._dupOf), false, '_dupOf 必须是普通数组');
  assert.equal(isProxy(song._altSource), false, '_altSource 必须是普通对象');
}

function assertSearchFields(cloned) {
  assert.equal(cloned.pay.payplay, 1);
  assert.deepEqual(cloned._dupOf, [DUP]);
  assert.deepEqual(cloned._altSource, { source: 'netease', id: '186016' });
  assert.equal(cloned.source, 'qq');
  assert.equal(cloned.title, '晴天');
  assert.equal(cloned.artist, '周杰伦');
  assert.equal(cloned.duration, 269000);
}

function clonedById(id) {
  return payloads.filter((p) => p.cloned && p.cloned.id === id);
}

// 当前这首走 normalizeSong 展开；下一首由 skipPrep 把队列里的代理根本身送去取流。
const playing = playFromList([searchSong('q1'), searchSong('q2')], 0);
await waitFor(() => clonedById('q1').length >= 1 && clonedById('q2').length >= 1, '搜索歌和预取邻居都完成克隆');
await playing;
await waitFor(() => player.current && player.current.id === 'q1' && audible() && String(audible().src).includes('lanyue-stream://q1'), '搜索结果出声');
assert.equal(player.error, '');

for (const id of ['q1', 'q2']) {
  const hit = clonedById(id)[0];
  assertNotProxy(hit.song);
  assertSearchFields(hit.cloned);
  assertSearchFields(hit.song);
}
assert.equal(player.queueIdx, 0, 'q2 只能来自预取，不能已经切过去');

// 发现页歌曲只有基本类型，克隆后仍要能播。
const discover = reactive({
  id: 'd1',
  source: 'netease',
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  albumMid: '123',
  cover: '',
  duration: 269000,
});
await playFromList([discover], 0);
await waitFor(() => clonedById('d1').length >= 1 && player.current && player.current.id === 'd1' && audible() && String(audible().src).includes('lanyue-stream://d1'), '发现页歌曲出声');
assert.equal(player.error, '');
const disc = clonedById('d1')[0];
assert.equal(isProxy(disc.song), false);
assert.equal(disc.cloned.albumMid, '123');
assert.equal(disc.cloned.source, 'netease');
assert.equal(disc.cloned.title, '晴天');
assert.equal(disc.song.pay, undefined);

// 函数字段必须丢掉，调用本身不能抛，其余搜索字段还在。
function sneak() { return 'nope'; }
const funky = reactive({
  id: 'fn',
  source: 'qq',
  title: '带函数',
  artist: '测试',
  duration: 1000,
  pay: { payplay: 1 },
  _dupOf: [DUP],
  _altSource: { source: 'netease', id: '186016' },
  notCloneable: sneak,
});
funky.self = funky;
await playSong(funky);
await waitFor(() => clonedById('fn').length >= 1 && player.current && player.current.id === 'fn' && audible() && String(audible().src).includes('lanyue-stream://fn'), '带函数的歌出声');
assert.equal(player.error, '');
const fnHit = clonedById('fn')[0];
assert.equal(isProxy(fnHit.song), false);
assert.equal(Object.hasOwn(fnHit.cloned, 'notCloneable'), false);
assert.equal(Object.hasOwn(fnHit.song, 'notCloneable'), false);
assert.equal(fnHit.cloned.pay.payplay, 1);
assert.deepEqual(fnHit.cloned._dupOf, [DUP]);
assert.deepEqual(fnHit.cloned._altSource, { source: 'netease', id: '186016' });
assert.equal(typeof fnHit.cloned.self, 'object');
assert.equal(fnHit.cloned.self.self, fnHit.cloned.self, '循环引用要收成普通对象的环，不能撑爆栈');

console.log('player clone ipc runner ok');
