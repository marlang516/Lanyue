const test = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

test('首页榜单筛选默认收起，并可按需展开与收起', async () => {
  const dom = installBrowserGlobals({ ids: ['homeFilterInput', 'homeFilterToggle'] });
  const input = dom.element('homeFilterInput');
  const toggle = dom.element('homeFilterToggle');

  await loadView('src/renderer/js/views/home.js', dom);

  assert.equal(input.hidden, true, '榜单过滤输入框默认应隐藏');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(typeof globalThis.toggleHomeFilter, 'function');

  globalThis.toggleHomeFilter();
  assert.equal(input.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, '收起筛选');

  input.value = '周杰伦';
  dom.doc.dispatch('input', { target: input });
  assert.equal(toggle.classList.contains('has-filter'), true);
  globalThis.toggleHomeFilter();
  assert.equal(input.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent, '筛选本页榜单（已生效）');

  globalThis.toggleHomeFilter();
  input.value = '';
  dom.doc.dispatch('input', { target: input });
  assert.equal(toggle.classList.contains('has-filter'), false);
});
