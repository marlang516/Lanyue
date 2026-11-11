<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import { ui, matchCommands, togglePalette } from '../../stores/ui';
import type { CommandItem } from '../../stores/types';
import Icon from '../common/Icon.vue';

const keyword = ref('');
const active = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

const results = computed<CommandItem[]>(() => matchCommands(keyword.value));

watch(() => ui.paletteOpen, async (open: boolean) => {
  if (!open) return;
  keyword.value = '';
  active.value = 0;
  await nextTick();
  inputEl.value?.focus();
});

watch(results, () => { active.value = 0; });

function move(step: number): void {
  const n = results.value.length;
  if (!n) return;
  active.value = (active.value + step + n) % n;
}

function run(cmd: CommandItem | undefined): void {
  if (!cmd) return;
  togglePalette(false);
  // 命令内部可能同步改 view，延迟一帧避免与关闭动画抢焦点
  requestAnimationFrame(() => cmd.run());
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); togglePalette(false); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
  if (e.key === 'Enter') { e.preventDefault(); run(results.value[active.value]); }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div v-if="ui.paletteOpen" class="mask" @mousedown.self="togglePalette(false)">
        <div class="palette ly-card" role="dialog" aria-modal="true" aria-label="命令面板">
          <div class="psearch">
            <Icon name="search" :size="16" />
            <input
              ref="inputEl"
              v-model="keyword"
              placeholder="搜索命令或页面…"
              aria-label="搜索命令"
              @keydown="onKey"
            />
            <kbd>Esc</kbd>
          </div>

          <div class="plist" role="listbox">
            <button
              v-for="(c, i) in results" :key="c.id"
              class="pitem" :class="{ on: i === active }"
              role="option" :aria-selected="i === active"
              @mouseenter="active = i" @click="run(c)"
            >
              <span class="pico"><Icon name="chevron-right" :size="14" /></span>
              <span class="ptx">
                <b>{{ c.title }}</b>
                <small>{{ c.sub }}</small>
              </span>
            </button>
            <div v-if="!results.length" class="pempty">没有匹配的命令</div>
          </div>

          <div class="pfoot">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 执行</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: rgba(12, 16, 28, .34);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 14vh;
}
.palette {
  width: min(620px, 92vw);
  max-height: 64vh;
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-pop);
}
.psearch {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 14px var(--sp-5);
  border-bottom: 1px solid var(--hairline);
  color: var(--ink-3);
}
.psearch input { flex: 1; min-width: 0; border: 0; padding: 0; background: transparent; font-size: var(--fs-lg); color: var(--ink); }
.psearch input:focus { box-shadow: none; }
.psearch kbd, .pfoot kbd {
  font-family: var(--font-mono); font-size: var(--fs-2xs);
  color: var(--ink-3); border: 1px solid var(--hairline);
  border-radius: var(--r-xs); padding: 2px 6px;
}
.plist { overflow-y: auto; padding: var(--sp-2); }
.pitem {
  width: 100%; display: flex; align-items: center; gap: var(--sp-3);
  padding: 10px var(--sp-3); border: 0; border-radius: var(--r-md);
  background: transparent; text-align: left; cursor: pointer;
  color: var(--ink-2);
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.pitem.on { background: var(--accent-soft); color: var(--ink); }
.pico { width: 22px; display: flex; justify-content: center; color: var(--au-1); opacity: .7; }
.ptx { display: flex; align-items: baseline; gap: var(--sp-3); min-width: 0; }
.ptx b { font-size: var(--fs-sm); font-weight: var(--fw-med); }
.ptx small { font-size: var(--fs-2xs); color: var(--ink-3); letter-spacing: .06em; }
.pempty { padding: var(--sp-8); text-align: center; color: var(--ink-3); font-size: var(--fs-sm); }
.pfoot {
  display: flex; gap: var(--sp-5); padding: 10px var(--sp-5);
  border-top: 1px solid var(--hairline);
  color: var(--ink-3); font-size: var(--fs-2xs);
}
.pfoot kbd { margin-right: 3px; }

.palette-enter-active, .palette-leave-active { transition: opacity var(--dur-1) var(--ease); }
.palette-enter-active .palette, .palette-leave-active .palette { transition: transform var(--dur-2) var(--ease-emph), opacity var(--dur-1); }
.palette-enter-from, .palette-leave-to { opacity: 0; }
.palette-enter-from .palette, .palette-leave-to .palette { transform: translateY(-10px) scale(.985); opacity: 0; }
</style>