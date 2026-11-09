/**
 * app/player.ts —— 兼容层
 * 旧 HomeView / LyPlayerBar 曾从这里引用播放方法；P1 起唯一实现迁到
 * stores/player.ts，这里只做 re-export，避免存在第二套播放状态。
 */
export {
  player,
  hasCurrent,
  currentKey,
  setQueue,
  playFromList,
  playSong,
  togglePlay,
  seekTo,
  setVolume,
  setQuality,
  cycleMode,
  next,
  prev,
  removeFromQueue,
  clearQueue,
  appendToQueue,
  persistQueue,
  restoreQueue,
  setRate,
} from './stores/player';