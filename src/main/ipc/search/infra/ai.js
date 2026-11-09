/**
 * 搜索域 infra —— AI 相关封装（rewrite / nl-search 编排）
 */

const { rewriteSearchQueries } = require('../../../../api/ai-music');
const { chatConfigFrom } = require('../../../../api/aiProviders');
const { searchByPhrase } = require('../../../../api/services/nlSearchService');

module.exports = {
  rewriteSearchQueries: (params) => rewriteSearchQueries(params),
  chatConfigFrom: (getPref) => chatConfigFrom(getPref),
  searchByPhrase: (deps) => searchByPhrase(deps),
};
