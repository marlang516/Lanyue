/**
 * 封面微尘。叠在已经有的封面上面，不是另一套画面。
 *
 * 光点很小、很淡，跟着播放轻轻漂。歌词所在的中段再淡一档。
 * 不读频谱，也不建音频图。关掉时一粒都不造。
 *
 * 画价跟舞台同一档：投射开着时主窗口少画，桌面那一份可以按满帧走。
 * 帧长与 lyricMotion 的 STAGE_FULL_FRAME_MS / STAGE_PROJECTED_FRAME_MS 对齐，
 * 测试钉住这两处，避免这里另起一套节奏。
 *
 * 偏好键 coverParticles。默认关。
 */

/** @type {string} */
export const COVER_PARTICLES_PREF_KEY = 'coverParticles';

/** 跟 STAGE_FULL_FRAME_MS 同一拍。 */
const FULL_FRAME_MS = 16;

/** 跟 STAGE_PROJECTED_FRAME_MS 同一拍。投射时主窗口隔这么久才动一次。 */
const CHEAP_FRAME_MS = 200;

const FULL_COUNT = 28;
const CHEAP_COUNT = 9;

/**
 * @typedef {object} CoverMote
 * @property {number} x
 * @property {number} y
 * @property {number} r
 * @property {number} phase
 * @property {number} speed
 * @property {number} drift
 * @property {number} alpha
 */

/**
 * @typedef {object} CoverDustField
 * @property {CoverMote[]} motes
 * @property {number} seed
 */

/**
 * @typedef {'off' | 'full' | 'cheap'} CoverDustTier
 * @typedef {'main' | 'fullscreen' | 'desktop'} CoverDustSurface
 */

/**
 * @typedef {object} CoverDustPlan
 * @property {boolean} visible
 * @property {CoverDustTier} tier
 * @property {number} count
 * @property {number} frameMs
 * @property {boolean} blocksPointer
 * @property {boolean} obstructsLyrics
 * @property {boolean} animate
 * @property {CoverDustSurface} surface
 */

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * @param {unknown} surface
 * @returns {CoverDustSurface}
 */
function asSurface(surface) {
  if (surface === 'desktop' || surface === 'fullscreen') return surface;
  return 'main';
}

/**
 * @param {{
 *   enabled?: boolean,
 *   projecting?: boolean,
 *   surface?: CoverDustSurface,
 *   reducedMotion?: boolean,
 * } | null | undefined} opts
 * @returns {CoverDustPlan}
 */
export function coverDustPlan(opts) {
  const o = opts || {};
  const surface = asSurface(o.surface);
  const enabled = !!o.enabled;
  const projecting = !!o.projecting;
  /** @type {CoverDustPlan} */
  const hidden = {
    visible: false,
    tier: 'off',
    count: 0,
    frameMs: 0,
    blocksPointer: false,
    obstructsLyrics: false,
    animate: false,
    surface,
  };
  if (!enabled) return hidden;
  if (surface === 'desktop') {
    if (!projecting) return hidden;
    return {
      visible: true,
      tier: 'full',
      count: FULL_COUNT,
      frameMs: FULL_FRAME_MS,
      blocksPointer: false,
      obstructsLyrics: false,
      animate: !o.reducedMotion,
      surface,
    };
  }
  if (projecting) {
    return {
      visible: true,
      tier: 'cheap',
      count: CHEAP_COUNT,
      frameMs: CHEAP_FRAME_MS,
      blocksPointer: false,
      obstructsLyrics: false,
      animate: !o.reducedMotion,
      surface,
    };
  }
  return {
    visible: true,
    tier: 'full',
    count: FULL_COUNT,
    frameMs: FULL_FRAME_MS,
    blocksPointer: false,
    obstructsLyrics: false,
    animate: !o.reducedMotion,
    surface,
  };
}

/**
 * 桌面窗只在「舞台投射开着，并且微尘也开着」时画。
 * @param {{ stage?: boolean, coverParticles?: boolean } | null | undefined} data
 * @returns {CoverDustPlan}
 */
export function readDesktopCoverDust(data) {
  const packet = data || {};
  return coverDustPlan({
    enabled: !!packet.coverParticles,
    projecting: !!packet.stage,
    surface: 'desktop',
  });
}

/**
 * @param {number} count
 * @param {number} [seed]
 * @returns {CoverDustField}
 */
export function createCoverDust(count, seed) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  let state = Number(seed) >>> 0;
  if (!state) state = 1;
  const rnd = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  /** @type {CoverMote[]} */
  const motes = [];
  for (let i = 0; i < n; i++) {
    motes.push({
      x: rnd(),
      y: rnd(),
      r: 0.7 + rnd() * 1.5,
      phase: rnd() * Math.PI * 2,
      speed: 0.008 + rnd() * 0.014,
      drift: (rnd() - 0.5) * 0.35,
      alpha: 0.07 + rnd() * 0.14,
    });
  }
  return { motes, seed: (Number(seed) >>> 0) || 1 };
}

/**
 * 往上轻轻漂。rhythm 只改变快慢，不改歌词。
 * animate 为 false 时原样返回（减弱动效）。
 * @param {CoverDustField | null | undefined} field
 * @param {number} nowMs
 * @param {number} rhythm
 * @param {number} dtMs
 * @param {boolean} [animate]
 * @returns {CoverDustField | null | undefined}
 */
export function stepCoverDust(field, nowMs, rhythm, dtMs, animate) {
  if (!field || !Array.isArray(field.motes)) return field;
  if (animate === false) return field;
  const dt = Math.max(0, Math.min(Number(dtMs) || 0, 400)) / 1000;
  if (!(dt > 0)) return field;
  const pulse = clamp01(rhythm);
  const lift = 0.012 * (0.55 + pulse * 0.9);
  const t = Number(nowMs) || 0;
  for (let i = 0; i < field.motes.length; i++) {
    const mote = field.motes[i];
    if (!mote) continue;
    mote.x += Math.sin(t * 0.001 * 0.45 + mote.phase) * mote.drift * dt;
    mote.y -= (mote.speed + lift) * dt;
    if (mote.y < -0.02) mote.y += 1.04;
    if (mote.x < -0.05) mote.x += 1.1;
    else if (mote.x > 1.05) mote.x -= 1.1;
  }
  return field;
}

/**
 * 播放中的一句呼吸。传入 level 时把它当成单一响度（0..1），不拆频段。
 * @param {{ playing?: boolean, seconds?: number, accent?: number, level?: number } | null | undefined} input
 * @returns {number}
 */
export function coverRhythm(input) {
  const src = input || {};
  const level = Number(src.level);
  if (Number.isFinite(level)) return clamp01(level);
  if (!src.playing) return 0;
  const seconds = Number(src.seconds);
  const t = Number.isFinite(seconds) ? seconds : 0;
  const pulse = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 2.8);
  return clamp01(0.2 + pulse * 0.34 + clamp01(Number(src.accent)) * 0.28);
}

/**
 * 一整段采样的平均响度。不是频谱条。
 * @param {ArrayLike<number> | null | undefined} bytes
 * @returns {number}
 */
export function rhythmFromBytes(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += Number(bytes[i]) || 0;
  return clamp01(sum / bytes.length / 255);
}

/**
 * 歌词带（纵向中段）更淡，避免光点铺在字上。
 * @param {{ y?: number, alpha?: number } | null | undefined} mote
 * @param {number} rhythm
 * @returns {number}
 */
export function motePaintAlpha(mote, rhythm) {
  const y = Number(mote && mote.y);
  const base = Number(mote && mote.alpha);
  if (!Number.isFinite(y) || !Number.isFinite(base) || base <= 0) return 0;
  const band = Math.abs(y - 0.5) < 0.16 ? 0.28 : 1;
  const pulse = 0.72 + clamp01(rhythm) * 0.4;
  return Math.min(0.3, base * band * pulse);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {CoverDustField | null | undefined} field
 * @param {number} width
 * @param {number} height
 * @param {number} rhythm
 * @returns {number}
 */
export function paintCoverDust(ctx, field, width, height, rhythm) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  ctx.clearRect(0, 0, w, h);
  if (!field || w <= 0 || h <= 0) return 0;
  const motes = field.motes || [];
  let painted = 0;
  for (let i = 0; i < motes.length; i++) {
    const mote = motes[i];
    if (!mote) continue;
    const alpha = motePaintAlpha(mote, rhythm);
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgb(255, 248, 236)';
    ctx.beginPath();
    ctx.arc(mote.x * w, mote.y * h, mote.r, 0, Math.PI * 2);
    ctx.fill();
    painted += 1;
  }
  ctx.globalAlpha = 1;
  return painted;
}

/**
 * 便宜档隔开 frameMs。满帧档每一拍都可以画。
 * 判定与 shouldPaintMainStage 同一条：便宜档才限频。
 * @param {number} lastPaintMs
 * @param {number} nowMs
 * @param {CoverDustPlan | null | undefined} plan
 * @returns {boolean}
 */
export function shouldPaintCoverDust(lastPaintMs, nowMs, plan) {
  if (!plan || !plan.visible) return false;
  if (plan.tier !== 'cheap') return true;
  const frame = plan.frameMs > 0 ? plan.frameMs : CHEAP_FRAME_MS;
  const now = Number(nowMs);
  const last = Number(lastPaintMs);
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(last) || last < 0) return true;
  return now - last >= frame;
}

/**
 * 与 lyricMotion.desktopTrackSignature 同一算法。
 * 只给桌面消息判断「歌词变没变」。微尘开关不算变轨。
 * @param {readonly { t?: number, text?: string }[] | null | undefined} list
 * @returns {string}
 */
function sameLyricSignature(list) {
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
 * 桌面窗收一帧。coverParticles 只改微尘计划。
 * 歌词签名没变就不换数组、不改当前行。
 * @param {{ lyrics?: readonly { t?: number, text?: string }[], lyricSig?: string, curIdx?: number } | null | undefined} state
 * @param {{ stage?: boolean, coverParticles?: boolean, lyrics?: readonly { t?: number, text?: string }[] } | null | undefined} data
 * @returns {{ lyrics: readonly { t?: number, text?: string }[], lyricSig: string, curIdx: number, rebuilt: boolean, cover: CoverDustPlan }}
 */
export function foldDesktopLyricFrame(state, data) {
  const prev = state || {};
  const lyrics = Array.isArray(prev.lyrics) ? prev.lyrics : [];
  const lyricSig = typeof prev.lyricSig === 'string' ? prev.lyricSig : '';
  const curIdx = Number.isFinite(Number(prev.curIdx)) ? Number(prev.curIdx) : -1;
  const next = {
    lyrics,
    lyricSig,
    curIdx,
    rebuilt: false,
    cover: readDesktopCoverDust(data),
  };
  if (data && Object.prototype.hasOwnProperty.call(data, 'lyrics')) {
    const list = Array.isArray(data.lyrics) ? data.lyrics : [];
    const sig = sameLyricSignature(list);
    if (sig !== lyricSig) {
      next.lyrics = list;
      next.lyricSig = sig;
      next.curIdx = -2;
      next.rebuilt = true;
    }
  }
  return next;
}

/**
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @param {CoverDustField | null | undefined} field
 * @param {number} rhythm
 */
function paintNode(canvas, field, rhythm) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const cssW = canvas.clientWidth || 0;
  const cssH = canvas.clientHeight || 0;
  if (cssW < 2 || cssH < 2) return;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const w = Math.floor(cssW * dpr);
  const h = Math.floor(cssH * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintCoverDust(ctx, field, cssW, cssH, rhythm);
}

/**
 * @param {HTMLCanvasElement | null | undefined} canvas
 */
function clearNode(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
}

/**
 * 桌面窗自己的循环。满帧走，不占用主窗口的便宜档。
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @param {{
 *   requestFrame?: (cb: (now: number) => void) => number,
 *   cancelFrame?: (id: number) => void,
 *   timeout?: (cb: () => void, ms: number) => number,
 *   clearTimer?: (id: number) => void,
 * } | null | undefined} [host]
 * @returns {{ apply: (data: { stage?: boolean, coverParticles?: boolean, playing?: boolean, currentTime?: number } | null | undefined) => CoverDustPlan, destroy: () => void }}
 */
export function mountDesktopCoverDust(canvas, host) {
  /** @type {(cb: (now: number) => void) => number} */
  const requestFrame = host && host.requestFrame
    ? host.requestFrame
    : (cb) => requestAnimationFrame(cb);
  /** @type {(id: number) => void} */
  const cancelFrame = host && host.cancelFrame
    ? host.cancelFrame
    : (id) => cancelAnimationFrame(id);
  /** @type {(cb: () => void, ms: number) => number} */
  const later = host && host.timeout
    ? host.timeout
    : (cb, ms) => window.setTimeout(cb, ms);
  /** @type {(id: number) => void} */
  const clearLater = host && host.clearTimer
    ? host.clearTimer
    : (id) => window.clearTimeout(id);

  let field = createCoverDust(0, 1);
  let plan = coverDustPlan({ enabled: false, projecting: false, surface: 'desktop' });
  let playing = false;
  let seconds = 0;
  let anchorMs = 0;
  let last = -1;
  let raf = 0;
  let timer = 0;
  let alive = true;

  function stop() {
    if (raf) cancelFrame(raf);
    raf = 0;
    if (timer) clearLater(timer);
    timer = 0;
  }

  /**
   * @param {number} now
   * @returns {number}
   */
  function rhythmAt(now) {
    const elapsed = playing ? Math.max(0, now - anchorMs) / 1000 : 0;
    return coverRhythm({ playing, seconds: seconds + elapsed });
  }

  /**
   * @param {number} now
   */
  function frame(now) {
    raf = 0;
    if (!alive || !plan.visible) return;
    if (shouldPaintCoverDust(last, now, plan)) {
      const dt = last < 0 ? plan.frameMs : now - last;
      last = now;
      const rhythm = rhythmAt(now);
      stepCoverDust(field, now, rhythm, dt, plan.animate);
      paintNode(canvas, field, rhythm);
    }
    if (plan.tier === 'cheap') {
      timer = later(() => {
        timer = 0;
        if (alive) raf = requestFrame(frame);
      }, plan.frameMs);
      return;
    }
    raf = requestFrame(frame);
  }

  /**
   * @param {{ stage?: boolean, coverParticles?: boolean, playing?: boolean, currentTime?: number } | null | undefined} data
   * @returns {CoverDustPlan}
   */
  function apply(data) {
    const packet = data || {};
    if (typeof packet.playing === 'boolean') playing = packet.playing;
    if (typeof packet.currentTime === 'number' && Number.isFinite(packet.currentTime)) {
      seconds = packet.currentTime;
      anchorMs = typeof performance !== 'undefined' ? performance.now() : 0;
    }
    plan = readDesktopCoverDust(packet);
    if (canvas) {
      canvas.hidden = !plan.visible;
      canvas.setAttribute('data-cover-dust', plan.visible ? plan.tier : 'off');
    }
    if (!plan.visible) {
      stop();
      field = createCoverDust(0, 1);
      clearNode(canvas);
      return plan;
    }
    if (field.motes.length !== plan.count) field = createCoverDust(plan.count, 11);
    if (!raf && !timer) raf = requestFrame(frame);
    return plan;
  }

  function destroy() {
    alive = false;
    stop();
  }

  return { apply, destroy };
}
