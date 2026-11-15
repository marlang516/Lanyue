/**
 * Vue 播放器：窗口打开后来要状态时，必须推整份迷你播放器 / 桌面歌词载荷。
 *
 * 旧层在 app.js 里听 onSyncMiniPlayer / onSyncDesktopLyric，先清换曲标记再全量推。
 * Vue store 若只靠 timeupdate，后到的帧没有 title / cover / lyrics，透明窗口像没打开。
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { nextTick } from 'vue';

register(new URL('./esm-ts-resolve.mjs', import.meta.url).href, {
  parentURL: import.meta.url,
});

const g = globalThis;
g.window = g;
if (!g.navigator) g.navigator = {};

class FakeAudio {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.paused = true;
    this.preload = '';
    this.error = null;
    this.listeners = new Map();
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener() {}

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  load() {}

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

g.Audio = FakeAudio;

const miniPayloads = [];
const desktopPayloads = [];
const handlers = {};

g.window.__LY_MOCK__ = {
  onSyncMiniPlayer(cb) { handlers.mini = cb; },
  onSyncDesktopLyric(cb) { handlers.desktop = cb; },
  onMiniNext(cb) { handlers.next = cb; },
  onMiniPrev(cb) { handlers.prev = cb; },
  onMiniTogglePlay(cb) { handlers.toggle = cb; },
  async syncMiniPlayer(payload) { miniPayloads.push(structuredClone(payload)); },
  async syncDesktopLyric(payload) { desktopPayloads.push(structuredClone(payload)); },
  async trayUpdatePlayState() { return null; },
  async getPref() { return null; },
  async setPref() { return true; },
  async savePlayQueue() { return true; },
  async getLyrics() { return { lrc: '' }; },
  async getDownloadUrlSmart() { return { error: '测试不取流' }; },
};

const { player, initOutputSync, forceSyncOutputs } = await import('../src/renderer/app/stores/player.ts');
const { lyrics } = await import('../src/renderer/app/stores/lyrics.ts');

initOutputSync();
initOutputSync();
assert.equal(typeof handlers.mini, 'function', '未订阅 onSyncMiniPlayer');
assert.equal(typeof handlers.desktop, 'function', '未订阅 onSyncDesktopLyric');
assert.equal(typeof handlers.next, 'function');
assert.equal(typeof handlers.prev, 'function');
assert.equal(typeof handlers.toggle, 'function');

const song = {
  id: '42',
  source: 'netease',
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  cover: 'https://img.example/cover.jpg',
  duration: 200000,
  lossless: false,
};
player.current = song;
player.duration = 200;
player.progress = 30;
player.quality = 'hq';
player.queue = [
  song,
  { ...song, id: '43', title: '七里香', cover: '' },
];
player.queueIdx = 0;
player.mode = 'order';
lyrics.items = [
  { t: 12, text: '故事的小黄花' },
  { t: 28, text: '从出生那年就飘着' },
];
player.playing = true;
await nextTick();

assert.ok(miniPayloads.length >= 1, '播放态变化后应推过迷你播放器');
const partialMini = miniPayloads.at(-1);
assert.equal(partialMini.title, undefined, '同曲后续帧不应带标题，否则测不到「窗口打开强制全量」');
assert.equal(partialMini.cover, undefined);
assert.equal(partialMini.playing, true);
assert.equal(typeof partialMini.progress, 'number');
assert.equal(typeof partialMini.time, 'string');
const partialDesktop = desktopPayloads.at(-1);
assert.equal(partialDesktop.lyrics, undefined, '同曲后续帧不应带整份歌词');
assert.equal(typeof partialDesktop.currentTime, 'number');
assert.equal(partialDesktop.title, undefined);

const miniCount = miniPayloads.length;
const desktopCount = desktopPayloads.length;
handlers.mini();
assert.equal(miniPayloads.length, miniCount + 1, '重复订阅会把同一次窗口请求推两遍');
assert.equal(desktopPayloads.length, desktopCount + 1);

const fullMini = miniPayloads.at(-1);
assert.equal(fullMini.title, '晴天');
assert.equal(fullMini.artist, '周杰伦');
assert.equal(fullMini.cover, 'https://img.example/cover.jpg');
assert.equal(fullMini.quality, 'hq');
assert.equal(fullMini.playing, true);
assert.equal(typeof fullMini.progress, 'number');
assert.equal(typeof fullMini.lyric, 'string');
assert.match(fullMini.time, /\d+:\d{2} \/ \d+:\d{2}/);

const fullDesktop = desktopPayloads.at(-1);
assert.equal(fullDesktop.title, '晴天');
assert.equal(typeof fullDesktop.currentTime, 'number');
assert.ok(Array.isArray(fullDesktop.lyrics), '桌面歌词窗口需要整份歌词，不能只有 currentTime');
assert.equal(fullDesktop.lyrics.length, 2);
assert.deepEqual(fullDesktop.lyrics[0], {
  t: 12, text: '故事的小黄花', subText: '', words: [], wordTimes: [],
});
assert.equal(fullDesktop.lyrics[1].text, '从出生那年就飘着');

handlers.desktop();
const again = desktopPayloads.at(-1);
assert.equal(again.title, '晴天');
assert.equal(again.lyrics.length, 2);
assert.equal(miniPayloads.at(-1).title, '晴天');
assert.equal(miniPayloads.at(-1).artist, '周杰伦');
assert.equal(miniPayloads.at(-1).cover, 'https://img.example/cover.jpg');

player.playing = false;
await nextTick();
assert.equal(miniPayloads.at(-1).title, undefined, '播放态变化仍只推进度');
forceSyncOutputs();
assert.equal(miniPayloads.at(-1).title, '晴天', '播放条打开窗口后的强制同步要带元信息');
assert.equal(miniPayloads.at(-1).cover, 'https://img.example/cover.jpg');
assert.equal(desktopPayloads.at(-1).lyrics.length, 2);
assert.equal(desktopPayloads.at(-1).title, '晴天');

handlers.next();
assert.equal(player.queueIdx, 1, '迷你播放器下一首应走到队列里的下一首');
handlers.prev();
assert.equal(player.queueIdx, 0, '迷你播放器上一首应回到上一首');

console.log('player output sync runner ok');
