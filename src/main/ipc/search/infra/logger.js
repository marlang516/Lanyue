/**
 * 搜索域 infra —— logger 封装
 */

const logger = require('../../../../utils/logger');

module.exports = {
  warn: (msg, ...args) => logger.warn(msg, ...args),
  log: (msg, ...args) => logger.log(msg, ...args),
};
