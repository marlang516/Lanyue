/**
 * 本地音乐库 IPC · domain · 歌词域
 * 纯业务逻辑：所有外部依赖经 deps 注入。
 */

function register(deps) {
  const { fs, localLibrary, relink, online } = deps;

  function _decodeLrcBuffer(buf) {
    if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
    if (buf[0] === 0xFE && buf[1] === 0xFF) return _swapBytes16(buf.slice(2)).toString('utf16le');
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
    const utf8Text = buf.toString('utf8');
    if (!_hasReplacementChar(utf8Text)) return utf8Text;
    try {
      const iconv = require('iconv-lite');
      return iconv.decode(buf, 'gbk');
    } catch {
      return utf8Text.replace(/[\uFFFD]+/g, '');
    }
  }

  function _hasReplacementChar(s) {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === 0xFFFD) return true;
    }
    return false;
  }

  function _swapBytes16(buf) {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      out[i] = buf[i + 1];
      out[i + 1] = buf[i];
    }
    return out;
  }

  async function readLocalLrc(filePath) {
    if (!filePath || typeof filePath !== 'string') return { lrc: '', source: '' };
    if (!/\.(mp3|flac|m4a|aac|ogg|wav)$/i.test(filePath)) return { lrc: '', source: '' };

    // 1) 同目录 .lrc 优先
    const lrcPath = relink.sidecarPathFor(filePath);
    if (await fs.exists(lrcPath)) {
      const stat = await fs.statOrNull(lrcPath);
      if (stat && stat.size > 0 && stat.size <= 1024 * 1024) {
        const buf = await fs.fsp.readFile(lrcPath);
        const text = _decodeLrcBuffer(buf);
        if (text && text.trim()) return { lrc: text, source: 'sidecar' };
      }
    }

    // 2) 音频内嵌
    try {
      const embedded = await localLibrary.readEmbeddedLyrics(filePath);
      if (embedded && embedded.trim()) {
        return { lrc: embedded, source: 'embedded' };
      }
    } catch (_e) { /* fallback to online */ }

    // 3) 在线拉
    await online.scheduleOnlineLrcFetch(filePath, {
      readAudioMetadata: localLibrary.readAudioMetadata,
      getLyrics: online.getLyrics,
    });
    return { lrc: '', source: '', fetching: true };
  }

  async function writeLocalLrc(filePath, lrc) {
    const lrcPath = relink.sidecarPathFor(filePath);
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const body = Buffer.from(lrc, 'utf8');
    await fs.fsp.writeFile(lrcPath, Buffer.concat([bom, body]));
    return { success: true };
  }

  async function scheduleOnlineLrcFetch(filePath) {
    await online.scheduleOnlineLrcFetch(filePath, {
      readAudioMetadata: localLibrary.readAudioMetadata,
      getLyrics: online.getLyrics,
    });
  }

  return { readLocalLrc, writeLocalLrc, scheduleOnlineLrcFetch };
}

module.exports = register;
