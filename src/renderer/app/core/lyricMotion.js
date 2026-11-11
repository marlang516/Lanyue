/**
 * 全屏歌词的交接时钟（纯函数，不碰 DOM）。
 *
 * 运动设计，沿用沉浸页 Void Glass「当前行放大、相邻行淡出」，
 * 落到极光玻璃令牌上，而不是另做一套卡拉 OK 皮肤：
 *   · 换行时新行从相邻行的静止姿态升起、放大，旧行在同一时段收回
 *     强调（缩放 / 透明度 / 光带）。入场关键帧的起点必须等于相邻行
 *     的静止变换，否则下一句会先跳一下再回来。
 *   · 只描述「该不该动、动哪一档」。真正的插值在 LyricsPane 的
 *     transform / opacity 上，不改字重，避免整列重排。
 *   · 换行间隔短于交接时长（连唱、拖进度）时直接落点，动画不堆积，
 *     高亮也不会落后于拍点。
 *   · 句间空档明显长于这首歌自己的典型句距时，当前行在唱完保持后
 *     收成静息；第一句之前是前奏，不高亮任何一行。
 *   · 播放进度来自 audio 的 timeupdate（大约 4Hz）。这里在两个样本
 *     之间按倍速外推，但领先不超过一截采样，样本对不上就当成 seek
 *     回到报告时间，避免卡顿时歌词自己往前跑。
 *
 * 行号二分全屏页和桌面歌词同步共用，不要在播放器里再写一份。
 */

/** 与 tokens.css 的 --dur-2（.32s）对齐；改一边必须改另一边。 */
export const LYRIC_HANDOFF_MS = 320;

/** 比交接还密的换行不再播动画。 */
export const LYRIC_RAPID_MS = LYRIC_HANDOFF_MS;

/** 绝对空档下限（秒）。短于它的句距一律当正常演唱。 */
export const LYRIC_REST_GAP_SEC = 6;

/** 进入长空档后，强调再保持这么久才静息，避免字刚出来就灭。 */
export const LYRIC_SUNG_HOLD_SEC = 3.2;

/** 空档要达到典型句距的这么多倍，才算间奏而不是慢歌的正常句。 */
export const LYRIC_GAP_RATIO = 2.2;

/** 句距样本不够时用的典型句距（秒），避免一两句就把阈值拉飞。 */
export const LYRIC_TYPICAL_GAP_FALLBACK = 4;

/** 报告进度和推算进度差过这么多秒，当成 seek，不再沿用旧锚点。 */
export const PLAYHEAD_SEEK_SLACK_SEC = 0.45;

/** 进度样本停住超过这么久，视为缓冲，停在最后一次真实进度。 */
export const PLAYHEAD_STALL_MS = 480;

/** 两个 timeupdate 之间最多往前看这么多秒，防止一次长帧冲过好几句。 */
export const PLAYHEAD_LEAD_CAP_SEC = 0.3;

const gapCache = new WeakMap();

/**
 * @param {number} value
 * @param {number} fallback
 */
function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 当前播放位置对应的歌词行（-1 表示还没到第一句）。
 * items 必须按 t 升序；同一时刻多行时返回最后一行。
 * @param {readonly {t:number}[] | null | undefined} items
 * @param {number} seconds
 * @returns {number}
 */
export function activeLineIndex(items, seconds) {
  if (!Array.isArray(items) || !items.length) return -1;
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t <= seconds) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/**
 * 这首歌的典型句距。数组按不可变缓存：歌词一加载就是新数组。
 * @param {readonly {t:number}[]} items
 * @returns {{typical:number, count:number}}
 */
function gapProfile(items) {
  const hit = gapCache.get(items);
  if (hit) return hit;
  const gaps = [];
  for (let i = 1; i < items.length; i++) {
    const g = items[i].t - items[i - 1].t;
    if (g > 0) gaps.push(g);
  }
  let typical = LYRIC_TYPICAL_GAP_FALLBACK;
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    typical = gaps[gaps.length >> 1];
  }
  const profile = { typical, count: gaps.length };
  gapCache.set(items, profile);
  return profile;
}

/**
 * @param {readonly {t:number}[]} items
 * @param {number} index
 * @param {number} seconds
 * @param {number | undefined} duration
 * @returns {boolean}
 */
function lineIsResting(items, index, seconds, duration) {
  const start = items[index].t;
  const held = seconds - start;
  const next = items[index + 1];
  let gapAfter = 0;
  let known = false;
  if (next) {
    gapAfter = Math.max(0, next.t - start);
    known = true;
  } else if (typeof duration === 'number' && Number.isFinite(duration) && duration > start) {
    gapAfter = duration - start;
    known = true;
  }
  if (!known) return false;
  const { typical, count } = gapProfile(items);
  const scaled = typical * LYRIC_GAP_RATIO;
  const threshold = count >= 3 ? Math.max(LYRIC_REST_GAP_SEC, scaled) : Math.max(8, scaled);
  const hold = Math.min(LYRIC_SUNG_HOLD_SEC, Math.max(1.6, typical * 0.9));
  return gapAfter >= threshold && held >= hold;
}

/**
 * @param {{index:number, at:number} | null | undefined} prev
 * @returns {boolean}
 */
function cursorOk(prev) {
  return !!prev && Number.isFinite(prev.index) && Number.isFinite(prev.at);
}

/**
 * 这一帧歌词该停在哪一行、强调还是静息、交接还是硬切。
 * seconds 已含用户偏移。prev 为 null 表示第一次观察（打开全屏、换歌），直接落点。
 * @param {readonly {t:number}[] | null | undefined} items
 * @param {number} seconds
 * @param {{index:number, at:number} | null | undefined} prev
 * @param {number} nowMs
 * @param {{duration?: number, reducedMotion?: boolean} | null | undefined} [opts]
 * @returns {{index:number, role:'none'|'prelude'|'active'|'rest', motion:'none'|'handoff'|'snap', scroll:'hold'|'smooth'|'auto'}}
 */
export function resolveLyricFrame(items, seconds, prev, nowMs, opts) {
  const o = opts || {};
  if (!Array.isArray(items) || !items.length) {
    return { index: -1, role: 'none', motion: 'none', scroll: 'hold' };
  }
  const t = finite(seconds, 0);
  const now = finite(nowMs, 0);
  const index = activeLineIndex(items, t);
  const known = cursorOk(prev) ? prev : null;

  if (index < 0) {
    const fromLine = !!(known && known.index >= 0);
    return {
      index: -1,
      role: 'prelude',
      motion: fromLine ? 'snap' : 'none',
      scroll: fromLine ? 'auto' : 'hold',
    };
  }

  const resting = lineIsResting(items, index, t, Number.isFinite(o.duration) ? o.duration : undefined);
  const role = resting ? 'rest' : 'active';

  if (!known) {
    return { index, role, motion: 'snap', scroll: 'auto' };
  }
  if (known.index === index) {
    return { index, role, motion: 'none', scroll: 'hold' };
  }

  const delta = index - known.index;
  const rapid = now - known.at < LYRIC_RAPID_MS;
  const adjacent = Math.abs(delta) === 1;
  const motion = adjacent && !rapid && !o.reducedMotion ? 'handoff' : 'snap';
  const scroll = motion === 'handoff' ? 'smooth' : 'auto';
  return { index, role, motion, scroll };
}

/**
 * 一行在这一帧的视觉相位。
 * upcoming：前奏里即将到来的第一句，样式并进 near，保持可读。
 * @param {number} i
 * @param {{index:number, role:string} | null | undefined} frame
 * @returns {'on'|'rest'|'past'|'near'|'upcoming'|'far'}
 */
export function linePhase(i, frame) {
  if (!frame || frame.role === 'none') return 'far';
  const focus = Number.isFinite(frame.index) ? frame.index : -1;
  if (focus >= 0 && i === focus) return frame.role === 'rest' ? 'rest' : 'on';
  if (focus < 0) return i === 0 ? 'upcoming' : 'far';
  if (Math.abs(i - focus) === 1) return 'near';
  if (i < focus) return 'past';
  return 'far';
}

/**
 * 模板用的 class 表。handoff 只打在正在强调的那一行上。
 * @param {number} i
 * @param {{index:number, role:string, motion?:string} | null | undefined} frame
 * @returns {{on:boolean, rest:boolean, past:boolean, near:boolean, handoff:boolean}}
 */
export function lineClasses(i, frame) {
  const phase = linePhase(i, frame);
  return {
    on: phase === 'on',
    rest: phase === 'rest',
    past: phase === 'past',
    near: phase === 'near' || phase === 'upcoming',
    handoff: phase === 'on' && !!(frame && frame.motion === 'handoff'),
  };
}

/**
 * 在稀疏的 timeupdate 之间推算播放头。
 * 新样本若和推算对得上，就改锚到样本本身（不把外推值显示出来，避免越推越偏）。
 * @param {{progress:number, at:number, rate:number} | null | undefined} anchor
 * @param {number} reported
 * @param {number} nowMs
 * @param {number} rate
 * @param {boolean} playing
 * @returns {{seconds:number, anchor:{progress:number, at:number, rate:number}, seeked:boolean}}
 */
export function projectPlayhead(anchor, reported, nowMs, rate, playing) {
  const progress = Math.max(0, finite(reported, 0));
  const now = finite(nowMs, 0);
  const spd = finite(rate, 1) > 0 ? finite(rate, 1) : 1;
  const fresh = { progress, at: now, rate: spd };

  if (!anchor || !playing) {
    const seeked = !!(anchor && Math.abs(progress - anchor.progress) > PLAYHEAD_SEEK_SLACK_SEC);
    return { seconds: progress, anchor: fresh, seeked };
  }
  if (anchor.rate !== spd) {
    return { seconds: progress, anchor: fresh, seeked: false };
  }

  const elapsed = now - anchor.at;
  const expected = anchor.progress + (elapsed / 1000) * spd;
  const sampleMoved = Math.abs(progress - anchor.progress) > 0.001;

  if (sampleMoved && Math.abs(progress - expected) > PLAYHEAD_SEEK_SLACK_SEC) {
    return { seconds: progress, anchor: fresh, seeked: true };
  }
  if (!sampleMoved && elapsed > PLAYHEAD_STALL_MS) {
    return { seconds: Math.max(0, anchor.progress), anchor, seeked: false };
  }
  if (sampleMoved) {
    return { seconds: progress, anchor: fresh, seeked: false };
  }
  const lead = anchor.progress + PLAYHEAD_LEAD_CAP_SEC * spd;
  return { seconds: Math.max(0, Math.min(expected, lead)), anchor, seeked: false };
}
