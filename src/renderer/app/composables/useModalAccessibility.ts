import { nextTick, onBeforeUnmount, watch } from 'vue';
import type { Ref, WatchSource } from 'vue';

interface ModalEntry {
  element: HTMLElement;
  layer: HTMLElement;
  opener: HTMLElement | null;
  previousInert: boolean;
  previousZIndex: string;
  close: () => void;
}

const modalStack: ModalEntry[] = [];
let previousAppInert: boolean | undefined;

function focusableElements(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )).filter((item) => !item.hidden && item.getAttribute('aria-hidden') !== 'true');
}

function syncModalInertness(): void {
  const top = modalStack[modalStack.length - 1];
  modalStack.forEach((entry, index) => {
    entry.element.inert = entry !== top || entry.previousInert;
    entry.layer.style.zIndex = `calc(var(--z-modal) + ${index})`;
  });

  const app = document.getElementById('lanyue-app');
  if (!app) return;
  if (top) {
    if (previousAppInert === undefined) previousAppInert = app.inert;
    app.inert = true;
  } else if (previousAppInert !== undefined) {
    app.inert = previousAppInert;
    previousAppInert = undefined;
  }
}

export function useModalAccessibility(
  isOpen: WatchSource<boolean>,
  modalRef: Readonly<Ref<HTMLElement | null>>,
  close: () => void,
  initialFocus?: () => HTMLElement | null,
): void {
  let entry: ModalEntry | null = null;
  let activation = 0;
  const isActive = () => typeof isOpen === 'function' ? isOpen() : isOpen.value;

  function deactivate(): void {
    if (!entry) return;
    const current = entry;
    const wasTop = modalStack[modalStack.length - 1] === current;
    const index = modalStack.indexOf(current);
    if (index >= 0) modalStack.splice(index, 1);
    entry = null;
    current.element.removeEventListener('keydown', onKeydown);
    current.element.inert = current.previousInert;
    current.layer.style.zIndex = current.previousZIndex;
    syncModalInertness();
    if (wasTop && current.opener?.isConnected) current.opener.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!entry || modalStack[modalStack.length - 1] !== entry) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      entry.close();
      return;
    }

    if (event.key === 'Tab') {
      const items = focusableElements(entry.element);
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first) {
        event.preventDefault();
        entry.element.focus();
      } else if (event.shiftKey && (active === first || !entry.element.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !entry.element.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    event.stopPropagation();
  }

  watch(isOpen, (open) => {
    activation += 1;
    if (!open) {
      deactivate();
      return;
    }

    const token = activation;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void nextTick().then(() => {
      if (token !== activation || !isActive()) return;
      const element = modalRef.value;
      if (!element) return;

      const current: ModalEntry = {
        element,
        layer: element.closest<HTMLElement>('.mask') || element,
        opener,
        previousInert: element.inert,
        previousZIndex: (element.closest<HTMLElement>('.mask') || element).style.zIndex,
        close,
      };
      entry = current;
      modalStack.push(current);
      element.addEventListener('keydown', onKeydown);
      syncModalInertness();

      const target = initialFocus?.();
      const first = focusableElements(element)[0];
      const focusTarget = target && element.contains(target) && !target.matches(':disabled')
        ? target
        : first || element;
      focusTarget.focus();
    });
  }, { flush: 'sync' });

  onBeforeUnmount(() => {
    activation += 1;
    deactivate();
  });
}
