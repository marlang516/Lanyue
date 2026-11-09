/**
 * 本地音乐库 IPC · 转码域
 * 注册：convert-audio / cancel-convert-audio
 * 仅做参数校验 + 委托 domain；不直接触碰 electron/context/prefs/fsAsync。
 */

const { handle } = require('../register');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register(deps) {
  const { convert } = deps;

  // ── 多格式转码 ──────────────────────────────────────────
  handle('convert-audio', async (_, params) => {
    try {
      const { inputPath, outputDir } = params || {};
      if (!isValidPath(inputPath)) return { error: '路径不可访问' };
      if (!isInAllowedDir(inputPath)) return { error: '路径不可访问' };
      if (outputDir && !isInAllowedDir(outputDir)) return { error: '输出目录不可访问' };
      return await convert.convertAudio(params);
    } catch (e) {
      return { error: e.message };
    }
  });

  // 中止当前正在进行的转码（渲染层点「取消」）
  handle('cancel-convert-audio', () => {
    return convert.cancelConvertAudio();
  });
}

module.exports = register;
