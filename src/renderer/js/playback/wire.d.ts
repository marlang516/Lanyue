/** 生产播放器经 wire 取流、预热和单源交接。类型给 Vue 播放器用。 */

export interface PlayableHit {
  fileUrl: string;
}

export interface PlayableMiss {
  error: string;
}

export type PlayableResult = PlayableHit | PlayableMiss;

export interface PlayableSong {
  id?: unknown;
  source?: string;
  filePath?: string;
}

export function createPlayableResolver(deps: {
  invoke: (method: string, ...args: unknown[]) => Promise<unknown>;
  localFileUrl?: (filePath: string) => string;
}): (song: PlayableSong, quality: string) => Promise<PlayableResult>;

export interface AudibleWarmup {
  ok: boolean;
  audible?: boolean;
  reason?: string;
}

export interface AudibleHandoff {
  ok: boolean;
  mode: 'handoff' | 'hardCut';
  reason?: string;
  play?: Promise<unknown> | null;
  audibleIds?: string[];
}

export interface AudibleSlots {
  attach(id: string, el: HTMLAudioElement): boolean;
  hiddenWarmup(id: string, src?: string, opts?: { stayHidden?: () => boolean }): AudibleWarmup;
  handoff(
    fromId: string,
    toId: string,
    opts?: { prepare?: (el: HTMLAudioElement) => void },
  ): AudibleHandoff;
  /** 抄这一槽已有 analyser 的一帧频域。不另建节点。 */
  copyFrequency(id: string, target: Uint8Array): boolean;
}

export function createAudibleSlots(deps?: {
  applyOutput?: (el: HTMLAudioElement, gain: number) => void;
  logger?: { warn?: (...args: unknown[]) => void } | null;
  audioContextFactory?: (() => unknown) | null;
}): AudibleSlots;
