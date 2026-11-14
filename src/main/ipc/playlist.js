/**
 * 用户歌单 IPC
 *
 * 注册：get-user-playlists / save-user-playlist / delete-user-playlist /
 *       add-to-user-playlist / remove-from-user-playlist
 *
 * 持久化到 userData/prefs.json
 *
 * 构造注入：register(deps = {})，deps.domain 为业务函数集，
 * deps.infra 为 {prefs, api, cookie, trash} 适配器。
 */

const logger = require('../../utils/logger');
const { aggregateAcrossSources, pickRepresentative, orderMergedResults, songKey: aggSongKey, SOURCE_FETCH_LIMIT } = require('../../utils/crossSourceAggregate');
const { handle } = require('./register');
// 常量与 songKey 的唯一事实来源是 domain 层（纯函数模块，零外部依赖）。
// 顶层静态 require：路径写错会在加载期直接抛 MODULE_NOT_FOUND，
// 不会再被 catch 吞成「再导出从未生效」的静默失败。
const playlistDomain = require('./playlist/domain');
const { migrateLocalSongIds, localTrackId } = require('../../shared/localTrackId.mjs');

function register(deps = {}) {
  const domain = deps.domain;
  const infra = deps.infra;
  if (!domain) throw new Error('playlist.register: 缺少 domain');
  if (!infra) throw new Error('playlist.register: 缺少 infra');

  const prefs = infra.prefs;
  const trashMod = infra.trash;
  const cookie = infra.cookie;

  const FAVORITES_ID = domain.FAVORITES_ID;
  const TRASH_KEY = domain.TRASH_KEY;

  // 启动即清过期回收站条目（30 天 TTL，规则在 utils/playlistTrash.js 一家管）
  // prefs 适配器可能暴露 getTrash；回退到直接 prefs.get
  const _trashArr = (typeof prefs.getTrash === 'function') ? prefs.getTrash() : (prefs.get(TRASH_KEY) || []);
  const { trash: alive, purged } = trashMod.purgeExpired(_trashArr, Date.now());
  if (purged.length) {
    if (typeof prefs.saveTrash === 'function') prefs.saveTrash(alive); else prefs.set(TRASH_KEY, alive);
  }

  function _trash() {
    return (typeof prefs.getTrash === 'function') ? prefs.getTrash() : (prefs.get(TRASH_KEY) || []);
  }
  function _saveTrash(t) {
    if (typeof prefs.saveTrash === 'function') prefs.saveTrash(t); else prefs.set(TRASH_KEY, t);
  }
  function _loadPlaylists() {
    const raw = (typeof prefs.loadUserPlaylists === 'function') ? prefs.loadUserPlaylists() : (prefs.get('userPlaylists') || []);
    // 旧形状本地行（id=路径）读出即升为哈希 id，迁移结果随下次写回落盘
    return migrateLocalSongIds(raw).playlists;
  }
  function _savePlaylists(p) {
    if (typeof prefs.saveUserPlaylists === 'function') prefs.saveUserPlaylists(p); else prefs.set('userPlaylists', p);
  }

  // 获取所有用户歌单；支持 opts.trash —— 带 {trash:true} 返回回收站视图
  handle('get-user-playlists', (_, opts) => {
    if (opts && opts.trash) return trashMod.trashView(_trash(), Date.now());
    const playlists = domain.ensureFavorites(_loadPlaylists());
    // ensureFavorites 可能新增收藏歌单，需写回
    _savePlaylists(playlists);
    return playlists;
  });

  // 保存歌单（新建或更新）
  handle('save-user-playlist', (_, playlist) => {
    if (!playlist || !playlist.name) return { success: false, error: '歌单名称不能为空' };
    const playlists = domain.ensureFavorites(_loadPlaylists());
    const now = Date.now();

    if (playlist.id) {
      // 更新已有歌单
      const idx = playlists.findIndex(p => p && p.id === playlist.id);
      if (idx >= 0) {
        playlists[idx] = { ...playlists[idx], ...playlist, updatedAt: now };
        _savePlaylists(playlists);
        // 歌单已在列表中 ⇒ 回收站里那份陈旧条目顺手清掉
        const tr0 = _trash();
        const rr0 = trashMod.trashRestore(playlists, tr0, playlist);
        if (rr0.trash.length !== tr0.length) _saveTrash(rr0.trash);
        return { success: true, playlist: playlists[idx] };
      }
      // 带 id 却不在列表 —— 可能是"撤销删除"
      const rr = trashMod.trashRestore(playlists, _trash(), playlist);
      if (rr.restored) {
        _saveTrash(rr.trash);
        _savePlaylists(rr.playlists);
        return { success: true, playlist: rr.restored, restored: true };
      }
    }

    // 新建歌单
    const res = domain.savePlaylist(playlists, playlist);
    if (!res.success) {
      // notFound 信号：带 id 却不在列表 ⇒ 先试回收站（撤销删除 / 恢复）
      if (res.notFound) {
        const rr = trashMod.trashRestore(playlists, _trash(), playlist);
        if (rr.restored) {
          _saveTrash(rr.trash);
          _savePlaylists(rr.playlists);
          return { success: true, playlist: rr.restored, restored: true };
        }
        // notFound 且回收站也没有 ⇒ 旧实现会丢掉这个陌生 id 直接新建
        // （导入 / 跨机恢复场景依赖此行为），复刻之：剔掉 id 再走一次新建分支。
        const rest = { ...playlist };
        delete rest.id;
        const fresh = domain.savePlaylist(playlists, rest);
        if (fresh.success) {
          _savePlaylists(fresh.playlists);
          return { success: true, playlist: fresh.playlist };
        }
        return fresh;
      }
      return res;
    }
    _savePlaylists(res.playlists);
    return { success: true, playlist: res.playlist };
  });

  // 删除歌单（硬删改挪回收站，5 秒内可撤销、30 天内可恢复）
  handle('delete-user-playlist', (_, playlistId) => {
    if (!playlistId) return { success: false, error: '缺少歌单ID' };
    const playlists = domain.ensureFavorites(_loadPlaylists());
    const pl = playlists.find(p => p && p.id === playlistId);
    if (pl && pl.system) return { success: false, error: '收藏歌单不能删除' };

    // 列表里没有、回收站里倒是有 ⇒ 彻底删除
    if (!pl) {
      const pr = trashMod.trashPurge(_trash(), playlistId);
      if (!pr.purged) return { success: false, error: '歌单不存在' };
      _saveTrash(pr.trash);
      return { success: true, purged: true };
    }

    const res = trashMod.trashRemove(playlists, _trash(), playlistId, Date.now());
    if (!res.removed) return { success: false, error: '歌单不存在' };
    _savePlaylists(res.playlists);
    _saveTrash(res.trash);
    return { success: true };
  });

  // 添加歌曲到歌单
  handle('add-to-user-playlist', (_, playlistId, song) => {
    if (!playlistId || !song) return { success: false, error: '参数不完整' };
    const playlists = _loadPlaylists() || [];
    const res = domain.addToPlaylist(playlists, playlistId, song);
    if (!res.success) return res;
    if (res.skipped) return { success: true, skipped: true };
    _savePlaylists(res.playlists);
    return { success: true, playlist: res.playlist };
  });

  // 从歌单移除歌曲
  handle('remove-from-user-playlist', (_, playlistId, songId, source) => {
    if (!playlistId || !songId) return { success: false, error: '参数不完整' };
    const playlists = domain.ensureFavorites(_loadPlaylists());
    const res = domain.removeFromPlaylist(playlists, playlistId, songId, source);
    if (!res.success) return res;
    _savePlaylists(res.playlists);
    return { success: true, playlist: res.playlist };
  });

  // 红心收藏：在收藏歌单中按 source+id 增删切换
  handle('toggle-favorite', (_, source, songId, song) => {
    if (!songId || !song || typeof song !== 'object') {
      return { success: false, error: '参数不完整' };
    }
    const playlists = domain.ensureFavorites(_loadPlaylists());
    const res = domain.toggleFavorite(playlists, source, songId, song);
    if (!res.success) return res;
    _savePlaylists(res.playlists);
    return { success: true, favorited: res.favorited, playlist: res.playlist };
  });

  // ── 跨源聚合 ─────────────────────────────────────────────
  handle('aggregate-cross-source', async (_, opts) => {
    const o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    const mark = o.markDuplicates !== false;
    const includeLocal = o.includeLocal === true;
    const orderMerged = o.orderMerged === true;

    const playlists = _loadPlaylists() || [];
    const fav = playlists.find((p) => p && p.id === FAVORITES_ID);

    const groups = [];
    const failed = [];
    const fetched = {};

    const wantSources = Array.isArray(o.sources) && o.sources.length
      ? o.sources.map((x) => String(x || '').trim()).filter(Boolean)
      : null;

    if (Array.isArray(o.playlists) && o.playlists.length) {
      for (const t of o.playlists) {
        const src = String((t && t.source) || '').trim();
        const pid = String((t && t.id) || '').trim();
        if (!src || !pid) continue;
        if (wantSources && !wantSources.includes(src)) continue;
        try {
          const songs = await infra.api.getPlatformPlaylistSongs(src, pid);
          groups.push({ source: src, songs: Array.isArray(songs) ? songs : [] });
          fetched[src] = SOURCE_FETCH_LIMIT;
        } catch (e) {
          logger.warn('[aggregate] 拉取歌单失败，降级为空:', src, e && e.message);
          groups.push({ source: src, songs: [] });
          failed.push(src);
        }
      }
    } else {
      const bySource = new Map();
      for (const s of (fav && Array.isArray(fav.songs) ? fav.songs : [])) {
        if (!s || !s.source) continue;
        if (wantSources && !wantSources.includes(s.source)) continue;
        let arr = bySource.get(s.source);
        if (!arr) { arr = []; bySource.set(s.source, arr); }
        arr.push(s);
      }
      for (const [src, songs] of bySource) groups.push({ source: src, songs });
    }

    let localGroup = null;
    if (includeLocal) {
      try {
        const { loadIndex } = require('../../utils/libraryIndex');
        const idx = await loadIndex();
        const localSongs = ((idx && Array.isArray(idx.songs)) ? idx.songs : [])
          .filter((f) => f && f.filePath)
          .map((f) => ({
            source: 'local',
            id: localTrackId(f.filePath),
            filePath: f.filePath,
            title: f.title || f.fileName || '',
            artist: f.artist || '',
            album: f.album || '',
            cover: f.cover || undefined,
            duration: Number(f.durationMs) > 0 ? Number(f.durationMs) : 0,
          }));
        localGroup = { source: 'local', songs: localSongs };
      } catch (e) {
        logger.warn('[aggregate] 本地曲库组加载失败，跳过:', e && e.message);
        failed.push('local');
      }
    }

    const merged = aggregateAcrossSources(
      localGroup ? [localGroup, ...groups] : groups,
      { markDuplicates: mark, fetched }
    );

    const clusters = new Map();
    for (const s of merged.songs) {
      if (!s._crossSource || !Array.isArray(s._dupOf)) continue;
      const k = [...s._dupOf, aggSongKey(s)].sort().join('|');
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k).push(s);
    }

    const loggedIn = new Set(cookie.getLoggedInSources());

    const prefer = includeLocal ? ['local'] : null;

    for (const members of clusters.values()) {
      const rep = pickRepresentative(members, loggedIn, prefer);
      if (!rep) continue;
      const repKey = aggSongKey(rep);
      for (const s of members) {
        s._primary = aggSongKey(s) === repKey;
      }
      if (members.some((m) => m.source === 'local')) {
        for (const m of members) m._hasLocal = true;
      }
    }

    if (orderMerged) {
      merged.songs = orderMergedResults(merged.songs, loggedIn, prefer);
    }

    return { ...merged, failed };
  });
}

module.exports = {
  register,
  FAVORITES_ID: playlistDomain.FAVORITES_ID,
  FAVORITES_NAME: playlistDomain.FAVORITES_NAME,
  TRASH_KEY: playlistDomain.TRASH_KEY,
  songKey: playlistDomain.songKey,
};
