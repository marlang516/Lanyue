<script setup lang="ts">
import { onMounted } from 'vue';
import { recent, loadRecent, clearRecent } from '../core/recent';
import { player, currentKey, playFromList } from '../stores/player';
import { confirmDialog } from '../core/dialog';
import SongTable from '../components/data/SongTable.vue';
import Icon from '../components/common/Icon.vue';

onMounted(loadRecent);

function onPlay(i: number) {
  if (recent.items[i]) playFromList(recent.items, i);
}

async function onClear() {
  const ok = await confirmDialog({ title: '清空最近播放', body: '只清空列表，不会删除任何文件。', danger: true, okText: '清空' });
  if (!ok) return;
  clearRecent();
}
</script>

<template>
  <div class="rv">
    <section class="head ly-card">
      <div class="htx">
        <div class="tag">RECENTLY PLAYED</div>
        <h2>最近播放</h2>
        <p>保留最近 {{ recent.items.length }} / 50 首，双击任意一首继续播放</p>
      </div>
      <button class="ly-btn ly-btn-danger" :disabled="!recent.items.length" @click="onClear">
        <Icon name="trash" :size="14" /> 清空
      </button>
    </section>

    <section class="body ly-card">
      <SongTable
        :songs="recent.items" :active-key="currentKey" empty-text="还没有播放记录"
        @play="onPlay"
      />
    </section>
  </div>
</template>

<style scoped>
.rv { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--gap-app); }
.head { flex-shrink: 0; display: flex; align-items: flex-end; gap: var(--sp-4); padding: var(--sp-5) var(--sp-6); }
.htx { flex: 1; }
.tag { font-size: var(--fs-2xs); letter-spacing: .28em; color: var(--au-1); font-weight: var(--fw-bold); }
h2 { margin-top: var(--sp-2); font-size: var(--fs-2xl); font-weight: var(--fw-black); }
p { margin-top: var(--sp-2); font-size: var(--fs-xs); color: var(--ink-3); }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-4) var(--sp-5); overflow: hidden; }
</style>