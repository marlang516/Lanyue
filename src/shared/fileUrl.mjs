/**
 * 把本地路径变成 audio 能打开的 file URL。
 *
 * 直接拼 file:// 时，# 会被当成片段、? 会被当成查询。
 * Symphony #5.mp3 实际请求的是 Symphony，文件找不到。
 * 空格仍留给 URL 解析器编码（它已经会把空格变成 %20）。
 * 反斜杠先换成斜杠，和原先 playCache / 下载页的做法一致。
 *
 * @param {string} filePath 文件系统路径
 * @returns {string}
 */
function fileUrlFromPath(filePath) {
  const slashed = String(filePath ?? '').replace(/\\/g, '/');
  const encoded = slashed.replace(/[#?]/g, (ch) => (ch === '#' ? '%23' : '%3F'));
  return 'file://' + encoded;
}

export { fileUrlFromPath };
