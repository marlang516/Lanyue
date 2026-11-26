/**
 * 生产播放器：徽章状态、一键换源、失败人话。
 * 假 audio + 假 IPC，不触网。
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

const calls = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

g.window.__LY_MOCK__ = {
  async getDownloadUrlSmart(song, _quality, options) {
    calls.push({
      id: String(song.id),
      source: song.source,
      avoid: options && options.avoidSource,
      allow: options && options.allowToggleSource,
    });
    if (song.id === 'bad') return { code: 'VIP_REQUIRED', error: 'VIP_REQUIRED' };
    if (options && options.avoidSource === 'kuwo' && song.id === '1') {
      return { code: 'COPYRIGHT_RESTRICTED', error: 'COPYRIGHT_RESTRICTED' };
    }
    if (options && options.avoidSource === 'netease' && song.id === '1') {
      return {
        url: 'https://cdn.example/kuwo.mp3',
        source: 'kuwo',
        id: 'k1',
        matchedSong: { source: 'kuwo', id: 'k1' },
        matchedFrom: 'netease',
      };
    }
    if (song.id === 'from-migu') {
      return {
        url: 'https://cdn.example/migu.mp3',
        source: 'migu',
        id: 'm1',
        matchedSong: { source: 'migu', id: 'm1' },
        matchedFrom: song.source,
      };
    }
    return { url: `https://cdn.example/${song.id}.mp3`, source: song.source, id: song.id };
  },
  async proxyPlay(url) {
    const id = String(url).split('/').pop().replace('.mp3', '');
    return { fileUrl: `lanyue-stream://${id}` };
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
  return { id, source: 'netease', title: '晴天', artist: '周杰伦', duration: 180000, ...extra };
}

async function waitFor(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (fn()) return;
    await delay(5);
  }
  throw new Error('timeout: ' + label + (player.error ? `（player.error=${player.error}）` : ''));
}

const { player, playSong, switchPlaySource } = await import('../src/renderer/app/stores/player.ts');

await playSong(song('from-migu'));
await waitFor(() => player.playSource === 'migu' && player.playing, '咪咕实际源');
assert.equal(player.current.source, 'netease', '曲目原源不动，避免打乱单源交接的曲目身份');
assert.equal(player.playSource, 'migu');
assert.equal(player.current._altSource.source, 'migu');
assert.equal(player.current._altSource.id, 'm1');

player.error = '';
await playSong(song('1'));
await waitFor(() => player.playSource === 'netease' && player.current.id === '1', '网易云开播');
const audibleBefore = audios.find((a) => a.src.includes('lanyue-stream://1') && !a.paused);
assert.ok(audibleBefore, '换源前应正在出声');

await switchPlaySource();
await waitFor(() => player.playSource === 'kuwo', '换到酷我');
assert.equal(calls.at(-1).avoid, 'netease');
assert.equal(calls.at(-1).allow, true);
assert.equal(player.playSource, 'kuwo');
assert.equal(player.current._altSource.source, 'kuwo');
assert.equal(player.error, '');
const audibleAfter = audios.find((a) => !a.paused && a.src.includes('kuwo'));
assert.ok(audibleAfter, '换源成功后应播新链');

const keepSrc = audibleAfter.src;
const beforeFailSwitch = calls.length;
await switchPlaySource();
await waitFor(() => player.error, '换源失败原因');
assert.match(String(player.error), /版权/);
assert.doesNotMatch(String(player.error), /COPYRIGHT_RESTRICTED/);
assert.equal(player.loading, false);
assert.equal(player.playSource, 'kuwo', '换失败时徽章仍是正在听的源');
assert.ok(audios.some((a) => a.src === keepSrc && !a.paused), '换源失败不应把正在听的链停掉');
assert.ok(calls.length > beforeFailSwitch);
assert.equal(calls.at(-1).avoid, 'kuwo');

await playSong(song('bad'));
await waitFor(() => player.error, '取流失败');
assert.match(String(player.error), /VIP/);
assert.doesNotMatch(String(player.error), /^VIP_REQUIRED$/);

console.log('player source badge runner ok');
