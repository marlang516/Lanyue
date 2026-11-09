/**
 * 本地音乐库 IPC · domain · 查重/检测域
 * 纯业务逻辑：所有外部依赖经 deps 注入。
 */

function register(deps) {
  const { fs, localLibrary, dupScan, logger, audioProbe } = deps;
  const { bucketBySize, slicePlan, groupByHash, dupGroupView, wastedBytes } = dupScan;

  async function findContentDuplicates(dirPath) {
    if (!await fs.exists(dirPath)) return { error: '目录不存在', groups: [] };

    const filePaths = await localLibrary.scanDirectory(dirPath);
    const sized = [];
    const BATCH = 50;
    for (let i = 0; i < filePaths.length; i += BATCH) {
      const chunk = filePaths.slice(i, i + BATCH);
      const stats = await Promise.all(chunk.map(fp => fs.statOrNull(fp)));
      chunk.forEach((fp, j) => {
        const st = stats[j];
        if (st && typeof st.size === 'number' && st.size > 0 && (!st.isFile || st.isFile())) {
          sized.push({ filePath: fp, fileSize: st.size });
        }
      });
      await new Promise(r => setImmediate(r));
    }

    // 极端大库守护：候选文件哈希量封顶（分桶后仍是同大小者才进候选）
    const hashed = [];
    let budget = 5000;
    for (const bucket of bucketBySize(sized)) {
      for (const f of bucket) {
        if (budget-- <= 0) break;
        const hash = await _hashFileSlices(f.filePath, f.fileSize);
        if (!hash) continue;
        hashed.push({ ...f, hash });
      }
      await new Promise(r => setImmediate(r));
    }

    const dupGroups = groupByHash(hashed);
    return {
      groups: dupGroups.map(dupGroupView),
      wasted: wastedBytes(dupGroups),
      scanned: filePaths.length,
    };
  }

  async function probeAudio(filePath) {
    return await audioProbe.probeAudioFile(filePath);
  }

  // ─── 内容查重：单文件头尾切片哈希（size 进哈希摘要防切片碰撞误判） ───
  async function _hashFileSlices(filePath, size) {
    const crypto = require('crypto');
    let fh;
    try {
      fh = await fs.fsp.open(filePath, 'r');
      const h = crypto.createHash('sha256');
      h.update(String(size));
      for (const r of slicePlan(size)) {
        const buf = Buffer.alloc(r.end - r.start);
        await fh.read(buf, 0, buf.length, r.start);
        h.update(buf);
      }
      return h.digest('hex');
    } catch {
      return null; // 占用中/无权限的文件跳过而不是让整次查重失败
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  return { findContentDuplicates, probeAudio };
}

module.exports = register;
