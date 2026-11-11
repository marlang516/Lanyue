/**
 * 生产播放器切歌时序（stores/player.ts）。
 *
 * 用假 audio 元素和假 IPC 把「点下一首 → 出声」跑一遍：
 * 下一首的取流必须在点击之前已经开始，点下去播的是已经挂上 src 的那个元素，
 * 而不是再等一轮 getDownloadUrlSmart + proxyPlay。
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./esm-ts-resolve.mjs', import.meta.url).href, {
  parentURL: import.meta.url,
});

const RESOLVE_MS = 180;
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

const calls = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

g.window.__LY_MOCK__ = {
  async getDownloadUrlSmart(song, quality) {
    const rec = { op: 'url', id: String(song.id), quality, at: Date.now() };
    calls.push(rec);
    await delay(RESOLVE_MS);
    if (song.id === 'bad') return { error: '无版权' };
    return {
      url: `https://cdn.example/${song.id}.mp3`,
      source: song.source,
      id: song.id,
    };
  },
  async proxyPlay(url, _referer, refresh) {
    const id = String(url).split('/').pop().replace('.mp3', '');
    const quality = refresh && refresh.quality ? refresh.quality : '';
    calls.push({ op: 'proxy', id, quality, at: Date.now() });
    await delay(20);
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

function urlCalls(id, quality) {
  return calls.filter((c) => c.op === 'url' && c.id === id && (!quality || c.quality === quality));
}

function audible() {
  return audios.find((a) => !a.paused && !a.muted && a.volume > 0 && a.src) || null;
}

async function waitFor(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (fn()) return;
    await delay(5);
  }
  throw new Error('timeout: ' + label);
}

const { player, playFromList, playSong, next, prev, togglePlay, seekTo, setQuality } = await import('../src/renderer/app/stores/player.ts');

const queue = [song('a'), song('b'), song('c')];
const playing = playFromList(queue, 0);
await delay(15);
assert.ok(urlCalls('b').length >= 1, '播放 a 时就该开始取 b，不能等到点击下一首');
assert.ok(Math.abs(urlCalls('a')[0].at - urlCalls('b')[0].at) < 30, '当前歌和下一首应并行取流');
const earlyNextAt = Date.now();
next();
assert.ok(urlCalls('b')[0].at < earlyNextAt, 'b 的取流必须早于点击');

await playing;
await waitFor(() => player.current && player.current.id === 'b' && audible() && audible().src.includes('lanyue-stream://b'), '切到 b');
assert.equal(urlCalls('b').length, 1, '提前点下一首必须接上同一次在飞请求，不能再取一遍');
assert.equal(audible().src, 'lanyue-stream://b?q=standard');

await waitFor(() => audios.some((a) => a.src.includes('lanyue-stream://c') && a.playCount >= 1), '预热 c');
const primed = audios.find((a) => a.src.includes('lanyue-stream://c'));
const callsBefore = calls.length;
const t0 = Date.now();
next();
await waitFor(() => player.current && player.current.id === 'c' && audible() === primed, '预热过的 c 成为正在听的元素');
const elapsed = Date.now() - t0;
assert.equal(calls.length, callsBefore, '已经预热的下一首不应再 getDownloadUrlSmart / proxyPlay');
assert.ok(elapsed < RESOLVE_MS / 2, `预热命中的切歌花了 ${elapsed}ms，仍在等取流`);
assert.equal(primed.muted, false);
assert.ok(primed.volume > 0);

const parkedB = audios.find((a) => a.src.includes('lanyue-stream://b'));
const bUrls = urlCalls('b').length;
prev();
await waitFor(() => player.current && player.current.id === 'b' && audible() === parkedB, '回到已经缓冲的 b');
assert.equal(urlCalls('b').length, bUrls, '上一首还在缓冲里，不应重新取流');

togglePlay();
await Promise.resolve();
assert.equal(audible(), null, '暂停的是正在听的那一个元素');
const paused = audios.find((a) => a.src.includes('lanyue-stream://b') && a.paused);
assert.ok(paused, '上一首的元素应处于暂停');
togglePlay();
await waitFor(() => audible() && audible().src.includes('lanyue-stream://b'), '恢复播放');
seekTo(12);
assert.equal(audible().currentTime, 12);
assert.equal(player.progress, 12);

setQuality('hq');
await waitFor(() => urlCalls('c', 'hq').length >= 1, '换音质后按新音质预取下一首');
const hqCalls = urlCalls('c', 'hq').length;
next();
await waitFor(() => player.current && player.current.id === 'c' && audible() && audible().src.includes('q=hq'), '换音质后的下一首');
assert.equal(urlCalls('c', 'hq').length, hqCalls, '音质预取已经在飞，点击不能再取一遍');

player.error = '';
await playSong(song('bad'));
await waitFor(() => player.error, '坏链错误');
assert.match(String(player.error), /无版权/);
assert.equal(player.loading, false);

const beforeLocal = calls.filter((c) => c.op === 'url').length;
await playFromList([
  song('l1', { source: 'local', filePath: '/music/one.mp3' }),
  song('l2', { source: 'local', filePath: '/music/two #1.mp3' }),
], 0);
await waitFor(() => audios.some((a) => String(a.src).includes('%23')), '本地下一首预热');
const localCalls = calls.filter((c) => c.op === 'url').length;
assert.equal(localCalls, beforeLocal, '本地文件切歌不该走在线取流');
const localPrimed = audios.find((a) => String(a.src).includes('%23'));
next();
await waitFor(() => audible() === localPrimed, '本地下一首直接用预热元素');
assert.equal(calls.filter((c) => c.op === 'url').length, beforeLocal);
assert.ok(String(audible().src).startsWith('file://'));

console.log('player skip latency runner ok');
