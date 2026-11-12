/**
 * 本地曲目 id：去路径化（SECURITY.md §5 出站缺口的根修）
 *
 * 本地歌的 id 曾等于绝对路径。outboundScrub 的键名闸剥得掉 filePath 键，
 * 却剥不掉 id 值里的路径 —— 助手工具返回值与状态段都会把本机路径带给厂商。
 * 这里把本地 id 统一换成 'l' + SHA-1(路径) 前 16 位：
 *   - 确定性：同路径恒同 id，收藏/歌单/同步的 id:source 键语义不变
 *   - 无路径残片：id 本身不再携带任何本机信息
 *   - 形状满足 syncMerge 的 SAFE_ID_RE，外来快照修复闸不会误伤
 *
 * 播放不受影响：player 的 file:// 分支只读 song.filePath（从不读 id）。
 *
 * SHA-1 用纯 JS 实现：渲染层拿不到 node:crypto，主进程经 require(esm)
 * 复用同一份（与 shared/fileUrl.mjs 同模式）。不做路径归一化 ——
 * 与原「id=原始路径」的相等语义逐字对齐（大小写/分隔符差异仍视为不同文件）。
 */

/** 纯 JS SHA-1，返回 40 位 hex（与 node:crypto 逐字节一致，test 有交叉验证） */
export function sha1Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const bitLen = len * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  buf[total - 8] = (hi >>> 24) & 0xff;
  buf[total - 7] = (hi >>> 16) & 0xff;
  buf[total - 6] = (hi >>> 8) & 0xff;
  buf[total - 5] = hi & 0xff;
  buf[total - 4] = (lo >>> 24) & 0xff;
  buf[total - 3] = (lo >>> 16) & 0xff;
  buf[total - 2] = (lo >>> 8) & 0xff;
  buf[total - 1] = lo & 0xff;

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Int32Array(80);
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** 本地曲目 id：'l' + SHA-1(filePath) 前 16 位。filePath 原样入哈希（不归一化）。 */
export function localTrackId(filePath) {
  return 'l' + sha1Hex(String(filePath)).slice(0, 16);
}

/** 路径形 id 判据：含分隔符或盘符开头。新 id（l+hex）天然不命中 ⇒ 迁移幂等。 */
const PATH_ID_RE = /[\\/]|^[A-Za-z]:/;

/**
 * 单行迁移：source=local 且 id 呈路径形且有 filePath ⇒ id 换成当前 filePath 的哈希。
 * 其余情况原引用返回（在线行 / 已迁移 / 数字 id / 缺 filePath / 脏数据）。
 * relink 过的行（id=旧路径 ≠ filePath）按当前 filePath 收敛，顺带修复键失联。
 */
export function migrateLocalSong(song) {
  if (!song || typeof song !== 'object') return song;
  if (String(song.source || '') !== 'local') return song;
  if (typeof song.id !== 'string' || !PATH_ID_RE.test(song.id)) return song;
  if (typeof song.filePath !== 'string' || !song.filePath) return song;
  return { ...song, id: localTrackId(song.filePath) };
}

/**
 * 歌单集合迁移（幂等、不改入参）。返回 { playlists, changed }：
 * 无变化时原引用返回，调用方据此决定是否值得落盘。
 */
export function migrateLocalSongIds(playlists) {
  if (!Array.isArray(playlists)) return { playlists, changed: false };
  let changed = false;
  const out = playlists.map((pl) => {
    if (!pl || !Array.isArray(pl.songs)) return pl;
    let plChanged = false;
    const songs = pl.songs.map((s) => {
      const m = migrateLocalSong(s);
      if (m !== s) { plChanged = true; return m; }
      return s;
    });
    if (!plChanged) return pl;
    changed = true;
    return { ...pl, songs };
  });
  return { playlists: changed ? out : playlists, changed };
}