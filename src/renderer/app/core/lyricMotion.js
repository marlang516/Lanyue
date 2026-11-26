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
 *
 * 演出性能也收在这里，不另做一套歌词：
 *   · 整轨布局建好就留着。暂停只把相位改成 held，不换 lines、不换 revision。
 *   · 建行按时间预算分帧。一帧建不完，下一帧从剩下的行接着建。
 *   · 光带用到的合成程序（扫过、亮带、余光）预热一次后常驻，
 *     显示、暂停、恢复、藏起都不再编译。
 *
 * 逐字状态用的是调用方已经算好的同一播放秒（含偏移），不是第二只钟。
 * 光带也吃这一秒和这个字自己的起止，并提前 WORD_LEAD_SEC：时间戳到达时
 * 这个字已经亮住，而不是等唱完才铺满。长音停得更亮，快词在自己的时长里
 * 扫完。有逐字时间就沿用；一个词里有好几个字时，
 * 只在这个词自己的时长里均分。没有逐字时间时，把这一句的时长均分给
 * 拆开的字。标点贴在前一个字上。
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

/**
 * 高亮比歌词时间戳早这么多。
 * 媒体图里的声音比 audio.currentTime 大约早 30ms，只等到时间戳再亮，
 * 人声已经出来了。行号和逐字都用这一段，不再另加延迟。
 */
export const WORD_LEAD_SEC = 0.15;

/**
 * 歌词时间轴上的播放秒（含用户偏移），还没加提前量。
 * @param {number} playSeconds
 * @param {number} [offsetMs]
 * @returns {number}
 */
export function lyricPlaySeconds(playSeconds, offsetMs) {
  return finite(playSeconds, 0) + (Number(offsetMs) || 0) / 1000;
}

/**
 * 用来选当前句的秒。比播放秒早 WORD_LEAD_SEC，和逐字的提前量同一段。
 * @param {number} playSeconds
 * @param {number} [offsetMs]
 * @returns {number}
 */
export function lyricDisplaySeconds(playSeconds, offsetMs) {
  return lyricPlaySeconds(playSeconds, offsetMs) + WORD_LEAD_SEC;
}

/** 源没给时长、后面也没有下一词时，在唱态保持这么久再收成已唱。 */
export const WORD_UNTIMED_SEC = 0.4;

const timedWordCache = new WeakMap();
const lineWordCache = new WeakMap();

/**
 * 一行上真实的逐字时间。空、或没有一个合法的词，返回 null（调用方改走整句）。
 * @param {{ words?: readonly {t:number, dur?:number, text?:string}[] } | null | undefined} line
 * @returns {readonly {t:number, dur:number, text:string}[] | null}
 */
function timedWords(line) {
  if (!line || typeof line !== 'object') return null;
  const hit = timedWordCache.get(line);
  if (hit !== undefined) return hit;
  const src = line.words;
  if (!Array.isArray(src) || !src.length) {
    timedWordCache.set(line, null);
    return null;
  }
  const out = [];
  for (const w of src) {
    if (!w || typeof w.text !== 'string' || !w.text) continue;
    const t = Number(w.t);
    if (!Number.isFinite(t)) continue;
    const dur = Number(w.dur);
    out.push({ t, dur: Number.isFinite(dur) && dur > 0 ? dur : 0, text: w.text });
  }
  const result = out.length ? out : null;
  timedWordCache.set(line, result);
  return result;
}

/** @param {string} ch */
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\u3000';
}

/** 汉字、假名、谚文各自一拍。 */
/** @param {string} ch */
function isCjk(ch) {
  const c = ch.codePointAt(0) || 0;
  return (c >= 0x3400 && c <= 0x9fff)
    || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0x3040 && c <= 0x30ff)
    || (c >= 0x31f0 && c <= 0x31ff)
    || (c >= 0xac00 && c <= 0xd7af);
}

/** @param {string} ch */
function isWordChar(ch) {
  if (!ch) return false;
  return /[A-Za-z0-9]/.test(ch) || (ch >= '\u00C0' && ch <= '\u024F');
}

/** 夹在字母数字中间的撇号、连字符留在词里，不当成单独一拍。 */
/** @param {string} ch */
function isInnerMark(ch) {
  return ch === "'" || ch === '\u2019' || ch === '-' || ch === '\u2010';
}

/**
 * 一句或一个词拆成要跳的拍。
 * 汉字一字一拍，英文和数字按词，标点贴在前一个字上（句首标点贴到后一个字）。
 * @param {string} text
 * @returns {string[]}
 */
function splitBeats(text) {
  const chars = Array.from(String(text || ''));
  /** @type {string[]} */
  const beats = [];
  let latin = '';
  let lead = '';

  /** @param {string} token */
  function pushBeat(token) {
    beats.push(lead + token);
    lead = '';
  }
  function flushLatin() {
    if (!latin) return;
    pushBeat(latin);
    latin = '';
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (isSpace(ch)) {
      flushLatin();
      if (beats.length) beats[beats.length - 1] += ch;
      else lead += ch;
      continue;
    }
    if (isCjk(ch)) {
      flushLatin();
      pushBeat(ch);
      continue;
    }
    const next = chars[i + 1] || '';
    if (isWordChar(ch) || (latin && isInnerMark(ch) && isWordChar(next))) {
      latin += lead + ch;
      lead = '';
      continue;
    }
    flushLatin();
    if (beats.length) beats[beats.length - 1] += ch;
    else lead += ch;
  }
  flushLatin();
  if (lead) {
    if (beats.length) beats[beats.length - 1] += lead;
    else if (/\S/.test(lead)) beats.push(lead);
  }
  return beats.filter((b) => /\S/.test(b));
}

/**
 * 把一段时间均分给拆开的拍。
 * @param {string} text
 * @param {number} start
 * @param {number} span
 * @returns {{t:number, dur:number, text:string}[]}
 */
function spreadBeats(text, start, span) {
  const beats = splitBeats(text);
  const width = span > 0 ? span : 0.05;
  if (!beats.length) {
    return text ? [{ t: start, dur: width, text }] : [];
  }
  const slice = width / beats.length;
  return beats.map((token, i) => ({ t: start + slice * i, dur: slice, text: token }));
}

/**
 * 真实逐字时间。已经是一个字的不拆；一个词里有多个字时，只均分这个词自己的时长。
 * @param {readonly {t:number, dur:number, text:string}[]} words
 * @returns {{t:number, dur:number, text:string}[]}
 */
function expandTimed(words) {
  /** @type {{t:number, dur:number, text:string}[]} */
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const beats = splitBeats(w.text);
    if (beats.length <= 1) {
      out.push(beats.length === 1 && beats[0] === w.text ? w : { t: w.t, dur: w.dur, text: beats[0] || w.text });
      continue;
    }
    let span = w.dur;
    if (!(span > 0)) {
      const next = words[i + 1];
      const nextT = next ? Number(next.t) : Number.NaN;
      span = Number.isFinite(nextT) && nextT > w.t ? nextT - w.t : WORD_UNTIMED_SEC;
    }
    const slice = span / beats.length;
    for (let j = 0; j < beats.length; j++) {
      out.push({ t: w.t + slice * j, dur: slice, text: beats[j] });
    }
  }
  return out;
}

/**
 * 这一句的终点：下一句起点，否则曲长，否则句末保持。
 * @param {{t:number}} line
 * @param {{t:number} | null | undefined} nextLine
 * @param {number | undefined} duration
 * @returns {number}
 */
function lineEnd(line, nextLine, duration) {
  const start = finite(line.t, 0);
  const nextT = nextLine ? Number(nextLine.t) : Number.NaN;
  const songEnd = Number(duration);
  if (Number.isFinite(nextT) && nextT > start) return nextT;
  if (Number.isFinite(songEnd) && songEnd > start) return songEnd;
  return start + LYRIC_SUNG_HOLD_SEC;
}

/**
 * 这一句在舞台上要跳的字。
 * 有逐字时间就用那一份（长词再拆开）；没有就把整句时长均分给每个字。
 * @param {{t:number, text?:string, words?: readonly {t:number, dur?:number, text?:string}[]} | null | undefined} line
 * @param {{t:number} | null | undefined} nextLine
 * @param {number | undefined} duration 曲长（秒）
 * @returns {readonly {t:number, dur:number, text:string}[]}
 */
export function displayWords(line, nextLine, duration) {
  if (!line) return [];
  const timed = timedWords(line);
  const end = lineEnd(line, nextLine, duration);
  const cached = lineWordCache.get(line);
  if (cached && cached.end === end && cached.timed === timed) return cached.words;
  const start = finite(line.t, 0);
  const words = timed
    ? expandTimed(timed)
    : spreadBeats(typeof line.text === 'string' ? line.text : '', start, Math.max(0.05, end - start));
  lineWordCache.set(line, { end, timed, words });
  return words;
}

/**
 * 一个词的在唱结束时刻。dur 为 0 时用下一词起点，仍没有就用 WORD_UNTIMED_SEC。
 * @param {readonly {t:number, dur?:number}[]} words
 * @param {number} index
 * @returns {number}
 */
function wordActiveEnd(words, index) {
  const start = finite(words[index] && words[index].t, 0);
  const dur = finite(Number(words[index] && words[index].dur), 0);
  if (dur > 0) return start + dur;
  const next = words[index + 1];
  const nextT = next ? Number(next.t) : Number.NaN;
  if (Number.isFinite(nextT) && nextT > start) return nextT;
  return start + WORD_UNTIMED_SEC;
}

/**
 * 每个词相对播放秒的状态。seconds 必须已经含用户偏移，与 resolveLyricFrame 同一份。
 * unreached 还没到，active 正在唱（含提前量），sung 这句里已经唱过。
 * @param {readonly {t:number, dur?:number}[] | null | undefined} words
 * @param {number} seconds
 * @returns {{ index: number, states: ('unreached'|'active'|'sung')[] }}
 */
export function resolveWordStates(words, seconds) {
  if (!Array.isArray(words) || !words.length) return { index: -1, states: [] };
  const t = finite(seconds, 0);
  /** @type {('unreached'|'active'|'sung')[]} */
  const states = new Array(words.length);
  let index = -1;
  for (let i = 0; i < words.length; i++) {
    const start = finite(words[i] && words[i].t, 0);
    const end = wordActiveEnd(words, i);
    /** @type {'unreached'|'active'|'sung'} */
    let state = 'sung';
    if (t < start - WORD_LEAD_SEC) state = 'unreached';
    else if (t < end) state = 'active';
    states[i] = state;
    if (state === 'active') index = i;
  }
  return { index, states };
}

/** 短于等于这时长的字只做一次快扫，光几乎不加重。 */
export const SWEEP_FAST_SEC = 0.18;

/** 长于等于这时长的音，光带扫过后停在字上并继续变亮。 */
export const SWEEP_HELD_SEC = 0.7;

/** 长音用这么久把光带扫过整字，剩下的时间停住。 */
export const SWEEP_CROSS_SEC = 0.36;

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * 一个字在这一秒的光带。提前量里就开始扫，时间戳到达时这个字已经亮住。
 * @param {number} dur
 * @param {number} elapsed
 * @param {'unreached'|'active'|'sung'} state
 * @returns {{sweep:number, band:number, bloom:number, linger:boolean}}
 */
function glowAmounts(dur, elapsed, state) {
  const fast = dur > 0 && dur <= SWEEP_FAST_SEC;
  const held = dur >= SWEEP_HELD_SEC;
  if (state === 'unreached' || elapsed < -WORD_LEAD_SEC) {
    return { sweep: 0, band: 0, bloom: 0, linger: false };
  }
  if (state === 'sung') {
    let bloom = 0.4;
    if (held) bloom = 0.58;
    else if (fast) bloom = 0.26;
    return { sweep: 1, band: 0, bloom, linger: false };
  }
  // into = 0 在提前量起点，into = WORD_LEAD_SEC 在时间戳上。扫完正好赶上人声。
  const into = elapsed + WORD_LEAD_SEC;
  const attackLen = fast ? Math.min(WORD_LEAD_SEC, Math.max(0.04, dur)) : WORD_LEAD_SEC;
  if (into < attackLen) {
    const p = attackLen > 0 ? Math.max(0, into) / attackLen : 1;
    return {
      sweep: p,
      band: p,
      bloom: fast ? 0.46 : 0.62 + 0.18 * p,
      linger: false,
    };
  }
  const lingerP = clamp01(Math.max(0, elapsed) / Math.max(0.05, dur));
  if (fast) return { sweep: 1, band: 1, bloom: 0.46, linger: false };
  if (held) return { sweep: 1, band: 0.5, bloom: 0.8 + 0.2 * lingerP, linger: true };
  return { sweep: 1, band: 0.5, bloom: 0.72 + 0.06 * lingerP, linger: true };
}

/**
 * 光带扫到哪、有多亮。seconds 与 resolveWordStates 是同一播放秒。
 * sweep 是已经照亮的比例，band 是亮带中心，linger 表示长音停在字上。
 * @param {readonly {t:number, dur?:number}[] | null | undefined} words
 * @param {number} seconds
 * @returns {{
 *   index: number,
 *   states: ('unreached'|'active'|'sung')[],
 *   sweep: number[],
 *   band: number[],
 *   bloom: number[],
 *   linger: boolean[],
 * }}
 */
export function resolveWordSweep(words, seconds) {
  const base = resolveWordStates(words, seconds);
  const n = base.states.length;
  const sweep = new Array(n);
  const band = new Array(n);
  const bloom = new Array(n);
  const linger = new Array(n);
  const t = finite(seconds, 0);
  const list = Array.isArray(words) ? words : [];
  for (let i = 0; i < n; i++) {
    const start = finite(list[i] && list[i].t, 0);
    const dur = Math.max(0, wordActiveEnd(list, i) - start);
    const glow = glowAmounts(dur, t - start, base.states[i]);
    sweep[i] = glow.sweep;
    band[i] = glow.band;
    bloom[i] = glow.bloom;
    linger[i] = glow.linger;
  }
  return { index: base.index, states: base.states, sweep, band, bloom, linger };
}

/**
 * 把一整句缩进可用宽度。放得下就保持 1，避免无谓缩小。
 * @param {number} neededPx
 * @param {number} availablePx
 * @returns {number}
 */
export function lineFitScale(neededPx, availablePx) {
  const needed = Number(neededPx);
  const available = Number(availablePx);
  if (!(needed > 0) || !(available > 0)) return 1;
  if (needed <= available) return 1;
  return available / needed;
}

/**
 * 从封面小样里挑一抹还能当光的颜色。
 * 近黑、近白、近灰丢掉。没有可用样本就返回空串，调用方用强调色令牌。
 * @param {ArrayLike<number> | null | undefined} rgba
 * @returns {string}
 */
export function glowFromCoverPixels(rgba) {
  if (!rgba || typeof rgba.length !== 'number') return '';
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const pr = Number(rgba[i]);
    const pg = Number(rgba[i + 1]);
    const pb = Number(rgba[i + 2]);
    const a = Number(rgba[i + 3]);
    if (!(a >= 128)) continue;
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    if (max < 28 || min > 236) continue;
    const sat = max - min;
    if (sat < 18) continue;
    r += pr * sat;
    g += pg * sat;
    b += pb * sat;
    w += sat;
  }
  if (!(w > 0)) return '';
  return `rgb(${Math.round(r / w)}, ${Math.round(g / w)}, ${Math.round(b / w)})`;
}

/**
 * 一帧里建行最多占用这么久。短于一帧，剩下的时间留给界面自己画。
 * 调用方在同一帧里再进来时，用 LYRIC_BUILD_FRAME_MS 合并成一次。
 */
export const LYRIC_BUILD_BUDGET_MS = 8;

/** 同一帧里的多次推进合成一次，避免全屏页和舞台各建一遍。 */
export const LYRIC_BUILD_FRAME_MS = 16;

/** 光带实际用到的三种合成。预热后程序对象一直留在 residence 上。 */
export const LYRIC_SHADER_NAMES = Object.freeze(['sweep', 'band', 'bloom']);

/** @type {Record<string, string>} */
const SHADER_FEATURE = {
  sweep: 'clip-path',
  band: 'background-clip',
  bloom: 'drop-shadow',
};

/**
 * @typedef {object} LyricSourceLine
 * @property {number} t
 * @property {string} [text]
 * @property {readonly {t:number, dur?:number, text?:string}[]} [words]
 */

/**
 * @typedef {object} LyricTrackLine
 * @property {number} index
 * @property {number} t
 * @property {string} text
 * @property {readonly {t:number, dur:number, text:string}[]} words
 */

/**
 * @typedef {object} LyricTrack
 * @property {string} sourceKey
 * @property {LyricTrackLine[]} lines
 * @property {number} nextIndex
 * @property {number} built
 * @property {boolean} complete
 * @property {number} revision
 * @property {'building' | 'ready' | 'held'} phase
 * @property {boolean} playing
 * @property {readonly LyricSourceLine[] | null} itemRef
 * @property {number | null} stepBucket
 * @property {boolean} stepSpent
 */

/**
 * @typedef {object} LyricShaderProgram
 * @property {string} name
 * @property {boolean} resident
 * @property {number} compiledAt
 * @property {string} feature
 */

/**
 * @typedef {object} LyricShaderResidence
 * @property {Record<string, LyricShaderProgram>} programs
 * @property {number} compiles
 * @property {boolean} warmed
 * @property {HTMLElement | null} surface
 */

let trackRevision = 1;
/** @type {Map<string, LyricTrack>} */
const tracksByKey = new Map();

/**
 * 同一首歌暂停：还是这条轨道，lines 和 revision 都不换。
 * 换 sourceKey 才新开一条，从头建。
 * @param {LyricTrack | null | undefined} track
 * @param {string} sourceKey
 * @param {boolean} playing
 * @returns {LyricTrack}
 */
export function retainLyricTrack(track, sourceKey, playing) {
  const key = String(sourceKey || '');
  const on = !!playing;
  if (!track || track.sourceKey !== key) {
    return {
      sourceKey: key,
      lines: [],
      nextIndex: 0,
      built: 0,
      complete: false,
      revision: trackRevision++,
      phase: on ? 'building' : 'held',
      playing: on,
      itemRef: null,
      stepBucket: null,
      stepSpent: false,
    };
  }
  track.playing = on;
  if (!on) track.phase = 'held';
  else if (track.phase === 'held') track.phase = track.complete ? 'ready' : 'building';
  return track;
}

/**
 * 当前这首的轨道。歌词数组换了（换歌或重新解析）才丢弃已建布局。
 * 暂停传进来的仍是原来那份数组，因此不会重做。
 * @param {string} sourceKey
 * @param {boolean} playing
 * @param {readonly LyricSourceLine[] | null | undefined} items
 * @returns {LyricTrack}
 */
function openLyricTrack(sourceKey, playing, items) {
  const key = String(sourceKey || '');
  const list = Array.isArray(items) ? items : null;
  let prev = tracksByKey.get(key) || null;
  if (prev && list && prev.itemRef && prev.itemRef !== list) prev = null;
  const track = retainLyricTrack(prev, key, playing);
  if (list) track.itemRef = list;
  tracksByKey.set(key, track);
  for (const existing of tracksByKey.keys()) {
    if (existing !== key) tracksByKey.delete(existing);
  }
  return track;
}

/**
 * @param {LyricTrack | null | undefined} track
 * @param {number} index
 * @returns {LyricTrackLine | null}
 */
export function builtLyricLine(track, index) {
  if (!track || !Array.isArray(track.lines)) return null;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return null;
  return track.lines[i] || null;
}

/**
 * 在预算内接着建还没建的行。已建的格子不重写。
 * 暂停（held）直接返回，built 为 0。
 * focusIndex 是此刻要唱的那句，有预算时先建它，再按顺序补前面的洞。
 * @param {LyricTrack | null | undefined} track
 * @param {readonly LyricSourceLine[] | null | undefined} items
 * @param {number | undefined} duration
 * @param {number} budgetMs
 * @param {number} nowMs
 * @param {(() => number) | undefined} clock
 * @param {number} [focusIndex]
 * @returns {{ track: LyricTrack | null, built: number, done: boolean, held: boolean, coalesced: boolean }}
 */
export function buildLyricTrack(track, items, duration, budgetMs, nowMs, clock, focusIndex) {
  if (!track) {
    return { track: null, built: 0, done: true, held: false, coalesced: false };
  }
  if (track.phase === 'held' || track.playing === false) {
    return { track, built: 0, done: !!track.complete, held: true, coalesced: false };
  }
  const list = Array.isArray(items) ? items : [];
  const budget = Number(budgetMs);
  if (!(budget > 0)) {
    return { track, built: 0, done: !!track.complete, held: false, coalesced: false };
  }
  const start = finite(nowMs, 0);
  const frame = LYRIC_BUILD_FRAME_MS > 0 ? LYRIC_BUILD_FRAME_MS : 16;
  const bucket = Math.floor(start / frame);
  if (track.stepBucket === bucket && track.stepSpent) {
    return { track, built: 0, done: !!track.complete, held: false, coalesced: true };
  }
  const read = typeof clock === 'function'
    ? clock
    : () => (typeof performance !== 'undefined' ? performance.now() : start);
  const pending = [];
  const focus = Number(focusIndex);
  if (Number.isInteger(focus) && focus >= 0 && focus < list.length && !track.lines[focus]) {
    pending.push(focus);
  }
  for (let i = track.nextIndex; i < list.length; i++) {
    if (!track.lines[i] && i !== focus) pending.push(i);
  }
  let built = 0;
  for (let p = 0; p < pending.length; p++) {
    const i = pending[p];
    if (track.lines[i]) continue;
    if (built > 0 && read() - start >= budget) break;
    const line = list[i];
    const words = displayWords(line, list[i + 1], duration);
    track.lines[i] = {
      index: i,
      t: finite(line && line.t, 0),
      text: line && typeof line.text === 'string' ? line.text : '',
      words,
    };
    track.built += 1;
    built += 1;
  }
  while (track.nextIndex < list.length && track.lines[track.nextIndex]) track.nextIndex += 1;
  track.complete = list.length > 0 && track.built >= list.length;
  if (track.complete && track.playing) track.phase = 'ready';
  if (built > 0 || track.complete) {
    track.stepBucket = bucket;
    track.stepSpent = true;
  }
  return { track, built, done: !!track.complete, held: false, coalesced: false };
}

/**
 * 播放态推进一步。暂停不建行，轨道对象保持原样。
 * @param {{
 *   sourceKey?: string,
 *   playing?: boolean,
 *   items?: readonly LyricSourceLine[] | null,
 *   duration?: number,
 *   nowMs?: number,
 *   budgetMs?: number,
 *   clock?: () => number,
 *   focusIndex?: number,
 *   residence?: LyricShaderResidence,
 *   env?: { document?: Document },
 *   reason?: string,
 * } | null | undefined} opts
 * @returns {{ track: LyricTrack, built: number, done: boolean, held: boolean, coalesced: boolean, shaders: { compiled: number, resident: boolean } }}
 */
export function stepLyricPerformance(opts) {
  const o = opts || {};
  const playing = !!o.playing;
  const items = Array.isArray(o.items) ? o.items : [];
  const track = openLyricTrack(String(o.sourceKey || ''), playing, items);
  const reason = playing ? (o.reason || 'show') : 'pause';
  const shaders = retainLyricShaders(reason, o.residence, o.nowMs, o.env);
  if (!playing) {
    return { track, built: 0, done: !!track.complete, held: true, coalesced: false, shaders };
  }
  const budget = Number.isFinite(Number(o.budgetMs)) ? Number(o.budgetMs) : LYRIC_BUILD_BUDGET_MS;
  const stepped = buildLyricTrack(track, items, o.duration, budget, finite(Number(o.nowMs), 0), o.clock, o.focusIndex);
  return {
    track,
    built: stepped.built,
    done: stepped.done,
    held: false,
    coalesced: !!stepped.coalesced,
    shaders,
  };
}

/**
 * 暂停时全屏页已经摆好的当前句不要拆掉。拖进度或换句才重画。
 * @param {{ playing?: boolean, seeked?: boolean, sameLine?: boolean, hasLayout?: boolean } | null | undefined} state
 * @returns {'keep' | 'paint'}
 */
export function lyricLayoutDecision(state) {
  const s = state || {};
  if (!s.playing && !s.seeked && s.sameLine && s.hasLayout) return 'keep';
  return 'paint';
}

/**
 * 桌面歌词窗口只在换歌时收一整份歌词。
 * 暂停和恢复同一首都不重发，窗口继续用已经建好的行。
 * @param {boolean} songChanged
 * @param {boolean} [_playing]
 * @returns {boolean}
 */
export function shouldAttachDesktopLyrics(songChanged, _playing) {
  return !!songChanged;
}

/**
 * 桌面窗口用来认出「还是这一轨」。一样就不拆 DOM。
 * @param {readonly {t?: number, text?: string}[] | null | undefined} list
 * @returns {string}
 */
export function desktopTrackSignature(list) {
  if (!Array.isArray(list) || !list.length) return '';
  let out = String(list.length);
  for (let i = 0; i < list.length; i++) {
    const line = list[i] || {};
    const text = typeof line.text === 'string' ? line.text : '';
    out += `\n${line.t}\t${text}`;
  }
  return out;
}

/**
 * @returns {LyricShaderResidence}
 */
export function createLyricShaderResidence() {
  return {
    programs: {},
    compiles: 0,
    warmed: false,
    surface: null,
  };
}

/** @type {LyricShaderResidence | null} */
let shaderResidence = null;

/** 进程里唯一的一份。全屏页关掉、舞台卸掉，程序还在。 */
export function lyricShaderResidence() {
  if (!shaderResidence) shaderResidence = createLyricShaderResidence();
  return shaderResidence;
}

/**
 * @param {string} name
 * @param {number} now
 * @returns {LyricShaderProgram}
 */
function compileLyricProgram(name, now) {
  return {
    name,
    resident: true,
    compiledAt: now,
    feature: SHADER_FEATURE[name] || name,
  };
}

/**
 * 把光带会用到的合成挂进文档一次。节点留在 residence 上，谁都不要摘。
 * @param {LyricShaderResidence} box
 * @param {{ document?: Document } | null | undefined} env
 */
function attachWarmSurface(box, env) {
  if (box.surface) return;
  const doc = (env && env.document) || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') return;
  let el;
  try {
    el = doc.createElement('span');
  } catch {
    return;
  }
  if (!el) return;
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('data-lyric-shader-warm', '');
    el.setAttribute('aria-hidden', 'true');
  }
  el.textContent = '词';
  if (el.style) {
    el.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:1px',
      'height:1px',
      'opacity:0',
      'pointer-events:none',
      'overflow:hidden',
      'clip-path:inset(0 35% 0 0)',
      'filter:drop-shadow(0 0 4px currentColor)',
      'background-image:linear-gradient(90deg,transparent,currentColor,transparent)',
      '-webkit-background-clip:text',
      'background-clip:text',
    ].join(';');
  }
  const parent = doc.body || doc.documentElement;
  if (parent && typeof parent.appendChild === 'function') {
    try { parent.appendChild(el); } catch { /* 文档还没好，节点先留在 residence 上 */ }
  }
  box.surface = el;
}

/**
 * 缺的程序才编译。已经在的对象原样返回。
 * @param {LyricShaderResidence | null | undefined} residence
 * @param {number} [nowMs]
 * @param {{ document?: Document } | null | undefined} [env]
 * @returns {{ residence: LyricShaderResidence, compiled: number, resident: boolean }}
 */
export function warmLyricShaders(residence, nowMs, env) {
  const box = residence || lyricShaderResidence();
  const now = finite(Number(nowMs), 0);
  let compiled = 0;
  for (let i = 0; i < LYRIC_SHADER_NAMES.length; i++) {
    const name = LYRIC_SHADER_NAMES[i];
    const have = box.programs[name];
    if (have && have.resident) continue;
    box.programs[name] = compileLyricProgram(name, now);
    box.compiles += 1;
    compiled += 1;
  }
  box.warmed = LYRIC_SHADER_NAMES.every((name) => box.programs[name] && box.programs[name].resident);
  attachWarmSurface(box, env);
  return { residence: box, compiled, resident: box.warmed };
}

/**
 * 显示、恢复、暂停、藏起都不释放程序。第一次才会编译。
 * @param {string} [reason]
 * @param {LyricShaderResidence | null | undefined} [residence]
 * @param {number} [nowMs]
 * @param {{ document?: Document } | null | undefined} [env]
 * @returns {{ residence: LyricShaderResidence, compiled: number, resident: boolean, reason: string, kept: boolean }}
 */
export function retainLyricShaders(reason, residence, nowMs, env) {
  const warmed = warmLyricShaders(residence, nowMs, env);
  return {
    residence: warmed.residence,
    compiled: warmed.compiled,
    resident: warmed.resident,
    reason: reason || 'show',
    kept: warmed.compiled === 0,
  };
}

warmLyricShaders(lyricShaderResidence(), 0);
