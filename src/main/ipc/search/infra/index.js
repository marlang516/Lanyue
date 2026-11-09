/**
 * 搜索域 infra 入口：组装所有基础设施
 */

const api = require('./api');
const cookie = require('./cookie');
const prefs = require('./prefs');
const ai = require('./ai');
const logger = require('./logger');

function createInfra() {
  return {
    api,
    cookie,
    prefs,
    ai,
    logger,
  };
}

module.exports = { createInfra };
