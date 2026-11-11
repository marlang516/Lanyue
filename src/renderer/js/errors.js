/**
 * 全局错误捕获（从 index.html 内联 <script> 等价迁出，2026-11-09 P0）
 *
 * 旧版把错误处理写成 index.html 内联脚本，受 CSP `script-src 'unsafe-inline'` 管辖。
 * 迁出为外部模块后，index.html 只需 `<script type="module" src="js/errors.js"></script>`，
 * 即可把 script-src 收紧为 'self'。
 *
 * 注意：showToast / logger 由 app.js 先行加载并挂到 window，此处按需读取，
 * 不假设导入顺序（import 时序由 ESM 保证，但 showToast 可能尚未执行到）。
 */
import { logger } from './logger.js';

function _toast(msg, type) {
  const f = window.showToast;
  if (typeof f === 'function') f(msg, type || 'error', 8000);
  else logger.warn('[global error]', msg);
}

window.addEventListener('error', (e) => {
  _toast('JS 错误: ' + (e.message || e), 'error');
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && (e.reason.message || e.reason) || '未知错误';
  _toast('异步错误: ' + msg, 'error');
});
