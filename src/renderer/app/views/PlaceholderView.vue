<script setup lang="ts">
import { computed } from 'vue';
import { NAV_ITEMS, setView } from '../stores/ui';
import Icon from '../components/common/Icon.vue';

const props = defineProps({ id: { type: String, required: true } });
const meta = computed(() => NAV_ITEMS.find((n) => n.id === props.id) || { label: props.id, icon: 'layers' });
</script>

<template>
  <div class="ph ly-card">
    <div class="ico"><Icon :name="meta.icon" :size="30" /></div>
    <h2>{{ meta.label }}</h2>
    <p>该视图正在按新设计重构中，功能入口与旧版保持一致。</p>
    <div class="acts">
      <button class="ly-btn ly-btn-primary" @click="setView('home')">回到发现</button>
      <button class="ly-btn" @click="setView('search')">去搜索</button>
    </div>
  </div>
</template>

<style scoped>
.ph {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--sp-3); padding: var(--sp-12);
  text-align: center;
}
.ico {
  width: 72px; height: 72px; border-radius: 24px;
  display: flex; align-items: center; justify-content: center;
  color: #fff; background: var(--au-grad-3);
  box-shadow: var(--glow-accent);
  margin-bottom: var(--sp-2);
}
h2 { font-size: var(--fs-2xl); font-weight: var(--fw-black); }
p { color: var(--ink-2); font-size: var(--fs-sm); max-width: 46ch; line-height: 1.7; }
.acts { margin-top: var(--sp-5); display: flex; gap: var(--sp-2); }
</style>