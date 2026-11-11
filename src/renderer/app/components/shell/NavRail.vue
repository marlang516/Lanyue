<script setup lang="ts">
import { computed } from 'vue';
import { ui, NAV_ITEMS, setView } from '../../stores/ui';
import Icon from '../common/Icon.vue';

const items = computed(() => NAV_ITEMS);
</script>

<template>
  <nav class="rail" aria-label="主导航">
    <div class="mark" title="揽乐" aria-hidden="true">揽</div>

    <div class="list">
      <button
        v-for="it in items" :key="it.id"
        class="rbtn" :class="{ on: ui.view === it.id }"
        :title="it.label" :aria-label="it.label" :aria-current="ui.view === it.id ? 'page' : undefined"
        @click="setView(it.id)"
      >
        <Icon :name="it.icon" :size="20" />
      </button>
    </div>

    <button
      class="rbtn" :class="{ on: ui.view === 'settings' }"
      title="设置" aria-label="设置"
      @click="setView('settings')"
    >
      <Icon name="settings" :size="20" />
    </button>
  </nav>
</template>

<style scoped>
.rail {
  width: var(--rail-w); flex-shrink: 0;
  display: flex; flex-direction: column; align-items: center;
  padding: var(--sp-5) var(--sp-2);
  border-radius: var(--r-xl);
  background: var(--glass);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--stroke);
  box-shadow: var(--shadow-card);
  z-index: var(--z-rail);
}
[data-theme="dark"] .rail {
  background: var(--glass);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .45);
}

.mark {
  width: 42px; height: 42px; border-radius: 14px;
  background: var(--au-grad-3);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display);
  font-weight: var(--fw-black); color: #fff; font-size: 17px;
  box-shadow: var(--glow-accent);
  flex-shrink: 0;
  user-select: none;
}

.rbtn {
  position: relative;
  width: 46px; height: 44px; border: 0; border-radius: 15px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--ink-3); cursor: pointer;
  transition: background var(--dur-1) var(--ease),
              color var(--dur-1) var(--ease),
              box-shadow var(--dur-1) var(--ease),
              transform var(--dur-0) var(--ease);
}
.rbtn:hover { color: var(--ink-2); background: var(--glass-3); }
.rbtn:active { transform: scale(.94); }
.rbtn.on {
  color: #fff;
  background: var(--au-grad);
  box-shadow: var(--glow-accent);
}
<style scoped>
.rail {
  width: var(--rail-w); flex-shrink: 0;
  display: flex; flex-direction: column; align-items: center;
  padding: var(--sp-5) var(--sp-2);
  border-radius: var(--r-xl);
  background: var(--glass);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--stroke);
  box-shadow: var(--shadow-card);
  z-index: var(--z-rail);
}
[data-theme="dark"] .rail {
  background: var(--glass);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .45);
}

.mark {
  width: 42px; height: 42px; border-radius: 14px;
  background: var(--au-grad-3);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display);
  font-weight: var(--fw-black); color: #fff; font-size: 17px;
  box-shadow: var(--glow-accent);
  flex-shrink: 0;
  user-select: none;
}

.list { margin-top: var(--sp-6); display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; }
.list::-webkit-scrollbar { display: none; }

.rbtn {
  position: relative;
  width: 46px; height: 44px; border: 0; border-radius: 15px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--ink-3); cursor: pointer;
  transition: background var(--dur-1) var(--ease),
              color var(--dur-1) var(--ease),
              box-shadow var(--dur-1) var(--ease),
              transform var(--dur-0) var(--ease);
}
.rbtn:hover { color: var(--ink-2); background: var(--glass-3); }
.rbtn:active { transform: scale(.94); }
.rbtn.on {
  color: #fff;
  background: var(--au-grad);
  box-shadow: var(--glow-accent);
}
</style>