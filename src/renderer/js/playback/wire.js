/**
 * playback/wire.js — 播放引擎的生产接线（阶段 3 · P0）
 *
 * 职责边界
 * --------
 * 本文件是**唯一**把 playback/engine.js 接进生产链路的地方。
 * 引擎本身（engine.js）保持零依赖、零 DOM、可单测；它不知道自己被谁创建。
 * 这里负责把「渲染层已有的能力」注入给引擎：
 *
 *   resolveTrack  ← api.getDownloadUrlSmart（下载/播放共用的取流 + 换源）
 *   proxyPlay     ← api.proxyPlay（stream:// 流式代理注册）
 *   saveProgress  ← player/progressStore 的串行写入器（复用，不重造）
 *   loadProgress  ← prefs 的 playProgressMap（与 player.js:180 同一口径）
 *
 * 为什么进度记忆要复用 progressStore 而不是直接调 api.setPref
 * -------------------------------------------------------------
 * playProgressMap 是「读 → 改 → 整体写回」的结构，三个写者（30s 自动保存 /
 * 暂停 / 播完写 0）不排队就会用陈旧快照互相覆盖。player/progressStore.js 的
 * createProgressWriter 已经用串行队列解决了这件事，并有单测。重造一份必然漂移。
 *
 * 阶段 3 的推进方式
 * ----------------
 * 旧渲染层仍由 createWiredPlaybackEngine 把引擎接到 #audioPlayer。
 * 现在出货的 Vue 播放器不再自己取流、也不再自己做一套静音预热：
 * createPlayableResolver 是取流的唯一实现，createAudibleSlots 把
 * audioPool 的隐藏预热和单源交接到调用方手上。重叠交叉仍由
 * playback/crossfade.js 编排，这一条交接是它旁边的可选项。
 */

import { createPlaybackEngine } from './engine.js';
import { createAudioPool } from './audioPool.js';
import { createProgressWriter } from '../player/progressStore.js';
import { fileUrlFromPath } from '../../../shared/fileUrl.mjs';
import { humanPlayFailure } from '../playerSourceBadge.js';

/** 与旧播放器同一份来源页，在线歌代理时带上。 */
const PLAY_REFERERS = Object.freeze({
  bilibili: 'https://www.bilibili.com/',
  qq: 'https://y.qq.com/',
  netease: 'https://music.163.com/',
  kugou: 'https://www.kugou.com/',
  kuwo: 'https://www.kuwo.cn/',
  migu: 'https://music.migu.cn/',
  soda: 'https://music.douyin.com/',
  fivesing: 'https://5sing.kugou.com/',
  audiomack: 'https://audiomack.com/',
});

function errorText(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return '';
}

/**
 * 生产播放器的取流。本地文件直接变成 file URL；在线歌先取直链再登记代理。
 * 调用方只提供 invoke，通道名留在这里，避免各处再写一套。
 *
 * @param {object} deps
 * @param {(method: string, ...args: unknown[]) => Promise<unknown>} deps.invoke
 * @param {(filePath: string) => string} [deps.localFileUrl]
 * @param {(key: string) => string} [deps.translate] 失败文案。缺省用中文，与播放条其它句子一致。
 */
export function createPlayableResolver({ invoke, localFileUrl = fileUrlFromPath, translate } = {}) {
  if (typeof invoke !== 'function') throw new Error('[playback/wire] 缺少 invoke');
  /**
   * @param {object|null|undefined} song
   * @param {string} quality
   * @param {{ allowToggleSource?: boolean, avoidSource?: string }|null|undefined} [options]
   * @returns {Promise<{ fileUrl?: string, error?: string, source?: string, matchedSong?: { source?: string, id?: string }|null, degradedLocal?: boolean, fromAltMemory?: boolean }>}
   */
  return async function resolvePlayable(song, quality, options) {
    const ownSource = (song && song.source) || '';
    try {
      const leavingFile = options && typeof options.avoidSource === 'string' && options.avoidSource;
      if (song && song.filePath && !leavingFile) {
        return { fileUrl: localFileUrl(song.filePath), source: 'local' };
      }
      const result = options
        ? await invoke('getDownloadUrlSmart', song, quality, options)
        : await invoke('getDownloadUrlSmart', song, quality);
      if (!result || !result.url) {
        return { error: humanPlayFailure(result, ownSource, translate) };
      }
      if (result.degradedLocal) {
        return { fileUrl: result.url, source: 'local', degradedLocal: true };
      }
      const playSource = result.source || ownSource || '';
      const proxied = await invoke('proxyPlay', result.url, PLAY_REFERERS[playSource] || '', {
        id: String(result.id != null ? result.id : (song && song.id)),
        source: playSource,
        quality,
      });
      if (!proxied || !proxied.fileUrl) {
        return { error: humanPlayFailure({ error: (proxied && proxied.error) || '流代理失败' }, playSource, translate) };
      }
      return {
        fileUrl: proxied.fileUrl,
        source: playSource,
        matchedSong: result.matchedSong || null,
        fromAltMemory: !!result.fromAltMemory,
      };
    } catch (e) {
      return { error: humanPlayFailure({ error: errorText(e) || '播放异常' }, ownSource, translate) };
    }
  };
}

/**
 * 给调用方一个会长大的 audioPool。
 * 池要求至少一个元素，所以拖到第一次 attach 才建。
 * applyOutput 由调用方落地音量，池自己只负责静音位和「先关再开」。
 *
 * @param {object} [deps]
 * @param {(el: HTMLAudioElement, gain: number) => void} [deps.applyOutput]
 * @param {object|null} [deps.logger]
 * @param {Function|null} [deps.audioContextFactory]
 */
export function createAudibleSlots({ applyOutput = null, logger = null, audioContextFactory = null } = {}) {
  let pool = null;

  function attach(id, el) {
    if (!id || !el) return false;
    if (!pool) {
      pool = createAudioPool({
        elements: { [id]: el },
        logger,
        audioContextFactory,
        applyOutput,
      });
      return true;
    }
    return pool.attach(id, el);
  }

  function hiddenWarmup(id, src, opts) {
    if (!pool) return { ok: false, audible: false, reason: 'missing' };
    return pool.hiddenWarmup(id, src, opts);
  }

  function handoff(fromId, toId, opts) {
    if (!pool) return { ok: false, mode: 'hardCut', reason: 'preload' };
    return pool.handoff(fromId, toId, opts);
  }

  /**
   * 从这一槽已经建好的图上抄一帧频域。
   * 图仍是 source → preamp → filters → analyser → destination。
   * 这里不新建节点，也不做环回采集。槽还没挂上，或图建不起来，返回 false。
   * target 至少要有 frequencyBinCount 那么长（池里的 analyser 是 128）。
   *
   * @param {string} id
   * @param {Uint8Array} target
   * @returns {boolean}
   */
  function copyFrequency(id, target) {
    if (!pool || !id || !target || typeof target.length !== 'number' || target.length <= 0) return false;
    const graph = pool.getGraph(id);
    const analyser = graph && graph.analyser;
    if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return false;
    const bins = Number(analyser.frequencyBinCount);
    const need = Number.isFinite(bins) && bins > 0 ? bins : target.length;
    if (target.length < need) return false;
    const view = target.length === need ? target : target.subarray(0, need);
    try {
      analyser.getByteFrequencyData(view);
    } catch (_e) {
      return false;
    }
    return true;
  }

  return { attach, hiddenWarmup, handoff, copyFrequency };
}

/** 进度记忆的 key 口径，必须与 player.js:166 逐字一致，否则会读到两份互不相认的记录 */
function playProgressKey(song) {
  return song.filePath || `${song.source}:${song.id}`;
}

/**
 * 创建并接线一个生产用播放引擎实例。
 *
 * @param {object} deps
 * @param {HTMLAudioElement} deps.audio   #audioPlayer 元素（由 app.js 从 DOM 取一次）
 * @param {object} deps.api               渲染层 preload 桥（window.musicAPI）
 * @param {object|null} [deps.logger]
 * @returns {object} 引擎实例
 */
export function createWiredPlaybackEngine({ audio, api, logger = null }) {
  if (!audio) throw new Error('[playback/wire] 缺少 audio 元素');
  if (!api || typeof api !== 'object') throw new Error('[playback/wire] 缺少 api 桥');

  // 与 player.js:171-174 同一份实现：串行队列 + 容量上限 + 开关判断
  const progressWriter = createProgressWriter({
    getPref: (k) => api.getPref(k),
    setPref: (k, v) => api.setPref(k, v),
  });

  const engine = createPlaybackEngine({
    audio,

    // 取流：复用既有智能取流（本源失败自动换源）。
    // 引擎只关心「拿到一个能播的 url」，换源策略留在 api 层，不在这里复刻。
    resolveTrack: (song, quality) => api.getDownloadUrlSmart(song, quality),

    // 流式代理：把上游直链注册成 stream:// 地址，让 <audio> 支持 Range/seek
    proxyPlay: (url, referer, refresh) => api.proxyPlay(url, referer, refresh),

    saveProgress: (song, seconds) => progressWriter.save(playProgressKey(song), seconds),

    // 读回口径与 player.js:180-190 一致：开关关闭则 0；前 3 秒视为没听过
    loadProgress: async (song) => {
      try {
        const enabled = await api.getPref('playProgressMemory');
        if (!enabled) return 0;
        const map = (await api.getPref('playProgressMap')) || {};
        const entry = map[playProgressKey(song)];
        return entry && entry.time > 3 ? entry.time : 0;
      } catch (_e) {
        return 0;
      }
    },

    logger,
  });

  return engine;
}
