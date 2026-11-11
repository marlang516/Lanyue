<script setup lang="ts">
import { ref } from 'vue';
import { ui, toggleTheme, togglePalette, openSearch } from '../../stores/ui';
import { callSafe } from '../../core/bridge';
import Icon from '../common/Icon.vue';
import WindowControls from './WindowControls.vue';

const kw = ref('');
const searchEl = ref<HTMLInputElement | null>(null);

function onEnter(): void {
  const v = kw.value.trim();
  if (!v) return;
  openSearch(v);
}

function focusSearch(): void {
  searchEl.value?.focus();
}

defineExpose({ focusSearch });

function openDownloadDir() {
  callSafe('openFolder', [''], null);
}
</script>

<template>
  <header class="top">
    <div class="drag-blank" aria-hidden="true"></div>

    <form class="ly-search top-search" role="search" @submit.prevent="onEnter">
      <Icon name="search" :size="16" />
      <input
        ref="searchEl"
        v-model="kw"
        placeholder="聚合搜索 8 个平台 · 粘贴链接识别…"
        aria-label="聚合搜索"
        @keydown.enter.prevent="onEnter"
      />
      <kbd>Ctrl K</kbd>
    </form>

    <div class="actions">
      <button class="ly-icon-btn" title="打开下载目录" aria-label="打开下载目录" @click="openDownloadDir">
        <Icon name="folder" />
      </button>
      <button
        class="ly-icon-btn"
        :title="ui.theme === 'dark' ? '切换浅色' : '切换深色'"
        :aria-label="ui.theme === 'dark' ? '切换浅色' : '切换深色'"
        @click="toggleTheme()"
      >
        <Icon :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
      </button>
      <button class="ly-icon-btn" title="命令面板" aria-label="命令面板" @click="togglePalette(true)">
        <Icon name="command" />
      </button>
      <WindowControls />
    </div>
  </header>
</template>

<style scoped>
.top {
  flex-shrink: 0;
  height: var(--topbar-h);
  display: flex; align-items: center; gap: var(--sp-4);
  padding: 0 var(--sp-5) 0 var(--sp-6);
  border-bottom: 1px solid var(--hairline);
  background: var(--glass);
  backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(150%);
  z-index: var(--z-topbar);
}
.drag-blank { flex: 1; min-width: 8px; -webkit-app-region: drag; }

.top-search { width: min(560px, 52vw); flex-shrink: 0; -webkit-app-region: no-drag; }
.top-search kbd {
  font-family: var(--font-mono); font-size: var(--fs-2xs);
  color: var(--ink-3); border: 1px solid var(--hairline);
  border-radius: var(--r-xs); padding: 2px 6px; white-space: nowrap;
}

.actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; -webkit-app-region: no-drag; }
</style>