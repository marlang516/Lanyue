<script setup lang="ts">
import { win } from '../../core/bridge';
import Icon from '../common/Icon.vue';
</script>

<template>
  <div class="winctrls" aria-label="窗口控制">
    <button type="button" class="wc" title="最小化" aria-label="最小化" @click="win.minimize()">
      <Icon name="minimize" :size="18" />
    </button>
    <button type="button" class="wc" title="最大化" aria-label="最大化" @click="win.maximize()">
      <Icon name="maximize" :size="18" />
    </button>
    <button type="button" class="wc close" title="关闭" aria-label="关闭" @click="win.close()">
      <Icon name="close" :size="18" />
    </button>
  </div>
</template>

<style scoped>
/* 顶栏高 64px，搜索条高 40px。窗口钮跟搜索条同一档，比旁边 34px 的工具钮更好点。
   图标画在 24 视口里、按 18px 绘出，描边略加粗，避免细线缩在按钮中间。 */
.winctrls {
  display: flex; gap: var(--sp-1); align-items: center; flex-shrink: 0;
  margin-left: var(--sp-2);
  padding-left: var(--sp-3);
  border-left: 1px solid var(--hairline);
}
.wc {
  width: 40px; height: 40px; flex-shrink: 0;
  border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--ink-3);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease),
              transform var(--dur-0) var(--ease);
}
.wc :deep(svg) { stroke-width: 2.15; }
.wc:hover { background: var(--glass-3); color: var(--ink); }
.wc:active { transform: scale(.94); }
.wc.close:hover { background: var(--danger); color: #fff; }
</style>