/**
 * 搜索域 infra —— prefs 读取封装
 */

const prefs = require('../../../../utils/prefs');
const { chatConfigFrom } = require('../../../../api/aiProviders');

module.exports = {
  get: (key) => prefs.get(key),
  chatConfigFrom: (getPref) => chatConfigFrom(getPref),
};
