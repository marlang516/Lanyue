<script setup lang="ts">
import { watch, nextTick, ref } from 'vue';
import { dialogState, settleDialog } from '../../core/dialog';
import Icon from '../common/Icon.vue';

const inputEl = ref<HTMLInputElement | null>(null);

watch(() => dialogState.open, async (open: boolean) => {
  if (!open) return;
  await nextTick();
  if (dialogState.kind === 'prompt') inputEl.value?.focus();
});

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); settleDialog(false); }
  if (e.key === 'Enter' && dialogState.kind === 'prompt') { e.preventDefault(); settleDialog(true); }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="dialogState.open" class="mask" @mousedown.self="settleDialog(false)" @keydown="onKey">
        <div class="dlg ly-card" role="dialog" aria-modal="true" :aria-label="dialogState.title || '提示'">
          <div class="hd">
            <span class="ico" :class="{ danger: dialogState.danger }">
              <Icon :name="dialogState.danger ? 'warning' : 'info'" :size="17" />
            </span>
            <h3>{{ dialogState.title }}</h3>
          </div>

          <p v-if="dialogState.body" class="body">{{ dialogState.body }}</p>

          <label v-if="dialogState.kind === 'prompt'" class="field">
            <span v-if="dialogState.inputLabel">{{ dialogState.inputLabel }}</span>
            <input
              ref="inputEl" v-model="dialogState.inputValue"
              :placeholder="dialogState.placeholder" class="ly-input"
              @keydown.enter.prevent="settleDialog(true)"
            />
          </label>

          <div class="ft">
            <button v-if="dialogState.cancelText" class="ly-btn" @click="settleDialog(false)">
              {{ dialogState.cancelText }}
            </button>
            <button
              class="ly-btn" :class="dialogState.danger ? 'ly-btn-danger' : 'ly-btn-primary'"
              @click="settleDialog(true)"
            >
              {{ dialogState.okText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: rgba(12, 16, 28, .4);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  display: flex; align-items: center; justify-content: center;
  padding: var(--sp-6);
}
.dlg { width: min(440px, 94vw); padding: var(--sp-6); box-shadow: var(--shadow-pop); }
.hd { display: flex; align-items: center; gap: var(--sp-3); }
.ico {
  width: 32px; height: 32px; flex-shrink: 0;
  border-radius: var(--r-md);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-soft); color: var(--au-1);
}
.ico.danger { background: rgba(229, 72, 77, .12); color: var(--danger); }
.hd h3 { font-size: var(--fs-lg); font-weight: var(--fw-bold); }
.body { margin-top: var(--sp-3); color: var(--ink-2); font-size: var(--fs-sm); line-height: 1.65; white-space: pre-wrap; }
.field { display: block; margin-top: var(--sp-4); }
.field > span { display: block; font-size: var(--fs-xs); color: var(--ink-3); margin-bottom: var(--sp-2); }
.ft { margin-top: var(--sp-6); display: flex; justify-content: flex-end; gap: var(--sp-2); }

.dlg-enter-active, .dlg-leave-active { transition: opacity var(--dur-1) var(--ease); }
.dlg-enter-active .dlg, .dlg-leave-active .dlg { transition: transform var(--dur-2) var(--ease-emph), opacity var(--dur-1); }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .dlg, .dlg-leave-to .dlg { transform: translateY(8px) scale(.97); opacity: 0; }
</style>