<script setup lang="ts">
import { win } from '../../core/bridge';
import Icon from '../common/Icon.vue';
</script>

<template>
  <div class="winctrls" aria-label="窗口控制">
    <button class="wc" title="最小化" aria-label="最小化" @click="win.minimize()">
      <Icon name="minimize" :size="12" />
    </button>
    <button class="wc" title="最大化" aria-label="最大化" @click="win.maximize()">
      <Icon name="maximize" :size="12" />
    </button>
    <button class="wc close" title="关闭" aria-label="关闭" @click="win.close()">
      <Icon name="close" :size="12" />
    </button>
  </div>
</template>

<style scoped>
.winctrls {
  display: flex; gap: var(--sp-1); align-items: center;
  margin-left: var(--sp-2);
  padding-left: var(--sp-3);
  border-left: 1px solid var(--hairline);
}
.wc {
  width: 30px; height: 30px; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-3);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
              transform var(--dur-0) var(--ease);
}
.wc:hover { background: var(--glass-3); color: var(--ink); }
.wc:active { transform: scale(.94); }
.wc.close:hover { background: var(--danger); color: #fff; }
</style>