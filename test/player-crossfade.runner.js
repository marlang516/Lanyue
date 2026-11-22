/**
 * 生产播放器切歌（stores/player.ts）。
 *
 * 交叉档位开着也必须立刻硬切。假元素 + 假 IPC。
 * __LY_CROSSFADE_CLOCK__.allowFade 只在「交叉已经开始再按下一首/上一首」
 * 那一组里打开，用来钉住不会两路一起停、也不会跳过正在进来的那首。
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
const clock = { now: 0, manual: true, allowFade: false };
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
  player, playFromList, next, prev, setCrossfadeMs,
} = await import('../src/renderer/app/stores/player.ts');

const FADE = 2000;
setCrossfadeMs(FADE);
assert.equal(player.crossfadeMs, FADE);
assert.equal(clock.allowFade, false);

const queue = [song('a'), song('b'), song('c')];
await playFromList(queue, 0);
await waitFor(() => {
  const b = elOf('b');
  return b && b.playCount >= 1 && b.paused && player.current && player.current.id === 'a';
}, '预热 b');
assert.equal(session.metadata && session.metadata.title, '歌曲a');

const callsBefore = urlCalls('b').length;
const elA = elOf('a');
next();
const elB = elOf('b');
assert.ok(elA && elB);
assert.equal(player.current.id, 'b', '已经预热的下一首立刻换成它');
assert.equal(session.metadata.title, '歌曲b', '媒体键跟着硬切，不再等交叉中点');
assert.equal(elA.paused, true, '出去的歌马上停');
assert.equal(elB.paused, false, '进来的歌马上在放');
assert.equal(elB.muted, false);
near(elB.volume, player.volume, '进来的歌是满音量，不是从静音淡入');
assert.equal(unpaused().length, 1, '硬切不能两路一起放');
assert.equal(urlCalls('b').length, callsBefore, '已经缓好的下一首不能再取流');

await waitFor(() => {
  const c = elOf('c');
  return c && c.playCount >= 1 && c.paused;
}, '预热 c');
const cBefore = urlCalls('c').length;
next();
assert.equal(player.current.id, 'c');
assert.equal(elOf('b').paused, true);
assert.equal(elOf('c').paused, false);
assert.equal(elOf('c').muted, false);
near(elOf('c').volume, player.volume, '再切一首仍然是满音量硬切');
assert.equal(unpaused().length, 1);
assert.equal(urlCalls('c').length, cBefore);

const bParked = elOf('b');
prev();
assert.equal(player.current.id, 'b', '上一首已经在缓冲里，立刻切回去');
assert.equal(bParked.paused, false);
assert.equal(elOf('c').paused, true);
near(bParked.volume, player.volume, '上一首也是满音量硬切');
assert.equal(unpaused().length, 1);
await waitFor(() => player.loading === false && player.current.id === 'b', '切回 b 完成');

const tail = elOf('b');
tail.currentTime = 180 - 1.5;
for (let n = 0; n < 12; n += 1) tail.emit('timeupdate');
await Promise.resolve();
assert.equal(player.current.id, 'b', '走到曲尾窗口也不能提前重叠');
assert.equal(tail.paused, false);
assert.equal(elOf('c').paused, true, '自动连播在结束前不能把下一首拉起来');
assert.equal(unpaused().length, 1);
tail.emit('ended');
assert.equal(player.current.id, 'c', '自然结束是硬切到下一首');
assert.equal(tail.paused, true);
assert.equal(elOf('c').paused, false);
assert.equal(elOf('c').muted, false);
near(elOf('c').volume, player.volume, '自然结束也不是从静音淡入');
assert.equal(unpaused().length, 1);

await playFromList([song('h'), song('i'), song('j')], 0);
await waitFor(() => elOf('i') && elOf('i').paused && player.current.id === 'h', '预热 i');
player.mode = 'shuffle';
const beforeShuffle = player.current.id;
next();
await waitFor(() => {
  const one = unpaused();
  return player.current
    && player.current.id !== beforeShuffle
    && one.length === 1
    && String(one[0].src).includes('lanyue-stream://' + player.current.id);
}, '随机硬切完成');
assert.equal(unpaused().length, 1, '随机模式硬切，不能留下第二路');

player.mode = 'single';
const singleEl = unpaused()[0] || elOf('h');
assert.ok(singleEl && singleEl.src);
if (singleEl.paused) {
  await singleEl.play();
  await Promise.resolve();
}
singleEl.currentTime = 12;
const singleSrc = singleEl.src;
singleEl.emit('ended');
await Promise.resolve();
assert.equal(player.mode, 'single');
const afterSingle = unpaused();
assert.equal(afterSingle.length, 1);
assert.equal(afterSingle[0].src, singleSrc, '单曲循环重播同一条流');
assert.equal(afterSingle[0].currentTime, 0);

player.mode = 'order';
await playFromList([song('p1'), song('q1'), song('r1')], 0);
await waitFor(() => elOf('q1') && elOf('q1').paused && player.current && player.current.id === 'p1', '预热 q1');
clock.allowFade = true;
clock.now = 0;
const qUrls = urlCalls('q1').length;
next();
const pEl = elOf('p1');
const qEl = elOf('q1');
assert.equal(player.current.id, 'p1', '测试交叉刚开始时标题还是出去的歌');
assert.equal(pEl.paused, false);
assert.equal(qEl.paused, false);
near(qEl.volume, 0, '交叉起点进来的歌仍是静音');
next();
assert.equal(player.current.id, 'q1', '交叉途中再按下一首落在正在进来的那首');
assert.notEqual(player.current.id, 'r1', '不能跳过正在进来的那首');
assert.equal(qEl.paused, false, '进来的歌不能先被停掉');
assert.equal(qEl.muted, false);
near(qEl.volume, player.volume, '进来的歌立刻满音量，中间没有两路都静音');
assert.equal(pEl.paused, true);
assert.equal(unpaused().length, 1);
assert.equal(urlCalls('q1').length, qUrls, '落在已经进来的那首，不能再取一次流');
assert.equal(player.queueIdx, 1);

await playFromList([song('p2'), song('q2'), song('r2')], 0);
await waitFor(() => elOf('q2') && elOf('q2').paused && player.current.id === 'p2', '预热 q2');
clock.allowFade = true;
next();
assert.equal(player.current.id, 'p2');
assert.equal(unpaused().length, 2);
prev();
assert.equal(player.current.id, 'q2', '交叉途中再按上一首也落在正在进来的那首');
assert.equal(elOf('q2').paused, false);
assert.equal(elOf('q2').muted, false);
near(elOf('q2').volume, player.volume, '上一首也不能把两路都停掉');
assert.equal(elOf('p2').paused, true);
assert.equal(unpaused().length, 1);
assert.notEqual(player.current.id, 'r2');
clock.allowFade = false;

const storm = playFromList([song('k'), song('bad-next')], 0);
await storm;
await waitFor(() => urlCalls('bad-next').length >= 1, '坏下一首尝试过一次');
await delay(RESOLVE_MS + 30);
const failed = urlCalls('bad-next').length;
const elK = elOf('k');
assert.ok(elK);
elK.currentTime = 180 - 1.6;
for (let n = 0; n < 30; n += 1) elK.emit('timeupdate');
await delay(20);
assert.equal(urlCalls('bad-next').length, failed, '预载失败后逐帧 timeupdate 不能再打音源');
assert.equal(player.current.id, 'k');
assert.equal(elK.paused, false, '曲尾时间更新不能把当前这首停掉');

console.log('player crossfade runner ok');
