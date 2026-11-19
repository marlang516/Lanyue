/**
 * 生产播放器的无缝交叉（stores/player.ts）。
 *
 * 假元素 + 假 IPC，时钟由 __LY_CROSSFADE_CLOCK__ 手动推进，
 * 这样中点换媒体键、增益和中途收掉都不靠真实等待。
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
  player, playFromList, next, togglePlay, seekTo, setVolume, setCrossfadeMs, pumpCrossfade,
} = await import('../src/renderer/app/stores/player.ts');

const FADE = 2000;
const MID = 1000;
setCrossfadeMs(FADE);
assert.equal(player.crossfadeMs, FADE);

const queue = [song('a'), song('b'), song('c')];
const playing = playFromList(queue, 0);
await playing;
await waitFor(() => {
  const b = elOf('b');
  return b && b.playCount >= 1 && b.paused && player.current && player.current.id === 'a';
}, '预热 b');
assert.equal(session.metadata && session.metadata.title, '歌曲a');

clock.now = 0;
const callsBefore = urlCalls('b').length;
next();
const elA = elOf('a');
const elB = elOf('b');
assert.ok(elA && elB);
assert.equal(player.current.id, 'a', '交叉刚开始不能换成下一首');
assert.equal(session.metadata.title, '歌曲a', '媒体键要等到交叉中点');
assert.equal(elA.paused, false);
assert.equal(elB.paused, false, '进来的歌要和出去的歌同时响');
near(elA.volume, player.volume, '出去的歌起点是用户音量');
near(elB.volume, 0, '进来的歌起点静音');
assert.equal(urlCalls('b').length, callsBefore, '已经缓好的下一首不能再取流');

pumpCrossfade(MID - 1);
assert.equal(player.current.id, 'a');
assert.equal(session.metadata.title, '歌曲a');
const outGain = 1 - (MID - 1) / FADE;
const inGain = (MID - 1) / FADE;
near(elA.volume, player.volume * outGain, '淡出增益');
near(elB.volume, player.volume * inGain, '淡入增益');
near(elA.volume + elB.volume, player.volume, '两路增益互补');

setVolume(0.5);
near(elA.volume, 0.5 * outGain, '滑条要按当前增益立刻作用在出去的歌上');
near(elB.volume, 0.5 * inGain, '滑条要按当前增益立刻作用在进来的歌上');
setVolume(0.8);

pumpCrossfade(MID);
assert.equal(player.current.id, 'b', '中点才换当前曲');
assert.equal(session.metadata.title, '歌曲b', '媒体键在中点切换');
assert.equal(elA.paused, false, '中点之后出去的歌还在淡出');
assert.equal(elB.paused, false);

elA.ended = true;
elA.emit('pause');
elA.emit('ended');
await Promise.resolve();
assert.equal(player.current.id, 'b', '出走元素 ended 不能再推进一首');
assert.notEqual(player.queueIdx, 2);

pumpCrossfade(FADE);
await Promise.resolve();
assert.equal(player.current.id, 'b');
assert.equal(elB.paused, false);
assert.equal(elA.paused, true, '交叉结束要停掉出去的歌');
near(elB.volume, player.volume, '进来的歌收在用户音量');
near(elA.volume, 0, '出去的歌收在静音');
assert.equal(unpaused().length, 1);

await waitFor(() => {
  const c = elOf('c');
  return c && c.playCount >= 1 && c.paused;
}, '预热 c');

clock.now = 0;
next();
assert.equal(player.current.id, 'b');
assert.equal(elOf('c').paused, false);
pumpCrossfade(400);
togglePlay();
await Promise.resolve();
assert.equal(player.playing, false);
assert.equal(player.current.id, 'b', '中点前暂停要留在出去的歌');
assert.equal(elOf('b').paused, true);
assert.equal(elOf('c').paused, true);
near(elOf('b').volume, player.volume, '暂停后留下的那首恢复满增益');
near(elOf('c').volume, 0, '被收掉的那首不能停在半音量');
assert.equal(unpaused().length, 0);

togglePlay();
await waitFor(() => elOf('b') && !elOf('b').paused, '恢复 b');
clock.now = 0;
next();
assert.equal(unpaused().length, 2);
seekTo(30);
await Promise.resolve();
assert.equal(player.current.id, 'b');
assert.equal(elOf('b').currentTime, 30);
assert.equal(elOf('b').paused, false);
assert.equal(elOf('c').paused, true);
near(elOf('c').volume, 0);
assert.equal(unpaused().length, 1, 'seek 之后不能两路一起放');

await playFromList([song('p'), song('q'), song('r')], 0);
await waitFor(() => elOf('q') && elOf('q').paused && player.current && player.current.id === 'p', '预热 q');
clock.now = 0;
next();
assert.equal(player.current.id, 'p', '交叉起点仍是出去的歌');
assert.equal(unpaused().length, 2);
next();
await waitFor(() => player.current && player.current.id === 'r' && unpaused().length === 1, '交叉中途再切到 r');
assert.ok(String(unpaused()[0].src).includes('lanyue-stream://r'));
for (const el of [elOf('p'), elOf('q')]) {
  if (!el || el === unpaused()[0]) continue;
  assert.equal(el.paused, true, '被跳过的歌不能继续响');
  near(el.volume, 0, '被跳过的歌不能停在半音量');
}

setCrossfadeMs(0);
assert.equal(player.crossfadeMs, 0);
await playFromList([song('d'), song('e')], 0);
await waitFor(() => {
  const e = elOf('e');
  return e && e.paused && e.playCount >= 1 && player.current && player.current.id === 'd';
}, '预热 e');
const eBefore = urlCalls('e').length;
clock.now = 0;
next();
await Promise.resolve();
assert.equal(player.current.id, 'e', '关闭交叉时立刻换歌');
assert.equal(elOf('d').paused, true);
assert.equal(unpaused().length, 1);
assert.equal(urlCalls('e').length, eBefore);

setCrossfadeMs(FADE);
await playFromList([song('f'), song('g')], 0);
await waitFor(() => elOf('g') && elOf('g').paused && player.current.id === 'f', '预热 g');
elOf('f').currentTime = 180 - 0.04;
clock.now = 0;
next();
await Promise.resolve();
assert.equal(player.current.id, 'g', '剩余太短则硬切');
assert.equal(elOf('f').paused, true);
assert.equal(unpaused().length, 1);

await playFromList([song('h'), song('i'), song('j')], 0);
await waitFor(() => elOf('i') && elOf('i').paused && player.current.id === 'h', '预热 i');
player.mode = 'shuffle';
clock.now = 0;
const beforeShuffle = player.current.id;
next();
await Promise.resolve();
assert.notEqual(player.current.id, beforeShuffle);
assert.equal(unpaused().length <= 1, true, '随机模式即使撞上已缓冲的歌也硬切');
const stillPlaying = unpaused();
if (stillPlaying.length === 1) {
  const other = [elOf('h'), elOf('i'), elOf('j')].filter((el) => el && el !== stillPlaying[0]);
  for (const el of other) {
    if (!el.paused) assert.fail('随机硬切不能留下第二路');
  }
}

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
assert.equal(player.current && player.mode, 'single');
const after = unpaused();
assert.equal(after.length, 1);
assert.equal(after[0].src, singleSrc, '单曲循环重播同一条流');
assert.equal(after[0].currentTime, 0);

player.mode = 'order';
setCrossfadeMs(FADE);
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

console.log('player crossfade runner ok');
