/**
 * 歌单域 infra 入口：组装所有基础设施适配器
 *
 * createInfra(deps) 显式注入优先；未注入时使用默认适配器（直接封装 utils 模块）。
 * 装配层（src/main/index.js）调用此工厂，将结果传给 playlist.register({ domain, infra }）。
 */

const defaultPrefs = require('./prefs');
const defaultApi = require('./api');
const defaultCookie = require('./cookie');
const defaultTrash = require('./trash');

/**
 * @param {Object} [deps]
 * @param {Object} [deps.prefs]    prefs 适配器（loadUserPlaylists/saveUserPlaylists/getTrash/saveTrash）
 * @param {Object} [deps.api]      API 适配器（getPlatformPlaylistSongs）
 * @param {Object} [deps.cookie]   Cookie 适配器（getLoggedInSources）
 * @param {Object} [deps.trash]    回收站适配器（trashRemove/trashRestore/purgeExpired/trashView/trashPurge）
 * @returns {{prefs, api, cookie, trash}}
 */
function createInfra(deps = {}) {
  const {
    prefs: prefsAdapter = defaultPrefs,
    api: apiAdapter = defaultApi,
    cookie: cookieAdapter = defaultCookie,
    trash: trashAdapter = defaultTrash,
  } = deps;

  return {
    prefs: prefsAdapter,
    api: apiAdapter,
    cookie: cookieAdapter,
    trash: trashAdapter,
  };
}

module.exports = { createInfra };