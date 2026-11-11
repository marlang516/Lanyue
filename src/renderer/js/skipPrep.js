/**
 * 切歌预取（生产播放器 stores/player.ts 用）
 *
 * 点「下一首」之后才去 getDownloadUrlSmart，再等 proxyPlay，这两次串行往返
 * 就是切歌后要缓冲一阵才出声的应用侧原因。可预测的邻居（顺序 / 列表循环的
 * 上一首和下一首）在当前这首一开始就解析；点击时 join 已有结果或在飞的同一次
 * 请求，不再另起一条。
 *
 * 随机和单曲循环的下一首不可预测，这里不猜。解析失败只记冷却，不打扰正在听的歌。
 * scheme URL 本身不过期（上游签名过期由主进程 403 重取），所以这里不套用
 * playPrefetch.js 那 90 秒的裸直链 TTL。
 */

/** 同一首歌预取失败后的冷却，避免逐帧打音源 */
export const PREP_RETRY_MS = 60 * 1000;

/**
 * 队列里可预测的邻居下标。没有、或下一首就是自己时返回 null。
 * @param {number} len
 * @param {number} idx
 * @param {string} mode order | list-loop | single | shuffle
 * @param {number} dir 1 下一首，-1 上一首
 * @returns {number|null}
 */
export function neighborIndex(len, idx, mode, dir) {
  const n = Number.isFinite(len) ? Math.trunc(len) : 0;
  if (n <= 0) return null;
  const i = Number.isFinite(idx) ? Math.trunc(idx) : -1;
  if (i < 0 || i >= n) return null;
  if (mode === 'shuffle' || mode === 'single') return null;
  const step = dir < 0 ? -1 : 1;
  let next = i + step;
  if (next < 0) {
    if (mode === 'list-loop') next = n - 1;
    else return null;
  } else if (next >= n) {
    if (mode === 'list-loop') next = 0;
    else return null;
  }
  if (next === i) return null;
  return next;
}

/**
 * @typedef {{ id?: unknown, source?: unknown, filePath?: string, [key: string]: unknown }} PrepSong
 */

/**
 * 预取键。拖入即播没有稳定 id；本地文件仍要键，这样切歌可以复用已经打开的 file URL。
 * @param {PrepSong|null|undefined} song
 * @param {string} [quality]
 * @returns {string|null}
 */
export function prepKey(song, quality) {
  if (!song || typeof song !== 'object') return null;
  if (song.id === null || song.id === undefined || String(song.id).trim() === '') return null;
  const source = String(song.source || '').trim().toLowerCase();
  if (!source || source === 'drop') return null;
  const id = String(song.id).trim().toLowerCase();
  const q = String(quality || 'standard');
  return `${source}:${id}:${q}`;
}

/**
 * @param {object} [options]
 * @param {(song: PrepSong, quality: string) => Promise<{fileUrl?: string}|null|undefined>} [options.resolve]
 * @param {(info: {song: PrepSong, fileUrl: string, key: string, role: string}) => void} [options.onReady]
 * @param {(key: string) => void} [options.onDrop]
 * @param {() => number} [options.now]
 */
export function createSkipPrep(options = {}) {
  const resolve = options.resolve;
  const onReady = options.onReady;
  const onDrop = options.onDrop;
  const nowFn = options.now || Date.now;
  /** @type {Map<string, {fileUrl: string}>} */
  const ready = new Map();
  /** @type {Map<string, Promise<{fileUrl: string}|null>>} */
  const inflight = new Map();
  /** @type {Map<string, {key: string, at: number}>} */
  const fails = new Map();
  let generation = 0;

  if (typeof resolve !== 'function') {
    throw new Error('createSkipPrep: resolve is required');
  }
  const resolveTrack = resolve;

  /**
   * @param {{key: string, at: number}|undefined} fail
   * @param {string} key
   * @param {number} now
   */
  function retryAllowed(fail, key, now) {
    if (!fail || fail.key !== key) return true;
    return now - Number(fail.at) >= PREP_RETRY_MS;
  }

  /**
   * @param {string} key
   * @param {boolean} notify
   */
  function dropKey(key, notify) {
    ready.delete(key);
    inflight.delete(key);
    if (notify && onDrop) onDrop(key);
  }

  /**
   * @param {PrepSong} song
   * @param {string} quality
   * @param {string} role
   * @param {string} key
   * @param {number} gen
   */
  function start(song, quality, role, key, gen) {
    let pending;
    try {
      pending = resolveTrack(song, quality);
    } catch (_e) {
      pending = Promise.resolve(null);
    }
    /** @type {Promise<{fileUrl: string}|null>} */
    const p = Promise.resolve(pending).then((res) => {
      if (inflight.get(key) !== p || gen !== generation) return null;
      inflight.delete(key);
      if (!res || !res.fileUrl) {
        fails.set(key, { key, at: nowFn() });
        return null;
      }
      fails.delete(key);
      const hit = { fileUrl: res.fileUrl };
      ready.set(key, hit);
      if (onReady) onReady({ song, fileUrl: res.fileUrl, key, role });
      return hit;
    }).catch(() => {
      if (inflight.get(key) === p) inflight.delete(key);
      if (gen === generation) fails.set(key, { key, at: nowFn() });
      return null;
    });
    inflight.set(key, p);
  }

  return {
    /**
     * @param {object} opts
     * @param {PrepSong[]} [opts.queue]
     * @param {number} [opts.index]
     * @param {string} [opts.mode]
     * @param {string} [opts.quality]
     * @param {string|null} [opts.holdKey] 正在接手的那首，即使不再是邻居也不拆
     * @param {(song: PrepSong, quality: string) => boolean} [opts.skipResolve]
     */
    arm(opts = {}) {
      const list = Array.isArray(opts.queue) ? opts.queue : [];
      const quality = opts.quality || 'standard';
      const gen = generation;
      /** @type {Map<string, {song: PrepSong, role: string}>} */
      const wanted = new Map();
      /**
       * @param {number} dir
       * @param {string} role
       */
      const consider = (dir, role) => {
        const at = neighborIndex(list.length, opts.index ?? -1, opts.mode || '', dir);
        const song = at == null ? null : list[at];
        if (!song) return;
        const key = prepKey(song, quality);
        if (!key || wanted.has(key)) return;
        wanted.set(key, { song, role });
      };
      consider(1, 'next');
      consider(-1, 'prev');

      for (const key of [...ready.keys(), ...inflight.keys()]) {
        if (wanted.has(key) || key === opts.holdKey) continue;
        dropKey(key, true);
      }

      for (const [key, info] of wanted) {
        if (typeof opts.skipResolve === 'function' && opts.skipResolve(info.song, quality)) continue;
        if (ready.has(key)) {
          const hit = ready.get(key);
          if (hit && onReady) onReady({ song: info.song, fileUrl: hit.fileUrl, key, role: info.role });
          continue;
        }
        if (inflight.has(key)) continue;
        const fail = fails.get(key);
        if (fail && !retryAllowed(fail, key, nowFn())) continue;
        start(info.song, quality, info.role, key, gen);
      }
    },

    /**
     * 取已完成或在飞的结果。没有则 null（调用方自己冷解析），不会新开请求。
     * @param {PrepSong} song
     * @param {string} quality
     * @returns {Promise<{fileUrl: string}|null>}
     */
    async join(song, quality) {
      const key = prepKey(song, quality);
      if (!key) return null;
      if (ready.has(key)) return ready.get(key) || null;
      const p = inflight.get(key);
      if (!p) return null;
      await p;
      return ready.get(key) || null;
    },

    /**
     * @param {PrepSong} song
     * @param {string} quality
     */
    peek(song, quality) {
      const key = prepKey(song, quality);
      if (!key) return null;
      return ready.get(key) || null;
    },

    /**
     * @param {PrepSong} song
     * @param {string} quality
     */
    isInflight(song, quality) {
      const key = prepKey(song, quality);
      return !!(key && inflight.has(key));
    },

    invalidate() {
      generation += 1;
      const keys = new Set([...ready.keys(), ...inflight.keys()]);
      ready.clear();
      inflight.clear();
      fails.clear();
      for (const key of keys) {
        if (onDrop) onDrop(key);
      }
    },

    readyCount() {
      return ready.size;
    },
  };
}
