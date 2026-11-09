<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { ui, togglePalette } from '../../stores/ui';
import NavRail from './NavRail.vue';
import TopBar from './TopBar.vue';
import CommandPalette from './CommandPalette.vue';
import ToastHost from './ToastHost.vue';
import DialogHost from './DialogHost.vue';

/** 模板 ref 占位：当前未消费 TopBar 暴露的 focusSearch */
const topbar = ref<InstanceType<typeof TopBar> | null>(null);

function onGlobalKey(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (e.key === 'Escape' && ui.paletteOpen) {
    togglePalette(false);
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));
</script>

<template>
  <div class="app">
    <NavRail />

    <div class="work">
      <TopBar ref="topbar" />

      <main class="stage">
        <slot />
      </main>

      <div class="player-dock">
        <slot name="player" />
      </div>
    </div>

    <CommandPalette />
    <ToastHost />
    <DialogHost />
  </div>
</template>

<style scoped>
.app {
  position: relative; z-index: 1;
  height: 100%; display: flex; overflow: hidden;
}
.work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.stage {
  flex: 1; min-height: 0; min-width: 0;
  display: flex; flex-direction: column;
  padding: var(--gap-app) var(--gap-app) 0;
  overflow: hidden;
}
.player-dock {
  flex-shrink: 0;
  padding: var(--gap-app);
}
</style>