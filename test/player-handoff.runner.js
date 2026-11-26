/**
 * 生产播放器的单源交接。
 * 假元素 + 假 IPC。交接打开时预热不可闻，切歌只有一路出声；
 * 关掉之后原来的重叠交叉还在。
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./esm-ts-resolve.mjs', import.meta.url).href, {
  parentURL: import.meta.url,
});

const RESOLVE_MS = 40;
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
    this.ended = false;
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
    if (type === 'ended') this.ended = true;
    for (const fn of this.listeners.get(type) || []) fn();
  }

  play() {
    this.paused = false;
    this.ended = false;
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
const clock = { now: 0, manual: true };
g.__LY_CROSSFADE_CLOCK__ = clock;

const session = {
  metadata: null,
  playbackState: 'none',
  setActionHandler() {},
};
g.navigator.mediaSession = session;
g.MediaMetadata = class MediaMetadata {
  constructor(init) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
    this.artwork = init.artwork;
  }
};

const calls = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

g.window.__LY_MOCK__ = {
  async getDownloadUrlSmart(song) {
    calls.push({ op: 'url', id: String(song.id), at: Date.now() });
    await delay(RESOLVE_MS);
    if (song.id === 'bad' || String(song.id).startsWith('bad')) return { error: '无版权' };
    return { url: `https://cdn.example/${song.id}.mp3`, source: song.source, id: song.id };
  },
  async proxyPlay(url, _referer, refresh) {
    const id = String(url).split('/').pop().replace('.mp3', '');
    const quality = refresh && refresh.quality ? refresh.quality : '';
    calls.push({ op: 'proxy', id, quality, at: Date.now() });
    await delay(5);
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

function song(id, extra = {}) {
  return { id, source: 'netease', title: '歌曲' + id, artist: '测试', duration: 180000, ...extra };
}

function urlCalls(id) {
  return calls.filter((c) => c.op === 'url' && c.id === id);
}

function elOf(id) {
  return audios.find((a) => String(a.src).includes('lanyue-stream://' + id));
}

function unpaused() {
  return audios.filter((a) => a.src && !a.paused);
}

function audible() {
  return audios.filter((a) => a.src && !a.paused && a.muted !== true && a.volume > 0.001);
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.02, `${label}: ${actual} !~ ${expected}`);
}

async function waitFor(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (fn()) return;
    await delay(5);
  }
  throw new Error('timeout: ' + label);
}

const {
  player, playFromList, next, setCrossfadeMs, setSingleSourceHandoff, pumpCrossfade,
} = await import('../src/renderer/app/stores/player.ts');

setSingleSourceHandoff(true);
assert.equal(player.singleSourceHandoff, true);
assert.equal(player.crossfadeMs, 0, '打开交接不改交叉档位');

await playFromList([song('a'), song('b'), song('c')], 0);
await waitFor(() => {
  const b = elOf('b');
  return b && b.playCount >= 1 && b.paused && player.current && player.current.id === 'a';
}, '预热 b');
const warmB = elOf('b');
assert.equal(warmB.muted, true, '预热的下一首保持静音');
near(warmB.volume, 0, '预热增益是 0');
assert.equal(elOf('a').paused, false);
assert.equal(elOf('a').muted, false);
assert.equal(audible().length, 1, '预热时只有正在听的那首出声');
assert.equal(session.metadata && session.metadata.title, '歌曲a');

const callsBefore = urlCalls('b').length;
next();
await Promise.resolve();
assert.equal(player.current.id, 'b', '交接立刻换成下一首');
assert.equal(session.metadata.title, '歌曲b');
assert.equal(elOf('a').paused, true);
assert.equal(elOf('a').muted, true);
assert.equal(elOf('b').paused, false);
assert.equal(elOf('b').muted, false);
near(elOf('b').volume, player.volume, '进来的歌是用户音量');
near(elOf('a').volume, 0, '出去的歌不再出声');
assert.equal(unpaused().length, 1);
assert.equal(audible().length, 1);
assert.equal(urlCalls('b').length, callsBefore, '已经预热的下一首不能再取流');

await waitFor(() => elOf('c') && elOf('c').paused && elOf('c').playCount >= 1, '预热 c');
elOf('b').currentTime = 175;
elOf('b').emit('timeupdate');
await Promise.resolve();
assert.equal(player.current.id, 'b', '离结尾还远时自动交接不启动');
assert.equal(audible().length, 1);

elOf('b').currentTime = 179.2;
elOf('b').emit('timeupdate');
await Promise.resolve();
assert.equal(player.current.id, 'c', '走进提前量窗口才自动交接');
assert.equal(elOf('b').paused, true);
assert.equal(elOf('b').muted, true);
assert.equal(elOf('c').paused, false);
assert.equal(audible().length, 1, '自动交接也不能两路一起响');

setCrossfadeMs(2000);
assert.equal(player.crossfadeMs, 2000);
assert.equal(player.singleSourceHandoff, true, '交叉档位和交接开关各记各的');
await playFromList([song('d'), song('e')], 0);
await waitFor(() => elOf('e') && elOf('e').paused && player.current.id === 'd', '预热 e');
next();
await Promise.resolve();
assert.equal(player.current.id, 'e', '交接打开时即使交叉档位开着也不重叠');
assert.equal(unpaused().length, 1);
assert.equal(elOf('d').muted, true);

setSingleSourceHandoff(false);
assert.equal(player.crossfadeMs, 2000, '关掉交接后交叉档位还在');
await playFromList([song('f'), song('g')], 0);
await waitFor(() => elOf('g') && elOf('g').paused && player.current.id === 'f', '预热 g');
clock.now = 0;
next();
await Promise.resolve();
assert.equal(player.current.id, 'f', '关掉交接后回到重叠交叉');
assert.equal(unpaused().length, 2);
assert.equal(elOf('f').muted, false);
assert.equal(elOf('g').muted, false);
pumpCrossfade(2000);
await Promise.resolve();
assert.equal(player.current.id, 'g');
assert.equal(unpaused().length, 1);

setSingleSourceHandoff(true);
setCrossfadeMs(0);
await playFromList([song('h'), song('i')], 0);
await waitFor(() => elOf('i') && elOf('i').paused && player.current.id === 'h', '预热 i');
elOf('h').currentTime = 180 - 0.04;
next();
await Promise.resolve();
assert.equal(player.current.id, 'i', '剩余太短则硬切');
assert.equal(unpaused().length, 1);
assert.equal(audible().length, 1);

await playFromList([song('j'), song('k'), song('m')], 0);
await waitFor(() => elOf('k') && elOf('k').paused && player.current.id === 'j', '预热 k');
player.mode = 'shuffle';
const beforeShuffle = player.current.id;
next();
await Promise.resolve();
assert.notEqual(player.current.id, beforeShuffle);
assert.equal(audible().length <= 1, true, '随机模式即使撞上已缓冲的歌也只留一路');
assert.equal(unpaused().length <= 1, true);

player.mode = 'order';
const cold = playFromList([song('n'), song('o')], 0);
await cold;
next();
await waitFor(() => player.current && player.current.id === 'o' && audible().length === 1, '没预热好就硬切');
assert.equal(unpaused().length, 1);

console.log('player handoff runner ok');
