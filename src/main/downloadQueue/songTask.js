/**
 * 单曲任务流水线（Song Task）（ADR 0003 §5 步骤 6 / §8.1）。
 *
 * 从 `src/main/downloadQueue.js` 的 `_processOneSongInner`（332 物理行 / 243 有效
 * 行，占全文件有效代码 41.8%）原样搬出，按 ADR §8.1 的 12 个 phase 切成小函数。
 * 本模块**只做机械提取**：phase 顺序、短路条件、错误分类、状态迁移落点全部与
 * 拆分前逐字一致；没有顺手修 bug，也没有"优化"任何判据。
 *
 * 流水线（一个 phase 一个函数，编排在 `runAttempt` 里，从上往下读）：
 *
 *   P1  initContext          逐曲快照（lastError / isFatal / cancelToken / maxAttempts）
 *   P2  startAttempt         非 downloading 时先迁回 downloading（不推事件）+ 起始日志
 *   P3  applyPolicyPhase     evaluatePolicy → skip（落 done + skipReason）/ demote（改 quality）
 *   P4  resolveStream        取流、fatal 短路、_altSource 回写 + 推事件
 *   P5  preparePaths         ext 清洗、模板渲染、saveDir 兜底、planDownloadDir、沙箱复核、
 *                            mkdir、savePath
 *   P6  checkDiskSpace       容量预检（statfs → diskVerdict → diskShortage）
 *   P7  transferFile         headers、限速、onProgress（节流与速度采样在 events.js）
 *   P8  handlePostTransferAbort 保留已落盘文件、清 speedState、落 error「用户取消」
 *   P9  finalizeLyrics       getLyrics（换源优先）、embedId3Tags、sidecar .lrc
 *   P10 finishSuccess        done + savePath + 通知门禁 + history.add(done)
 *   P11 handleAttemptFailure /HTTP\s*(403|404|410)/ → pending + 500ms 退避
 *   P12 finalizeFailure      cancelled 分支、transportCode 补码、队列外跳过、
 *                            history.add(error)、emitError
 *
 * 循环控制（同样原样保留）：
 *   - attempt 顶部：`shouldAbort`（取消 / 已移出队列）→ 置 cancelled 错误，退出循环，
 *     进入 P12；
 *   - P4 的 `fatal=true`：置 fatal 错误后**直接退出循环**（不消耗重试配额），
 *     进入 P12 —— 与「可重试错误」是两条路；
 *   - catch 里只有 `/HTTP\s*(403|404|410)/i` 且 `attempt < maxAttempts` 才
 *     `pending` + 500ms 退避 + `continue`；其余一律 `break` 进 P12。
 *
 * 状态所有权（ADR 0003 §2.1 / §6.2）：
 *   - 队列数组**不归本模块**：只经注入的 `getQueue()` 读引用（识别「已被移出队列」），
 *     任何写入都是原地操作，由外部完成；
 *   - `status` 只经注入的 `transition`（即 facade 的 applyStatus / queueStore.transition）
 *     写，本模块不出现 `song.status =`；
 *   - 进度节流、速度采样、`emitQueueChanged` / `emitError`、`speedStates` 全在
 *     `events.js`，本模块只调用；
 *   - 500ms 重试退避定时器归 `scheduler.js`，本模块只 `await` 注入的
 *     `waitRetryBackoff()` —— 本文件不排任何定时器（禁止第二份）。
 */

const path = require('path');
const fs = require('fs');

const { renderFileName, DEFAULT_TEMPLATE } = require('../../utils/naming');
const { planDownloadDir, activePathTemplate } = require('../../utils/downloadPath');
const { MUSIC_DIR_NAME } = require('../../shared/downloadDefaults');
const diskSpace = require('../diskSpace');
const { sidecarPathFor } = require('../../utils/relinkRefs');
const { sanitizeFilename } = require('./naming');
// 传输失败的判据与码表家在 src/shared/netClass.js（P12 补码用；与主文件同源）。
const { transportCode } = require('../../shared/netClass');

/** 阶段继续（无信号）——与「终止」区分开，避免用 undefined 表达两种语义。 */
const CONTINUE = null;
/** 终止整条流水线并返回业务值（P3 skip 的返回值要透传给调用方）。 */
function finish(value) {
  return { action: 'finish', value };
}
/** 退出 attempt 循环，进入 P12 失败终态。 */
function breakLoop() {
  return { action: 'break' };
}

/** 协作式取消的错误形态（两处检查点共用同一形状，与拆分前一致）。 */
function cancelledError() {
  return Object.assign(new Error('下载已取消'), { cancelled: true });
}

/**
 * 创建单曲任务流水线（每个引擎一份）。
 *
 * @param {Object} deps
 * @param {() => Object[]} deps.getQueue 队列**活数组引用**（只读，用于判断「已被移出队列」）
 * @param {(song: Object, to: string, reason?: string) => void} deps.transition 状态迁移唯一出口
 * @param {(immediate?: boolean) => void} deps.notify 队列变更出口（推送 → 落盘）
 * @param {Object} deps.events 事件实例（makeOnProgress / forget / emitError）
 * @param {{ downloadDone: Function }} deps.notification 桌面通知端口
 * @param {(key: string) => any} deps.readPrefs 读偏好（注入 prefs.get，便于单测）
 * @param {() => number} deps.getMaxAttempts 逐曲快照最大尝试次数（1..5，含首次）
 * @param {(song: Object) => Promise<Object>} deps.evaluatePolicy 质量策略求值
 * @param {(song: Object, quality: string) => Promise<Object>} deps.getDownloadUrlSmart 智能取流
 * @param {(id: string, source: string, title: string, artist: string) => Promise<{lrc: string}>} deps.getLyrics
 * @param {(dir: string) => boolean} [deps.isSaveDirAllowed] 落盘目录沙箱校验（缺省不限制）
 * @param {() => string} [deps.getDefaultDownloadDir] 默认下载目录（prefs 未设时）
 * @param {() => (string|null)} deps.userDataDir 用户数据目录（惰性）
 * @param {Object} deps.history 下载历史模块
 * @param {Object} deps.fsa 异步文件工具（statOrNull）
 * @param {Function} deps.downloadFileWithRetry 传输入口（含重定向/断点续传）
 * @param {Function} deps.embedId3Tags 标签嵌入（内部只对 mp3 生效）
 * @param {() => Promise<void>} deps.waitRetryBackoff 500ms 重试退避（定时器归 scheduler）
 * @param {Object} deps.logger 日志器
 * @returns {{ processOneSong: (song: Object) => Promise<void|Object> }} 任务流水线实例
 */
function createSongTask({
  getQueue,
  transition,
  notify,
  events,
  notification,
  readPrefs,
  getMaxAttempts,
  evaluatePolicy,
  getDownloadUrlSmart,
  getLyrics,
  isSaveDirAllowed,
  getDefaultDownloadDir,
  userDataDir,
  history,
  fsa,
  downloadFileWithRetry,
  embedId3Tags,
  waitRetryBackoff,
  logger,
} = {}) {
  if (typeof getQueue !== 'function') throw new Error('[SongTask] 必须注入 getQueue');
  if (typeof transition !== 'function') throw new Error('[SongTask] 必须注入 transition');
  if (typeof notify !== 'function') throw new Error('[SongTask] 必须注入 notify');
  if (!events || typeof events !== 'object') throw new Error('[SongTask] 必须注入 events');
  if (typeof readPrefs !== 'function') throw new Error('[SongTask] 必须注入 readPrefs');
  if (typeof getMaxAttempts !== 'function') throw new Error('[SongTask] 必须注入 getMaxAttempts');
  if (typeof evaluatePolicy !== 'function') throw new Error('[SongTask] 必须注入 evaluatePolicy');
  if (typeof downloadFileWithRetry !== 'function') throw new Error('[SongTask] 必须注入 downloadFileWithRetry');
  if (typeof waitRetryBackoff !== 'function') throw new Error('[SongTask] 必须注入 waitRetryBackoff');
  if (!logger) throw new Error('[SongTask] 必须注入 logger');

  /**
   * 处理单个下载任务（含重试循环 + 致命错误短路）。
   * `_processing` 标记协程全程在途（含 403 重试退避窗口，此时 status 是 pending），
   * 调度器据此跳过，杜绝同一首歌两个协程并发写同一目标文件（审计 H1）。
   *
   * @param {Object} song 队列条目
   * @returns {Promise<void|{skipped: boolean, reason: string, ruleId: string}>}
   */
  async function processOneSong(song) {
    song._processing = true;
    try {
      return await runSongTask(initContext(song));
    } finally {
      song._processing = false;
    }
  }

  /**
   * attempt 循环（原 331–336 / 557–575 的骨架）。
   *
   * @param {Object} ctx 单曲上下文
   */
  async function runSongTask(ctx) {
    const { song, maxAttempts } = ctx;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 取消 / 任务已被移出队列（如重试等待期被 splice）→ 终止协程，不再取流落盘
      if (shouldAbort(song)) {
        ctx.lastError = cancelledError();
        break;
      }
      try {
        const outcome = await runAttempt(ctx, attempt);
        if (!outcome) continue;
        if (outcome.action === 'finish') return outcome.value;
        break; // 'break'：本轮失败不可重试 / 用尽，进入 P12
      } catch (e) {
        const willRetry = await handleAttemptFailure(ctx, e, attempt); // P11
        if (!willRetry) break;
      }
    }
    return finalizeFailure(ctx); // P12
  }

  /**
   * 一轮 attempt 的顺序流水线（P2 → P10）。
   * 返回 `null` 表示继续下一轮（只可能来自 P11 重试），否则是终止信号。
   *
   * @param {Object} ctx 单曲上下文
   * @param {number} attempt 第几次尝试（1-based）
   */
  async function runAttempt(ctx, attempt) {
    startAttempt(ctx, attempt); // P2
    const policyOutcome = await applyPolicyPhase(ctx); // P3
    if (policyOutcome) return policyOutcome;
    const streamOutcome = await resolveStream(ctx); // P4
    if (streamOutcome) return streamOutcome;
    const paths = await preparePaths(ctx); // P5（返回 ext / savePath / dirPlan）
    await checkDiskSpace(ctx, paths.dirPlan); // P6
    await transferFile(ctx, paths); // P7
    const abortOutcome = await handlePostTransferAbort(ctx); // P8
    if (abortOutcome) return abortOutcome;
    await finalizeLyrics(ctx, paths); // P9
    await finishSuccess(ctx, paths); // P10
    return finish();
  }

  // ── P1 初始化（原 326–329）────────────────────────────────────
  /**
   * 逐曲快照：`maxAttempts` 在协程启动时取一次 —— 下载中途改设置不回溯影响在途任务。
   *
   * @param {Object} song 队列条目
   * @returns {{song: Object, urlInfo: Object|null, lastError: Error|null, isFatal: boolean,
   *   cancelToken: string, maxAttempts: number}} 单曲上下文（字段与原局部变量一一对应）
   */
  function initContext(song) {
    const cancelToken = String(song.taskId || song.id);
    const maxAttempts = getMaxAttempts(); // 逐曲快照，中途改设置不影响在途任务
    return {
      song,
      urlInfo: null,
      lastError: null,
      isFatal: false,
      cancelToken,
      maxAttempts,
    };
  }

  // ── P2 attempt 顶（原 342–346）───────────────────────────────
  /**
   * 重试退避结束、重新开始这一轮时 status 还是 pending（退避期刻意显示"排队中"）。
   * 真正再开取流/传输之前必须先回到 downloading —— 否则这一轮成功后就是
   * pending → done，而状态机里没有这条边（"只有下载中的任务才可能完成"是
   * 它的不变量）。此处不推 queue-updated：退避→重试这一跳对 UI 不可见，
   * 与旧行为一致（旧实现同样是静默地从 pending 直接写 done）。
   */
  function startAttempt(ctx, attempt) {
    const { song } = ctx;
    if (song.status !== 'downloading') {
      transition(song, 'downloading', `第 ${attempt} 次尝试开始`);
    }
    logger.log(`[processOneSong] ▶ ${song.source} "${song.title}" - "${song.artist}" id=${song.id} quality=${song.quality || 'standard'}`);
  }

  // ── P3 策略（原 347–366）────────────────────────────────────
  /**
   * skip 复用 status 'done'（QUEUE_STATUSES 是封闭集合，sanitizeRestoredTask 会校验）；
   * skipReason 让 UI 能说「被策略跳过」而不是「已下载」。
   *
   * @returns {Promise<null|{action: 'finish', value: {skipped: boolean, reason: string, ruleId: string}}>}
   */
  async function applyPolicyPhase(ctx) {
    const { song } = ctx;
    const policy = await evaluatePolicy(song);
    if (policy.action === 'skip') {
      transition(song, 'done', '策略跳过');
      song.progress = 0;
      song.error = null;
      song.skipReason = policy.reason;
      song.skipRule = policy.ruleId;
      logger.log(`[processOneSong] policy skip (${policy.ruleId}): ${policy.reason}`);
      notify(true);
      return finish({ skipped: true, reason: policy.reason, ruleId: policy.ruleId });
    }
    if (policy.action === 'demote') {
      logger.log(`[processOneSong] policy demote: ${song.quality} -> ${policy.quality} (${policy.reason})`);
      song.demoteReason = policy.reason;
      song.quality = policy.quality;
    }
    return CONTINUE;
  }

  // ── P4 取流（原 368–391）────────────────────────────────────
  /**
   * 检查点 1：取流是一跳网络往返，期间用户完全可能已经取消或移除。
   * fatal（VIP/Auth/Audio 流缺失）直接退出，不进重试循环（修复 B7）。
   */
  async function resolveStream(ctx) {
    const { song } = ctx;
    const urlInfo = await getDownloadUrlSmart(song, song.quality || 'standard');
    if (shouldAbort(song)) {
      ctx.lastError = cancelledError();
      return breakLoop();
    }
    logger.log('[processOneSong]   urlInfo keys =', urlInfo ? Object.keys(urlInfo).join(',') : 'null', 'hasUrl =', !!(urlInfo && urlInfo.url));
    if (!urlInfo || !urlInfo.url) {
      if (urlInfo?.fatal) {
        ctx.isFatal = true;
        ctx.lastError = new Error(urlInfo.error || '无法获取下载链接');
        song.errorCode = urlInfo.code || 'UNKNOWN';
        logger.warn(`[processOneSong] ✗ ${song.source} ${song.title} - ${song.artist} 失败: ${ctx.lastError.message} (code=${urlInfo.code})`);
        return breakLoop();
      }
      throw new Error(urlInfo?.error || '无法获取下载链接');
    }
    // 换源成功：记回歌曲供下次直试 + 队列可见（文件名仍用原歌信息）
    if (urlInfo.matchedSong) {
      song._altSource = { source: urlInfo.matchedSong.source, id: String(urlInfo.matchedSong.id) };
      logger.log(`[processOneSong] ↻ 已换源: ${urlInfo.matchedFrom} → ${urlInfo.matchedSong.source}`);
      notify();
    }
    ctx.urlInfo = urlInfo;
    return CONTINUE;
  }

  // ── P5 命名 / 目录（原 393–435）─────────────────────────────
  /**
   * 命名模板渲染 + saveDir 兜底 + 路径模板规划 + 落盘前沙箱复核。
   *
   * @returns {Promise<{ext: string, savePath: string, dirPlan: Object}>}
   *   `dirPlan` 对象原样传给 P6 —— savePath / mkdir / statfs 三处必须同源。
   */
  async function preparePaths(ctx) {
    const { song, urlInfo } = ctx;
    const ext = (urlInfo.ext || 'mp3').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10) || 'mp3';
    // 命名模板：从 preferences 读取，支持 {title} {artist} {album} {source} {id}
    const namingTemplate = readPrefs('namingTemplate') || DEFAULT_TEMPLATE;
    const saveDir = resolveSaveDir(ctx, song);
    // 路径模板：设置页那个「使用中」的下载模板决定这首歌落在根目录的哪一层。
    // 规划不出来时一律落回根目录，绝不让「目录没算好」变成「下载失败」。
    const dirPlan = planDownloadDir(
      activePathTemplate(readPrefs('downloadTemplates'), readPrefs('activeDownloadTemplate')),
      saveDir, song);
    if (!dirPlan.applied && dirPlan.reason && dirPlan.reason !== 'no-template') {
      logger.warn('[processOneSong] 路径模板未生效，落回根目录:', dirPlan.reason);
    }
    // 落盘前的最后一道沙箱复核（审计 P1-7）：模板渲染出来的子目录此前没判过。
    // 复核不过就退回根目录：根目录已经过了根目录校验，下载照常进行。
    if (typeof isSaveDirAllowed === 'function' && !isSaveDirAllowed(dirPlan.dir)) {
      logger.warn('[processOneSong] 落盘目录未过沙箱复核，退回根目录:', dirPlan.dir);
      dirPlan.dir = saveDir;
      dirPlan.applied = false;
      dirPlan.reason = 'outside-save-dir';
    }
    // 在同一个对象上改写而不是另起 finalDir：savePath / mkdir / statfs 三处同源。
    const savePath = path.join(dirPlan.dir, sanitizeFilename(renderFileName(namingTemplate, song, ext)));
    await fs.promises.mkdir(dirPlan.dir, { recursive: true }).catch(e => {
      logger.warn('[processOneSong] 创建下载目录失败:', dirPlan.dir, e.message);
    });
    return { ext, savePath, dirPlan };
  }

  /**
   * saveDir 兜底：用户从未选过下载目录时渲染层传 null，path.join(null) 直接崩溃。
   * C1: 渲染层可整包传入 song.saveDir —— 未经用户批准的目录（XSS 场景）
   * 一律回落到 prefs/默认目录，防任意路径写文件（queue.json 也会持久化它）。
   */
  function resolveSaveDir(ctx, song) {
    let songSaveDir = song.saveDir || null;
    if (songSaveDir && typeof isSaveDirAllowed === 'function' && !isSaveDirAllowed(songSaveDir)) {
      logger.warn('[processOneSong] 拒绝未批准 saveDir，回落默认目录:', songSaveDir);
      songSaveDir = null;
    }
    return songSaveDir || readPrefs('saveDir')
      || (typeof getDefaultDownloadDir === 'function' ? getDefaultDownloadDir()
        : path.join(userDataDirSafe(), MUSIC_DIR_NAME));
  }

  // ── P6 容量预检（原 437–453）────────────────────────────────
  /**
   * 磁盘快满时提前给出人话错误（否则写出半截文件才 ENOSPC）。
   * statfs 不可用/出错一律放行，绝不因预检本身挡下载。
   */
  async function checkDiskSpace(ctx, dirPlan) {
    const { song } = ctx;
    if (typeof fs.promises.statfs === 'function') {
      try {
        const verdict = diskSpace.diskVerdict(
          diskSpace.availFromStatfs(await fs.promises.statfs(dirPlan.dir)), song.quality);
        if (!verdict.ok) {
          throw Object.assign(
            new Error(diskSpace.diskShortageMessage(
              { availBytes: verdict.availBytes, neededBytes: diskSpace.estimateSongBytes(song.quality) }, song.quality)),
            { diskShortage: true });
        }
      } catch (e) {
        if (e.diskShortage) throw e;
        logger.warn('[processOneSong] statfs 失败，跳过容量预检:', e.message);
      }
    }
  }

  // ── P7 传输（原 455–470）────────────────────────────────────
  /**
   * 修复 B8：携带 extraHeaders（Referer 等），downloadFile 内部重定向会递归传递
   * B 站 DASH CDN 要求 Referer: https://www.bilibili.com/，否则可能 403。
   *
   * 进度节流（120ms + 100% 必发）、速度采样与 emitProgress 守卫全部在 events.js：
   * 每次传输尝试生成一份独立的节流时钟，song.progress 仍逐 chunk 更新。
   */
  async function transferFile(ctx, paths) {
    const { song, urlInfo, cancelToken } = ctx;
    const extraHeaders = urlInfo.referer ? { 'Referer': urlInfo.referer } : {};
    // 读取限速设置（KB/s → bytes/s）
    const speedLimitKB = readPrefs('speedLimit') || 0;
    const speedLimit = speedLimitKB > 0 ? speedLimitKB * 1024 : 0;
    await downloadFileWithRetry(
      urlInfo.url,
      paths.savePath,
      events.makeOnProgress(song, cancelToken),
      extraHeaders,
      { speedLimit, token: cancelToken },
    );
  }

  // ── P8 传输后取消检查（原 472–491）──────────────────────────
  /**
   * 检查点 2：传输层收尾。此处是最后一道闸 —— 过了它就会嵌标签、写历史、
   * 弹通知，而任务可能早已不在队列里（那些动作对用户不可见）。
   *
   * 为什么不删已落盘的文件：文件此刻已经是**完整**的（传输层刚 rename 过），
   * 用户移除队列项的语义是「别再下了」，不是「把已下好的删掉」。
   */
  async function handlePostTransferAbort(ctx) {
    const { song } = ctx;
    if (!shouldAbort(song)) return CONTINUE;
    logger.log('[processOneSong] 传输完成时任务已被取消/移除：保留已落盘文件，'
      + '但不再嵌标签、写历史或通知 —', song.title);
    events.forget(song.taskId);
    notify(true);
    if (!getQueue().includes(song)) return finish(); // 已被移出队列：无需终态
    // 仍在队列里（用户取消）：**必须**落到终态，否则它会永远停在「下载中」——
    // 调度器只把 status 为 downloading/pending 的条目算作在途，卡住不落终态
    // 连带让并发槽与重排逻辑失真。
    transition(song, 'error', '用户取消（传输已收尾）');
    song.error = '下载已取消';
    song._cancelRequested = false;
    return finish();
  }

  // ── P9 歌词 / ID3 / LRC（原 493–517）────────────────────────
  /** 歌词（换源成功时优先用匹配源的 id 同源拿，更准）、ID3 标签、sidecar .lrc。 */
  async function finalizeLyrics(ctx, paths) {
    const { song, urlInfo } = ctx;
    let lrc = '';
    try {
      const lyricId = urlInfo.matchedSong ? urlInfo.matchedSong.id : song.id;
      const lyricSource = urlInfo.matchedSong ? urlInfo.matchedSong.source : song.source;
      const lyricsResult = await getLyrics(lyricId, lyricSource, song.title, song.artist);
      lrc = lyricsResult.lrc || '';
    } catch (_e) { /* 歌词获取失败不影响下载 */ }

    // ID3 标签（修复 B6：embedId3Tags 内部只对 mp3 生效，跳过 m4a/flac）
    await embedId3Tags(paths.savePath, {
      title: song.title,
      artist: song.artist,
      album: song.album || '',
      coverUrl: song.cover,
      lrc,
    });

    // LRC 歌词文件（独立 try-catch：写歌词失败不应覆盖已成功的下载）
    if (lrc) {
      const lrcPath = sidecarPathFor(paths.savePath);
      fs.promises.writeFile(lrcPath, lrc, 'utf8').catch(lrcErr => {
        logger.warn('[processOneSong] LRC 写入失败（不影响下载结果）:', lrcErr.message);
      });
    }
  }

  // ── P10 成功终态（原 519–556）───────────────────────────────
  /** done + savePath + 通知门禁 + history.add(done)。 */
  async function finishSuccess(ctx, paths) {
    const { song } = ctx;
    transition(song, 'done', '下载成功');
    song.progress = 100;
    song.savePath = paths.savePath;
    song.error = null;
    ctx.lastError = null;
    events.forget(song.taskId);
    showDownloadDoneNotification(song, paths.savePath);
    await addDoneHistory(ctx, paths.ext, paths.savePath);
  }

  /** 下载完成通知（默认开启；门禁留在引擎，Port 只管弹）。 */
  function showDownloadDoneNotification(song, savePath) {
    if (readPrefs('notifications') !== false) {
      try {
        notification.downloadDone(song, savePath);
      } catch (e) {
        logger.warn('[NotifyPort] 显示失败:', e.message);
      }
    }
  }

  /** 写入下载历史（换源成功时记实际取流源，便于排查与统计）。 */
  async function addDoneHistory(ctx, ext, savePath) {
    const { song, urlInfo } = ctx;
    try {
      const stat = await fsa.statOrNull(savePath);
      history.add({
        id: String(song.id),
        source: urlInfo.matchedSong ? urlInfo.matchedSong.source : song.source,
        matchedFrom: urlInfo.matchedSong ? song.source : undefined,
        title: song.title,
        artist: song.artist || '',
        album: song.album || '',
        savePath,
        ext,
        quality: song.quality || 'standard',
        size: stat ? stat.size : 0,
        duration: song.duration || 0,
        status: 'done',
        finishedAt: Date.now(),
      });
    } catch (e) {
      logger.warn('[history.add] 写历史失败:', e.message);
    }
  }

  // ── P11 重试判定（原 557–574）───────────────────────────────
  /**
   * 只对 403/404/410 重试（CDN URL 签名过期，重拿 URL 再下），其他错误直接放弃。
   *
   * @returns {Promise<boolean>} true = 已置 pending 并等待退避，继续下一轮；
   *   false = 不可重试 / 重试用尽，交给 P12
   */
  async function handleAttemptFailure(ctx, e, attempt) {
    const { song, maxAttempts } = ctx;
    ctx.lastError = e;
    const msg = e.message || String(e);
    const isRetriable = /HTTP\s*(403|404|410)/i.test(msg);
    logger.warn(`下载失败 (尝试 ${attempt}/${maxAttempts}):`, msg);

    if (attempt < maxAttempts && isRetriable) {
      transition(song, 'pending', '可重试错误，等待重试');
      song.progress = 0;
      notify();
      // 退避定时器归 scheduler（500ms，与拆分前一致）：退出时由
      // scheduler.stop() 清掉，不在本模块留第二条 setTimeout。
      await waitRetryBackoff();
      return true;
    }
    return false; // 不可重试或重试用尽
  }

  // ── P12 失败终态（原 577–641）───────────────────────────────
  /**
   * cancelled 分支、transportCode 补码、队列外跳过、history.add(error)、emitError。
   * 体量超过 40 行的部分按原代码块原样拆成两个子步骤（不新增语义）：
   * `addErrorHistory` / `emitFailureError`。
   */
  async function finalizeFailure(ctx) {
    if (!ctx.lastError) return;
    const { song } = ctx;
    transition(song, 'error', ctx.lastError.cancelled ? '用户取消' : '下载失败');
    song.error = ctx.lastError.message;
    song._cancelRequested = false;
    events.forget(song.taskId);
    if (ctx.lastError.cancelled) {
      // 用户主动取消：不写失败历史、不发 download-error toast
      // 终态立即落盘（不能依赖调度器 .finally —— 微任务时序下 waitFor
      // 观察到终态时可能尚未落盘；且防抖窗口内崩溃会丢取消终态）
      notify(true);
      return;
    }
    // 传输层失败（断网/超时）在这里补上码；取流层已写好的码更准，不被覆盖。
    if (!song.errorCode) {
      const netCode = transportCode(ctx.lastError);
      if (netCode) song.errorCode = netCode;
    }
    // 检查点 3：终态落笔前。取消/移除发生在取流或传输之后时，旧代码只在循环
    // 顶部查过，于是会往 history 里塞一条用户根本没下过的 error 记录。
    if (!getQueue().includes(song)) {
      logger.log('[processOneSong] 任务已被移出队列，跳过失败历史与错误通知 —', song.title);
      events.forget(song.taskId);
      notify(true);
      return;
    }
    await addErrorHistory(ctx);
    emitFailureError(ctx);
    // error 终态立即落盘（同 cancelled —— 不能依赖调度器 .finally 的微任务时序）
    notify(true);
  }

  /** 写历史：失败（P12 原 607–630）。 */
  async function addErrorHistory(ctx) {
    const { song } = ctx;
    try {
      history.add({
        id: String(song.id),
        source: song.source,
        title: song.title,
        artist: song.artist || '',
        album: song.album || '',
        savePath: '',
        ext: '',
        quality: song.quality || 'standard',
        size: 0,
        duration: song.duration || 0,
        status: 'error',
        error: ctx.lastError.message,
        // 取流侧的分类码一起落盘，历史行的 🆘 才不必退回关键词去猜。
        // 无码留 undefined（JSON 直接丢键，不写空串伪码）；history.add 是
        // {...existing, ...entry} 合并写，所以"这次没码"会覆盖"上次的码"。
        errorCode: song.errorCode || undefined,
        finishedAt: Date.now(),
      });
    } catch (e) {
      logger.warn('[history.add] 写历史失败:', e.message);
    }
  }

  /** 修复 B7：通知前端标记 fatal，前端可弹更友好的 toast（如"该歌曲需要 VIP"）。 */
  function emitFailureError(ctx) {
    const { song } = ctx;
    events.emitError(song.taskId || song.id, {
      id: song.taskId || song.id,
      title: song.title,
      artist: song.artist,
      error: ctx.lastError.message,
      fatal: ctx.isFatal,
    });
  }

  // ── 协作判据（原 307–309 / 645–651）─────────────────────────
  /**
   * 任务是否已不该继续：用户取消，或已被移出队列（移除/清空/批量操作）。
   * 「什么时候该停」只有这一个事实来源，日志、返回、终态分支用同一条判据。
   */
  function shouldAbort(song) {
    return !!(song && song._cancelRequested) || !getQueue().includes(song);
  }

  /** userDataDir 的安全访问（未 ready 时回落临时目录，避免 path.join(null) 崩溃） */
  function userDataDirSafe() {
    try {
      return userDataDir() || require('os').tmpdir();
    } catch (_e) {
      return require('os').tmpdir();
    }
  }

  return { processOneSong };
}

module.exports = {
  createSongTask,
};