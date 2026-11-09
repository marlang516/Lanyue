<script setup lang="ts">
import { toastState, dismiss } from '../../core/toast';
import type { ToastType } from '../../core/toast';
import Icon from '../common/Icon.vue';

/** 提示档位 → 图标名（未知档位在模板里回退为 info） */
const ICONS: Readonly<Record<ToastType, string>> = {
  info: 'info', success: 'check', warn: 'warning', error: 'warning',
};
</script>

<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="t">
        <div
          v-for="it in toastState.items" :key="it.id"
          class="toast" :class="it.type" role="status"
        >
          <Icon :name="ICONS[it.type] || 'info'" :size="15" class="ic" />
          <span class="msg">{{ it.message }}</span>
          <button class="x" aria-label="关闭提示" @click="dismiss(it.id)">
            <Icon name="x" :size="12" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed; top: 18px; right: 18px; z-index: var(--z-toast);
  display: flex; flex-direction: column; gap: var(--sp-2);
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex; align-items: center; gap: var(--sp-3);
  max-width: 380px; padding: 11px var(--sp-3) 11px var(--sp-4);
  border-radius: var(--r-md);
  background: var(--glass-3);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid var(--stroke);
  box-shadow: var(--shadow-pop);
  color: var(--ink);
  font-size: var(--fs-sm);
}
.ic { flex-shrink: 0; color: var(--au-2); }
.toast.success .ic { color: var(--ok); }
.toast.warn .ic { color: var(--warn); }
.toast.error .ic { color: var(--danger); }
.msg { flex: 1; min-width: 0; line-height: 1.5; word-break: break-word; }
.x {
  width: 22px; height: 22px; border: 0; border-radius: var(--r-xs);
  background: transparent; color: var(--ink-3); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.x:hover { color: var(--ink); background: var(--hairline); }

.t-enter-active, .t-leave-active { transition: opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease-emph); }
.t-enter-from { opacity: 0; transform: translateX(24px); }
.t-leave-to { opacity: 0; transform: translateX(12px) scale(.96); }
.t-move { transition: transform var(--dur-2) var(--ease); }
</style>