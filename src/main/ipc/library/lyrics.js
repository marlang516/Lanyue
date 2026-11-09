/**
 * 本地音乐库 IPC · 歌词域
 * 注册：read-local-lrc / write-local-lrc / batch-fetch-lyrics
 * 仅做参数校验 + 委托 domain；不直接触碰 electron/context/fsAsync。
 */

const { handle } = require('../register');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register(deps) {
  const { lyrics } = deps;

  // 读取本地 LRC 歌词
  handle('read-local-lrc', async (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { lrc: '', source: '' };
      if (!/\.(mp3|flac|m4a|aac|ogg|wav)$/i.test(filePath)) return { lrc: '', source: '' };
      if (!isInAllowedDir(filePath)) return { lrc: '', error: '路径不可访问' };
      return await lyrics.readLocalLrc(filePath);
    } catch (e) {
      return { lrc: '', error: e.message, source: '' };
    }
  });

  // 写入 LRC 歌词到同目录 sidecar 文件（渲染层位置参数：api.writeLocalLrc(filePath, lrc)）
  handle('write-local-lrc', async (_, filePath, lrc) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      return await lyrics.writeLocalLrc(filePath, lrc);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 批量获取歌词（按 title/artist 搜索网易云，写入 sidecar）
  handle('batch-fetch-lyrics', async (_, songs) => {
    const results = [];
    for (const s of songs) {
      try {
        // C1: 该通道会在 filePath 旁写 .lrc sidecar —— 必须先过沙箱，
        // 否则等于绕过同文件其余 handler 的 C9 校验往任意路径写文件
        if (!s || !isValidPath(s.filePath) || !isInAllowedDir(s.filePath)) {
          results.push({ filePath: s && s.filePath, ok: false, error: '路径不可访问' });
          continue;
        }
        await lyrics.scheduleOnlineLrcFetch(s.filePath);
        results.push({ filePath: s.filePath, ok: true });
      } catch (e) {
        results.push({ filePath: s.filePath, ok: false, error: e.message });
      }
    }
    return results;
  });
}

module.exports = register;
