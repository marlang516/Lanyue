/**
 * 全部平台搜索的取页计划。
 *
 * 各音源的 search() 已经按自己的页大小取回一整页（网易/QQ/酷狗/酷我 30，
 * B 站/咪咕/汽水 20，5sing 服务端默认 10）。aggregateLimit 是这一页最多
 * 留下几条，必须等于该页大小：更小就会把已经取回的歌在合并前丢掉。
 * 2026-11 搜「周杰伦」时酷狗一页有 480 首里的 30 首，旧上限 5 把其中 25 首扔掉，
 * 而且 page 被写死成 1，翻页拿不回后面的页。
 *
 * limit <= 0：该源不参与聚合（用户脚本用 0 显式退出）。
 * 纯函数：不碰网络、不读 registry。
 */

/**
 * @param {Array<{id?:string, _policies?:{aggregateLimit?:number}}>} plugins
 * @param {number|string} [page]
 * @returns {{page:number, slots:Array<{id:string, limit:number}>}}
 */
function planAggregateSearch(plugins, page) {
  const parsed = parseInt(page, 10);
  const pageNo = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  const slots = (Array.isArray(plugins) ? plugins : []).map((pl) => {
    const raw = pl && pl._policies ? Number(pl._policies.aggregateLimit) : 0;
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    return { id: pl && pl.id, limit };
  });
  return { page: pageNo, slots };
}

/**
 * 按该源的聚合上限截取本页。limit <= 0 表示不参与，返回空数组。
 * @param {Array} songs
 * @param {number} limit
 * @returns {Array}
 */
function clipAggregateSongs(songs, limit) {
  const list = Array.isArray(songs) ? songs : [];
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return [];
  return list.slice(0, n);
}

/**
 * 任一参与聚合的源本页被取满，就认为后面可能还有一页。
 * limit <= 0 的源不参与这个判断（它的歌根本不会进结果）。
 * @param {Array<{songs?:Array, limit?:number}>} groups
 * @returns {boolean}
 */
function aggregateHasMore(groups) {
  return (Array.isArray(groups) ? groups : []).some((g) => {
    const n = Number(g && g.limit);
    if (!Number.isFinite(n) || n <= 0) return false;
    return Array.isArray(g.songs) && g.songs.length >= n;
  });
}

module.exports = {
  planAggregateSearch,
  clipAggregateSongs,
  aggregateHasMore,
};
