<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { songKey } from '../../core/song';
import type { Song } from '../../core/song';

interface DiscoverRankListProps {
  songs?: readonly Song[];
  activeKey?: string;
}

const props = withDefaults(defineProps<DiscoverRankListProps>(), {
  songs: () => [],
  activeKey: '',
});

const emit = defineEmits<{ play: [index: number] }>();

const broken = ref<Set<string>>(new Set());

watch(() => props.songs, () => {
  broken.value = new Set();
});

const first = computed(() => props.songs[0] || null);
const rest = computed(() => props.songs.slice(1));

function isOn(song: Song): boolean {
  return !!props.activeKey && songKey(song) === props.activeKey;
}

function fromOf(song: Song): string {
  return typeof song.from === 'string' ? song.from.trim() : '';
}

function showCover(song: Song): boolean {
  return !!song.cover && !broken.value.has(songKey(song));
}

function breakCover(song: Song): void {
  const key = songKey(song);
  if (!key || broken.value.has(key)) return;
  const next = new Set(broken.value);
  next.add(key);
  broken.value = next;
}

function mark(title: string): string {
  const text = title.trim();
  if (!text || text === '未命名') return '乐';
  return Array.from(text)[0] || '乐';
}

function rankNo(index: number): string {
  return String(index).padStart(2, '0');
}

function playLabel(song: Song): string {
  const state = isOn(song) ? '正在播放' : '播放';
  const who = song.artist || '未知歌手';
  const from = fromOf(song);
  return from ? `${state} ${song.title}，${who}，来自${from}` : `${state} ${song.title}，${who}`;
}
</script>

<template>
  <div v-if="first" class="feed-list">
    <button
      type="button"
      class="hero"
      :class="{ on: isOn(first) }"
      :aria-label="playLabel(first)"
      @click="emit('play', 0)"
    >
      <img
        v-if="showCover(first)"
        class="hero-wash"
        :src="first.cover"
        alt=""
        @error="breakCover(first)"
      />
      <div v-else class="hero-wash fallback"></div>
      <div class="hero-cover" :class="{ ph: !showCover(first) }">
        <img
          v-if="showCover(first)"
          :src="first.cover"
          alt=""
          @error="breakCover(first)"
        />
        <span v-else>{{ mark(first.title) }}</span>
      </div>
      <div class="hero-copy">
        <div class="rank-lg">NO. {{ rankNo(1) }}</div>
        <h3 :title="first.title">{{ first.title }}</h3>
        <p class="sub" :title="`${first.artist || '未知歌手'}${first.album ? ' · ' + first.album : ''}`">
          {{ first.artist || '未知歌手' }}<template v-if="first.album"> · {{ first.album }}</template>
        </p>
        <p v-if="fromOf(first)" class="origin" :title="`来自「${fromOf(first)}」`">来自「{{ fromOf(first) }}」</p>
        <span class="play-now">{{ isOn(first) ? '正在播放' : '播放' }}</span>
      </div>
    </button>

    <div v-if="rest.length" class="rank-list">
      <button
        v-for="(s, i) in rest"
        :key="songKey(s) + '-' + i"
        type="button"
        class="hit"
        :class="{ on: isOn(s) }"
        :aria-current="isOn(s) ? 'true' : undefined"
        :aria-label="playLabel(s)"
        @click="emit('play', i + 1)"
      >
        <span class="no">{{ rankNo(i + 2) }}</span>
        <span class="art" :class="{ ph: !showCover(s) }">
          <img
            v-if="showCover(s)"
            :src="s.cover"
            alt=""
            loading="lazy"
            decoding="async"
            @error="breakCover(s)"
          />
          <span v-else>{{ mark(s.title) }}</span>
        </span>
        <span class="tx">
          <b :title="s.title">{{ s.title }}</b>
          <span>{{ s.artist || '未知歌手' }}</span>
        </span>
        <span v-if="fromOf(s)" class="src" :title="fromOf(s)">{{ fromOf(s) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.feed-list { display: flex; flex-direction: column; padding-bottom: var(--sp-3); }

.hero {
  position: relative;
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  width: 100%;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--stroke);
  border-radius: 22px;
  background: var(--glass-2);
  box-shadow: var(--shadow-card);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}
.hero:hover { background: var(--glass-3); }
.hero:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.hero-wash {
  position: absolute;
  z-index: 0;
  top: -30%;
  left: -8%;
  width: 280px;
  height: 180%;
  max-width: none;
  object-fit: cover;
  filter: blur(26px) saturate(1.15);
  opacity: .5;
  pointer-events: none;
}
.hero-wash.fallback {
  background: radial-gradient(60% 80% at 30% 50%, color-mix(in srgb, var(--au-1) 42%, transparent), transparent 70%);
  filter: none;
  opacity: 1;
}
.hero-cover {
  position: relative;
  z-index: 1;
  width: 132px;
  height: 132px;
  border-radius: 18px;
  overflow: hidden;
  box-shadow: var(--shadow-pop);
  background: var(--glass-3);
}
.hero-cover img { width: 100%; height: 100%; object-fit: cover; }
.hero-cover.ph {
  display: flex;
  align-items: flex-end;
  padding: 12px;
  color: var(--on-accent);
  background: var(--au-grad);
  font-size: 40px;
  font-weight: var(--fw-black);
  letter-spacing: -.06em;
  line-height: 1;
}
.hero-copy { position: relative; z-index: 1; min-width: 0; }
.rank-lg {
  font-size: 11px;
  font-weight: var(--fw-black);
  letter-spacing: .18em;
  color: var(--au-1);
}
.hero-copy h3 {
  margin: 6px 0 0;
  font-size: var(--fs-2xl);
  font-weight: var(--fw-black);
  letter-spacing: -.04em;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub, .origin {
  margin: 6px 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub { font-size: var(--fs-md); color: var(--ink-2); }
.origin { font-size: var(--fs-sm); color: var(--ink-3); }
.play-now {
  display: inline-flex;
  align-items: center;
  margin-top: 12px;
  height: 32px;
  padding: 0 16px;
  border-radius: var(--r-full);
  color: var(--on-accent);
  background: var(--au-grad);
  font-weight: var(--fw-bold);
  box-shadow: var(--glow-accent);
}

.rank-list { display: flex; flex-direction: column; margin-top: 8px; }
.hit {
  display: grid;
  grid-template-columns: 36px 44px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  height: 54px;
  margin: 0;
  padding: 0 8px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease);
}
.hit:hover { background: var(--glass-3); }
.hit:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.hit.on {
  background: linear-gradient(95deg, rgba(124, 92, 255, .13), rgba(0, 198, 255, .1));
}
.no {
  font-size: 15px;
  font-weight: var(--fw-black);
  color: var(--ink-3);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.rank-list .hit:nth-child(-n + 3) .no { color: var(--au-1); }
.art {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--glass-3);
}
.art img { width: 100%; height: 100%; object-fit: cover; }
.art.ph {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 4px;
  color: var(--on-accent);
  background: var(--au-grad);
  font-size: 13px;
  font-weight: var(--fw-black);
  line-height: 1;
}
.tx { min-width: 0; }
.tx b, .tx span {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tx b { font-size: var(--fs-md); font-weight: var(--fw-bold); }
.tx span { margin-top: 2px; font-size: var(--fs-sm); color: var(--ink-3); }
.src {
  max-width: 180px;
  justify-self: end;
  font-size: 11px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
