/**
 * 订阅域 infra —— prefs 适配器
 * 封装 require('../../../../utils/prefs') 的 get('subscriptions') / set('subscriptions', entries)
 */

const prefs = require('../../../../utils/prefs');

const PREFS_KEY = 'subscriptions';

/** 读取全部订阅条目（过滤掉不合法条目）。 */
function loadAll() {
  const raw = prefs.get(PREFS_KEY);
  return Array.isArray(raw) ? raw.filter(e => e && typeof e === 'object' && e.key) : [];
}

/** 持久化全部订阅条目。 */
function saveAll(entries) {
  prefs.set(PREFS_KEY, entries);
}

module.exports = { PREFS_KEY, loadAll, saveAll };
