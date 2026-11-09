/**
 * 本地音乐库 IPC · domain · 转码域
 * 纯业务逻辑：所有外部依赖经 deps 注入（electron 的 dialog/shell 以参数形式传入）。
 */

const path = require('path');

function register(deps) {
  const { fs, audioConvert, prefs, approvedDirs, dialog, shell, safeSend } = deps;

  // 转码中止标志：cancel-convert-audio 置位，convert-audio 每次开始前复位
  let _cancelRequested = false;

  async function convertAudio(params) {
    const {
      inputPath,
      outputFormat = 'mp3',
      bitrate = '320k',
      outputDir = null,
      revealFolder = false,
      timeoutMs,
      start = null,
      end = null,
    } = params;

    if (!await fs.exists(inputPath)) {
      return { error: '源文件不存在' };
    }
    if (!audioConvert.normalizeFormat(outputFormat)) {
      return { error: `不支持的格式: ${outputFormat}` };
    }
    // 传了任一端却合不成合法区间 = 调用方逻辑出错，宁可明确失败，
    // 也不能静默按全曲输出（用户以为截了 30 秒，结果拿到整首）
    const clip = (start != null || end != null) ? audioConvert.normalizeClip(start, end) : null;
    if ((start != null || end != null) && !clip) {
      return { error: '片段区间无效：终点须晚于起点' };
    }
    const nameSuffix = clip ? audioConvert.clipNameSuffix(clip.start, clip.end) : '';

    // 无输出目录 = 用户想自己挑保存位置，必须弹对话框；
    // 批量转换页总是传 outputDir，不会走到这里
    let resolvedOutputDir = outputDir;
    if (!resolvedOutputDir) {
      const ext = audioConvert.formatExtension(outputFormat);
      const defaultName = path.basename(inputPath, path.extname(inputPath)) + nameSuffix + '.' + ext;
      const result = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [
          { name: `${ext.toUpperCase()} 文件`, extensions: [ext] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled) return { canceled: true };
      resolvedOutputDir = path.dirname(result.filePath);
      // 用户在原生保存对话框当场确认的目录 = 批准目录
      approvedDirs.approve(resolvedOutputDir);
    }

    _cancelRequested = false;
    const result = await audioConvert.convertAudioFile({
      inputPath,
      outputDir: resolvedOutputDir,
      format: outputFormat,
      bitrate,
      // 响度归一（P0-B）是全局转码偏好，在设置页勾选，不由调用方逐次传
      loudnorm: prefs.get('convertLoudnorm') === true,
      start: clip ? clip.start : null,
      end: clip ? clip.end : null,
      onProgress: (pct) => safeSend('convert-audio-progress', { path: inputPath, pct }),
      shouldStop: () => _cancelRequested,
      timeoutMs,
    });
    if (result.success && revealFolder) shell.showItemInFolder(result.path);
    return result;
  }

  function cancelConvertAudio() {
    _cancelRequested = true;
    return { success: true };
  }

  return { convertAudio, cancelConvertAudio };
}

module.exports = register;
