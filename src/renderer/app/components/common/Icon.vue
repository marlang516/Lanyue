<script setup lang="ts">
/**
 * Icon —— 内联 SVG 图标库（不引入第三方图标包）
 * 统一 24×24 viewBox、1.8 描边、currentColor；填充型图标单独标 fill。
 */

/** 单个图标：一段 d，或需要多段描边的 d 数组 */
type IconPath = string | string[];

interface IconProps {
  /** 图标名（PATHS 的键）；未收录的键渲染为空 svg，与原行为一致 */
  name: string;
  /** 尺寸：数字按 px，字符串原样传给 svg 的 width/height */
  size?: number | string;
}

const props = withDefaults(defineProps<IconProps>(), {
  size: 17,
});

// 路径表：d 可能有多段；fill 标记的图标不做描边
const PATHS: Readonly<Record<string, IconPath>> = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  search: ['M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-4.2-4.2'],
  library: ['M4 6h16M4 12h16M4 18h10', 'M18 15v5M15 18h6'],
  clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  download: ['M12 3v12', 'M6 9l6 6 6-6', 'M4 21h16'],
  playlist: ['M9 18V5l12-2v13', 'M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0'],
  rss: ['M4 11a9 9 0 0 1 9 9', 'M4 4a16 16 0 0 1 16 16', 'M5 19m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0'],
  converter: ['M4 7h12l-3-3M20 17H8l3 3', 'M4 7h16'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 3l.7 2.3L22 6l-2.3.7L19 9l-.7-2.3L16 6l2.3-.7z'],
  assistant: ['M12 3a7 7 0 0 1 7 7v3a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-3a7 7 0 0 1 7-7z', 'M9 10h.01M15 10h.01', 'M9 14c1 .8 2 1.2 3 1.2s2-.4 3-1.2'],
  settings: ['M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z', 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  minimize: ['M2 6h8'],
  maximize: ['M2.5 2.5h7v7h-7z'],
  close: ['M3 3l6 6M9 3l-6 6'],
  play: ['M8 5v14l11-7z'],
  pause: ['M6 5h4v14H6zM14 5h4v14h-4z'],
  prev: ['M11 19L2 12l9-7v14zM22 19l-9-7 9-7v14z'],
  next: ['M13 19l9-7-9-7v14zM2 19l9-7-9-7v14z'],
  volume: ['M11 5L6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  volumeMute: ['M11 5L6 9H2v6h4l5 4z', 'M16 9l5 6M21 9l-5 6'],
  queue: ['M8 6h13M8 12h13M8 18h13', 'M3 6h.01M3 12h.01M3 18h.01'],
  heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  sort: ['M7 4v16M3 8l4-4 4 4', 'M17 20V4M13 16l4 4 4-4'],
  filter: ['M3 5h18l-7 8v6l-4 2v-8z'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 15h10l1-15', 'M10 11v6M14 11v6'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  plus: ['M12 5v14M5 12h14'],
  check: ['M4 12l5 5L20 6'],
  x: ['M5 5l14 14M19 5L5 19'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  list: ['M8 6h13M8 12h13M8 18h13', 'M3 6h.01M3 12h.01M3 18h.01'],
  music: ['M9 18V5l12-2v13', 'M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M18 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0'],
  disc: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z', 'M12 12h.01'],
  mic: ['M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  upload: ['M12 21V9', 'M6 15l6-6 6 6', 'M4 3h16'],
  cloud: ['M18 18h1a4 4 0 0 0 0-8 6 6 0 0 0-11.6-2A4.5 4.5 0 0 0 6 18h2', 'M12 12v7M9 16l3-3 3 3'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  equalizer: ['M4 20V10M10 20V4M16 20v-7M22 20V7'],
  sleep: ['M4 6h9L4 15h9', 'M14 14h6l-6 7h6'],
  link: ['M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z'],
  'eye-off': ['M3 3l18 18', 'M10.6 10.6a3 3 0 0 0 4.2 4.2', 'M9.9 5.2A10.5 10.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.7 3.4', 'M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7a10 10 0 0 0 4.1-.9'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  external: ['M14 3h7v7', 'M10 14L21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  info: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 11v6M12 8h.01'],
  warning: ['M12 3L2 21h20z', 'M12 9v5M12 17h.01'],
  star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z'],
  tag: ['M20 13l-7 7-9-9V3h8z', 'M7 7h.01'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5'],
  wave: ['M3 12h2l2-5 3 10 3-14 3 12 2-3h3'],
  wavePause: ['M3 12h2l2-5 3 10 3-14 3 12 2-3h3'],
  grip: ['M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01'],
  shuffle: ['M16 3h5v5', 'M4 20L21 3', 'M21 16v5h-5', 'M15 15l6 6', 'M4 4l5 5'],
  repeat: ['M17 2l4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'],
  repeatOne: ['M17 2l4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3', 'M11 10h1v5'],
  quote: ['M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4', 'M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4'],
  palette: ['M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h2a3 3 0 0 0 3-3 9 9 0 0 0-10-10z', 'M7 10h.01M10 7h.01M14 7h.01M17 10h.01M9 15h.01'],
  command: ['M9 3a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2', 'M15 3a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2'],
  keyboard: ['M3 6h18v12H3z', 'M7 10h.01M11 10h.01M15 10h.01M7 14h2M12 14h5'],
};

const path = PATHS[props.name];
const isFill = ['play', 'pause', 'prev', 'next'].includes(props.name);
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24"
    :fill="isFill ? 'currentColor' : 'none'"
    :stroke="isFill ? 'none' : 'currentColor'"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false"
  >
    <template v-if="Array.isArray(path)">
      <path v-for="(d, i) in path" :key="i" :d="d" />
    </template>
    <path v-else-if="path" :d="path" />
  </svg>
</template>

<style scoped>
svg { flex-shrink: 0; display: block; }
</style>