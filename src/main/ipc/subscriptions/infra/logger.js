/**
 * 订阅域 infra —— logger 适配器
 * 封装 require('../../../../utils/logger')
 */

const logger = require('../../../../utils/logger');

module.exports = {
  log: (...args) => logger.log(...args),
  warn: (...args) => logger.warn(...args),
  error: (...args) => logger.error(...args),
};
