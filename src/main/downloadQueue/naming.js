/**
 * 文件名清洗（零状态纯函数）。
 *
 * 从 `src/main/downloadQueue.js` 外移（ADR 0003 §5 步骤 1）。本函数不读任何闭包
 * 状态、不依赖注入端口，只做「非法字符替换 + 限长」，因此可以独立单测与复用。
 * 主文件保留同名 re-export（`module.exports.sanitizeFilename`），导出面不变。
 */

/**
 * 清洗文件名（去掉路径分隔符与非法字符，限长 200）
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 200);
}

module.exports = {
  sanitizeFilename,
};