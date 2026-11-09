/**
 * 本地音乐库 IPC · 查重/检测域
 * 注册：find-content-duplicates / probe-audio
 * 仅做参数校验 + 委托 domain；不直接触碰 electron/context/fsAsync。
 */

const { handle } = require('../register');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register(deps) {
  const { dupScan } = deps;

  // 内容级查重：字节哈希（大小分桶 → 头尾切片 hash → 同哈希成组）
  handle('find-content-duplicates', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', groups: [] };
      if (!isInAllowedDir(dirPath)) return { error: '路径不可访问', groups: [] };
      return await dupScan.findContentDuplicates(dirPath);
    } catch (e) {
      return { error: e.message, groups: [] };
    }
  });

  // 伪无损检测：ffprobe 实测真实编码/码率（与转码同款路径沙箱）
  handle('probe-audio', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      return await dupScan.probeAudio(filePath);
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = register;
