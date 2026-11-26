/** 与 fade.js 的 FADE_STEPS 同一张表：关 / 500 / 1000 / 2000。 */
export const CROSSFADE_STEPS: readonly number[];

/** prefs 键 crossfadeMs。 */
export const CROSSFADE_PREF_KEY: string;

export function crossfadeStepLabel(ms: number): string;
export function normalizeCrossfadeMs(value: unknown): number;

export function crossfadeTailBounds(fadeMs: number): {
  minRemainingMs: number;
  maxRemainingMs: number;
};

export interface CrossfadeDecision {
  mode: 'none' | 'hardCut';
  durationMs: number;
  midpointMs: number;
  fadeOutMs: number;
  fadeInMs: number;
  reason: string;
}

export function decideCrossfade(opts?: {
  fadeMs?: number;
  enabled?: boolean;
  preloadOk?: boolean;
  remainingMs?: number | null;
  sameStream?: boolean;
  predictable?: boolean;
  trigger?: 'manual' | 'auto';
}): CrossfadeDecision;

/** 单源交接默认提前量（ms）。交叉档位开着时改用那一档。 */
export const HANDOFF_LEAD_MS: number;

/** prefs 键 singleSourceHandoff。 */
export const HANDOFF_PREF_KEY: string;

export interface TrackTransitionDecision {
  mode: 'none' | 'hardCut' | 'handoff';
  durationMs: number;
  midpointMs: number;
  fadeOutMs: number;
  fadeInMs: number;
  reason: string;
  leadMs?: number;
}

/** handoff 为 false 时与 decideCrossfade 相同；为 true 时成功路径是单源交接。 */
export function decideTrackTransition(opts?: {
  handoff?: boolean;
  fadeMs?: number;
  enabled?: boolean;
  preloadOk?: boolean;
  remainingMs?: number | null;
  sameStream?: boolean;
  predictable?: boolean;
  trigger?: 'manual' | 'auto';
}): TrackTransitionDecision;

/** 元素实际音量 = 用户音量 × 交叉增益。 */
export function audibleVolume(userVolume: number, gain: number): number;

export interface CrossfadeController {
  start(opts?: {
    fromId?: string;
    toId?: string;
    fadeOutMs?: number;
    fadeInMs?: number;
    preloadOk?: boolean;
  }): CrossfadeDecision;
  step(currentTs?: number): void;
  abort(reason?: string): boolean;
  setTick(fn: ((step: (now?: number) => void) => { cancel?: () => void } | number | void) | null): void;
}

export function createCrossfadeController(deps: {
  now?: () => number;
  setGain: (id: string, gain: number) => void;
  onPrimaryChange?: ((id: string) => void) | null;
  onMetadataSwap?: ((id: string) => void) | null;
  onRelease?: ((id: string) => void) | null;
  logger?: { warn?: (...args: unknown[]) => void } | null;
}): CrossfadeController;
