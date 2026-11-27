/**
 * 舞台频谱氛围。叠在已经有的封面和微尘上面，不是另一套画面。
 *
 * 柱很矮、颜色跟微尘同一支暖白，只落在画面下沿。歌词所在的中段不铺。
 * 字节由调用方从正在出声的播放槽抄来。这里不建音频图，也不采集环回。
 *
 * 偏好键 spectrumAtmosphere。默认关。没在播的时候一笔都不画。
 * 帧长与 lyricMotion 的 STAGE_FULL_FRAME_MS / STAGE_PROJECTED_FRAME_MS 对齐。
 */

/** @type {string} */
export const SPECTRUM_ATMOSPHERE_PREF_KEY = 'spectrumAtmosphere';

/** 单笔透明度上限。再响也不盖住歌词。 */
export const SPECTRUM_ALPHA_CAP = 0.16;

/** 桌面窗抽样间隔。比满帧疏，避免把整份歌词同步打成高频。 */
export const DESKTOP_SPECTRUM_SAMPLE_MS = 80;

/** 跟 STAGE_FULL_FRAME_MS 同一拍。 */
const FULL_FRAME_MS = 16;

/** 跟 STAGE_PROJECTED_FRAME_MS 同一拍。投射时主窗口隔这么久才动一次。 */
const CHEAP_FRAME_MS = 200;

const FULL_BARS = 16;
const CHEAP_BARS = 8;

const CREAM = 'rgb(255, 248, 236)';

/**
 * @typedef {'off' | 'full' | 'cheap'} SpectrumTier
 * @typedef {'main' | 'fullscreen' | 'desktop'} SpectrumSurface
 */

/**
 * @typedef {object} SpectrumPlan
 * @property {boolean} visible
 * @property {SpectrumTier} tier
 * @property {number} count
 * @property {number} frameMs
 * @property {boolean} blocksPointer
 * @property {boolean} obstructsLyrics
 * @property {boolean} animate
 * @property {SpectrumSurface} surface
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
 * @returns {SpectrumSurface}
 */
function asSurface(surface) {
  if (surface === 'desktop' || surface === 'fullscreen') return surface;
  return 'main';
}

/**
 * @param {SpectrumSurface} surface
 * @returns {SpectrumPlan}
 */
function hiddenPlan(surface) {
  return {
    visible: false,
    tier: 'off',
    count: 0,
    frameMs: 0,
    blocksPointer: false,
    obstructsLyrics: false,
    animate: false,
    surface,
  };
}

/**
 * 只有「开关开着，并且这首正在出声」才画。
 * 桌面那一份还要舞台投射开着。投射时主窗口改便宜档。
 * @param {{
 *   enabled?: boolean,
 *   playing?: boolean,
 *   projecting?: boolean,
 *   surface?: SpectrumSurface,
 *   reducedMotion?: boolean,
 * } | null | undefined} opts
 * @returns {SpectrumPlan}
 */
export function spectrumAtmospherePlan(opts) {
  const o = opts || {};
  const surface = asSurface(o.surface);
  if (!o.enabled || !o.playing || o.reducedMotion) return hiddenPlan(surface);
  if (surface === 'desktop' && !o.projecting) return hiddenPlan(surface);
  const cheap = surface !== 'desktop' && !!o.projecting;
  return {
    visible: true,
    tier: cheap ? 'cheap' : 'full',
    count: cheap ? CHEAP_BARS : FULL_BARS,
    frameMs: cheap ? CHEAP_FRAME_MS : FULL_FRAME_MS,
    blocksPointer: false,
    obstructsLyrics: false,
    animate: true,
    surface,
  };
}

/**
 * 把一帧频域字节收成 count 根 0..1 的柱。满幅也留一截空白，避免画满。
 * @param {ArrayLike<number> | null | undefined} bytes
 * @param {number} count
 * @returns {number[]}
 */
export function shapeBands(bytes, count) {
  const bars = count > 0 ? Math.floor(count) : 0;
  const out = new Array(bars).fill(0);
  if (!bytes || typeof bytes.length !== 'number' || bytes.length <= 0 || !bars) return out;
  const n = bytes.length;
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * n) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / bars));
    let sum = 0;
    for (let j = start; j < end; j++) sum += Number(bytes[j]) || 0;
    const mean = sum / (end - start) / 255;
    out[i] = Math.min(0.72, mean * 0.85);
  }
  return out;
}

/**
 * 几路同时出声时按增益混合。权重不是正数的一路丢掉。
 * @param {Array<{ bytes?: ArrayLike<number>, weight?: number }> | null | undefined} chunks
 * @param {Uint8Array} into
 * @returns {boolean}
 */
export function mixFrequencyChunks(chunks, into) {
  if (!into || typeof into.length !== 'number' || into.length <= 0) return false;
  into.fill(0);
  if (!Array.isArray(chunks) || chunks.length === 0) return false;
  const acc = new Float64Array(into.length);
  let weightSum = 0;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const weight = Number(chunk && chunk.weight);
    const bytes = chunk && chunk.bytes;
    if (!(weight > 0) || !bytes || typeof bytes.length !== 'number') continue;
    const n = Math.min(into.length, bytes.length);
    for (let i = 0; i < n; i++) acc[i] += (Number(bytes[i]) || 0) * weight;
    weightSum += weight;
  }
  if (!(weightSum > 0)) return false;
  for (let i = 0; i < into.length; i++) {
    into[i] = Math.max(0, Math.min(255, Math.round(acc[i] / weightSum)));
  }
  return true;
}

/**
 * 显示中的柱向新的一帧靠一点，桌面抽样不那么一跳一跳。
 * @param {ArrayLike<number> | null | undefined} shown
 * @param {ArrayLike<number> | null | undefined} target
 * @param {number} step
 * @returns {number[]}
 */
export function followBands(shown, target, step) {
  const from = shown && typeof shown.length === 'number' ? shown : [];
  const to = target && typeof target.length === 'number' ? target : [];
  const n = Math.max(from.length, to.length);
  const k = clamp01(step);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = clamp01(from[i]);
    const b = clamp01(to[i]);
    out[i] = a + (b - a) * k;
  }
  return out;
}

/**
 * @param {ArrayLike<number> | null | undefined} bands
 * @returns {number}
 */
function atmosphereEnergy(bands) {
  if (!bands || typeof bands.length !== 'number' || bands.length <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < bands.length; i++) sum += clamp01(bands[i]);
  return sum / bands.length;
}

/**
 * 暖白，只画在下沿。返回这一帧画了几笔。
 * @param {CanvasRenderingContext2D} ctx
 * @param {ArrayLike<number> | null | undefined} bands
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function paintSpectrumAtmosphere(ctx, bands, width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  ctx.clearRect(0, 0, w, h);
  if (!bands || typeof bands.length !== 'number' || !bands.length || w <= 0 || h <= 0) return 0;
  let painted = 0;
  const energy = atmosphereEnergy(bands);
  if (energy > 0.01) {
    const bandH = h * (0.08 + energy * 0.12);
    ctx.globalAlpha = Math.min(SPECTRUM_ALPHA_CAP, 0.03 + energy * 0.05);
    ctx.fillStyle = CREAM;
    ctx.fillRect(0, h - bandH, w, bandH);
    painted += 1;
  }
  const gap = w / bands.length;
  for (let i = 0; i < bands.length; i++) {
    const level = clamp01(bands[i]);
    if (level <= 0.01) continue;
    const bh = level * h * 0.22;
    if (bh < 0.5) continue;
    ctx.globalAlpha = Math.min(SPECTRUM_ALPHA_CAP, 0.045 + level * 0.09);
    ctx.fillStyle = CREAM;
    const bw = Math.max(1, gap * 0.62);
    ctx.fillRect(i * gap + (gap - bw) / 2, h - bh, bw, bh);
    painted += 1;
  }
  ctx.globalAlpha = 1;
  return painted;
}

/**
 * 便宜档隔开 frameMs。满帧档每一拍都可以画。
 * @param {number} lastPaintMs
 * @param {number} nowMs
 * @param {SpectrumPlan | null | undefined} plan
 * @returns {boolean}
 */
export function shouldPaintSpectrum(lastPaintMs, nowMs, plan) {
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
 * @typedef {object} SpectrumFrame
 * @property {boolean} enabled
 * @property {boolean} projecting
 * @property {boolean} playing
 * @property {number[]} bands
 * @property {SpectrumPlan} plan
 */

/**
 * 桌面窗收一帧。缺的字段沿用上一帧，歌词不在这里。
 * 只带 spectrum 的抽样因此不会把播放态或投射态清掉。
 * @param {{ enabled?: boolean, projecting?: boolean, playing?: boolean, bands?: number[] } | null | undefined} state
 * @param {{ spectrumAtmosphere?: boolean, stage?: boolean, playing?: boolean, spectrum?: number[] } | null | undefined} data
 * @returns {SpectrumFrame}
 */
export function foldSpectrumFrame(state, data) {
  const prev = state || {};
  const packet = data || {};
  const next = {
    enabled: !!prev.enabled,
    projecting: !!prev.projecting,
    playing: !!prev.playing,
    bands: Array.isArray(prev.bands) ? prev.bands.map((v) => clamp01(v)) : [],
  };
  if (typeof packet.spectrumAtmosphere === 'boolean') next.enabled = packet.spectrumAtmosphere;
  if (typeof packet.stage === 'boolean') next.projecting = packet.stage;
  if (typeof packet.playing === 'boolean') next.playing = packet.playing;
  if (Array.isArray(packet.spectrum)) next.bands = packet.spectrum.map((v) => clamp01(v));
  return {
    ...next,
    plan: spectrumAtmospherePlan({
      enabled: next.enabled,
      playing: next.playing,
      projecting: next.projecting,
      surface: 'desktop',
    }),
  };
}

/**
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @param {ArrayLike<number>} bands
 */
function paintNode(canvas, bands) {
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
  paintSpectrumAtmosphere(ctx, bands, cssW, cssH);
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
 * 桌面窗自己的循环。柱来自上一帧抽样，不在这扇窗里读音频。
 * @param {HTMLCanvasElement | null | undefined} canvas
 * @param {{
 *   requestFrame?: (cb: (now: number) => void) => number,
 *   cancelFrame?: (id: number) => void,
 *   timeout?: (cb: () => void, ms: number) => number,
 *   clearTimer?: (id: number) => void,
 * } | null | undefined} [host]
 * @returns {{ apply: (data: { spectrumAtmosphere?: boolean, stage?: boolean, playing?: boolean, spectrum?: number[] } | null | undefined) => SpectrumPlan, destroy: () => void }}
 */
export function mountDesktopSpectrum(canvas, host) {
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

  let frameState = foldSpectrumFrame(null, null);
  /** @type {number[]} */
  let shown = [];
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
   */
  function frame(now) {
    raf = 0;
    if (!alive || !frameState.plan.visible) return;
    if (shouldPaintSpectrum(last, now, frameState.plan)) {
      last = now;
      shown = followBands(shown, frameState.bands, 0.42);
      paintNode(canvas, shown);
    }
    if (frameState.plan.tier === 'cheap') {
      timer = later(() => {
        timer = 0;
        if (alive) raf = requestFrame(frame);
      }, frameState.plan.frameMs);
      return;
    }
    raf = requestFrame(frame);
  }

  /**
   * @param {{ spectrumAtmosphere?: boolean, stage?: boolean, playing?: boolean, spectrum?: number[] } | null | undefined} data
   * @returns {SpectrumPlan}
   */
  function apply(data) {
    frameState = foldSpectrumFrame(frameState, data);
    const plan = frameState.plan;
    if (canvas) {
      canvas.hidden = !plan.visible;
      canvas.setAttribute('data-spectrum-atmosphere', plan.visible ? plan.tier : 'off');
    }
    if (!plan.visible) {
      stop();
      shown = [];
      clearNode(canvas);
      return plan;
    }
    if (!raf && !timer) raf = requestFrame(frame);
    return plan;
  }

  function destroy() {
    alive = false;
    stop();
  }

  return { apply, destroy };
}
