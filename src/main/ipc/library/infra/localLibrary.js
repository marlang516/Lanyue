/**
 * 本地音乐库 IPC · infra · 本地音频库
 *
 * 封装 utils/localLibrary 的文件读取与元数据能力，供 domain 层调用。
 */

const localLibrary = require('../../../../utils/localLibrary');

module.exports = {
  scanDirectory: localLibrary.scanDirectory,
  readAudioMetadata: localLibrary.readAudioMetadata,
  writeAudioMetadata: localLibrary.writeAudioMetadata,
  writeAudioCover: localLibrary.writeAudioCover,
  readEmbeddedLyrics: localLibrary.readEmbeddedLyrics,
};
