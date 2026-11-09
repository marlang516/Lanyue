/**
 * 本地音乐库 IPC · infra · 目录授权注册表
 *
 * 封装 approvedDirs.isApprovedDir/approve，供 domain 层调用。
 */

const approvedDirs = require('../../../approvedDirs');

module.exports = {
  isApprovedDir: approvedDirs.isApprovedDir,
  approve: approvedDirs.approve,
};
