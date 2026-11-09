/**
 * 本地音乐库 IPC · infra · 路径回写与 sidecar
 *
 * 封装 fileRelink / relinkRefs，供 domain 层调用。
 */

const { sidecarPathFor } = require('../../../../utils/relinkRefs');
const { relinkFileRefs, reconcileScannedRefs } = require('../../../../utils/fileRelink');

module.exports = {
  sidecarPathFor,
  relinkFileRefs,
  reconcileScannedRefs,
};
