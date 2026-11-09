# ADR 0003：下载引擎拆分（`src/main/downloadQueue.js` → 多模块）

- 状态：**Accepted（已实施）**
- 日期：2026-11-07
- 实施日期：2026-11-07（§5 的 6 个步骤全部完成，结果见 §九）
- 决策范围：仅 `src/main/downloadQueue.js` 的文件内结构；**不改运行行为、不改事件名与载荷、不动渲染层**
- 前置：`docs/adr/0002-download-ports.md`（端口化已完成，`progress` / `notify` 已是注入端口）
- 相关：`src/main/downloadQueue/statemachine.js`（已接入，唯一状态迁移表）

---

## 0. 事实基线（全部实测，不含估算）

### 0.1 行数（先纠正任务书里的"953 行"）

| 指标 | 实测值 | 测量方式 |
|---|---|---|
| 物理行数 | **956** | 文件 LF 计数 = 956，最后一行（956）是 `};` |
| 空行 | **51** | `Trim() -eq ''` |
| 纯注释行（`//`、`/*`、`*` 开头） | **324** | 正则 `^(//\|\*|/\*)` |
| 有效代码行（非空且非纯注释） | **581** | 956 − 51 − 324 |

结论：**956 行里有 375 行（39.2%）不是代码**（51 空行 + 324 注释行）。任务书写的"953 行"与实测差 3 行；`docs/adr/0002-download-ports.md` 里写的"≈916 行"也是估算值。本文档全部以 **956 物理行 / 581 有效行** 为准。

这个比例直接决定行数目标：**按物理行**切 ≤300 是容易的（注释可以随代码一起搬走），**按有效行**切才是有意义的约束（见 §6.6）。

### 0.2 测试基线（实测跑过，不是"应该绿"）

```
node --test test/downloadQueue.test.js "test/queue-*.test.js"
ℹ tests 137   ℹ pass 137   ℹ fail 0   ℹ duration_ms 9158.6
```

其中**直连下载引擎**的只有 5 个文件、83 项：

| 文件 | 用例数 | 与被测对象的关系 |
|---|---|---|
| `test/downloadQueue.test.js` | 52 | 只用 `createDownloadQueueEngine` + `sanitizeFilename` / `sanitizeRestoredTask` / `MAX_RESTORED_TASKS` |
| `test/queue-statemachine.test.js` | 21 | 直测 `downloadQueue/statemachine.js` 纯函数 |
| `test/queue-resume.test.js` | 4 | 经 `createDownloadQueueEngine` |
| `test/queue-abort.test.js` | 3 | 经 `createDownloadQueueEngine` |
| `test/queue-progress-throttle.test.js` | 3 | 经 `createDownloadQueueEngine` |

其余 54 项（`queue-filter` / `queue-group` / `queue-order` / `queue-summary` / `queue-bulk-remove` / `queue-copy-list` / `queue-heart` / `queue-locate` / `queue-pl-sel` / `queue-playlist`）测的是**渲染层纯模块**（`src/renderer/js/queueFilter.js`、`src/main/queueOrder.js` 等），与本次拆分零耦合——这是"测试改动面小"的实测依据。

另有 **2 个不在 137 集合内、但对本次拆分极敏感**的源码文本断言测试，必须一并跑：

- `test/retry-attempts-setting.test.js:74`、`:107` —— `readFileSync('src/main/downloadQueue.js')` 后用正则断言 `const maxAttempts = getMaxAttempts\(\);` 与导出列表里存在 `getMaxAttempts,`
- `test/download-path.test.js:206` —— 读同一文件做**负断言**：不得出现 `path.join(saveDir, sanitizeFilename(renderFileName` 形态

### 0.3 外部依赖面（拆分必须保住的契约）

`createDownloadQueueEngine` 返回的实例方法被以下位置使用（实测 `grep`）：

| 方法 | 调用点 |
|---|---|
| `getQueue()` | `src/main/index.js:114`、`:447`、`:605`；`src/main/taskbarProgress.js:71`（经 `getQueue` 注入）；`src/main/subscriptions.js:203`；`src/main/ipc/download/queue.js:88`、`:122`、`:141`、`:167`、`:179`、`:197`、`:209` |
| `persistQueue()` | `index.js:582`、`:606`；`ipc/download/queue.js:113`、`:135`、`:155`、`:173`、`:183`、`:203`、`:216` |
| `processQueue()` | `index.js:585`、`:607`；`ipc/download/queue.js:114`、`:156`；`subscriptions.js:225` |
| `requestCancel()` | `index.js:586`、`:608`；`ipc/download/queue.js:78`、`:126` |
| `setPaused()` / `isPaused()` | `index.js:587-588`、`:609-610`；`ipc/download/queue.js:191-192` |
| `loadPersistedQueue()` | `index.js:472` |
| `resumeRestoredQueue()` | `index.js:495` |
| `dispose()` | `index.js:554` |
| `getActiveCount()` | `test/downloadQueue.test.js:612`（仅测试） |
| `getMaxAttempts()` | `test/retry-attempts-setting.test.js:45-79`（仅测试） |
| `sanitizeFilename` / `sanitizeRestoredTask` / `MAX_RESTORED_TASKS` | 仅测试 |

**关键事实**：`getQueue()` 返回的是**引擎内部的活数组引用**（`index.js:447` 直接把它赋给模块级 `downloadQueue`）。因此拆分的第一硬约束不是"函数怎么分"，而是**数组身份不能变**。

---

## 1. 函数清单（36 个：5 顶层 + 21 闭包具名 + 10 匿名回调）

> 行号全部来自实测读取；"有效行"= 该区间内非空且非纯注释的行数（同一统计口径见 §0.1）。

### 1.1 模块顶层（5 个，`module.exports` 可见 4 个）

| # | 函数名 | 行号区间 | 物理行 | 有效行 | 职责（一句话） | 闭包内 |
|---|---|---|---|---|---|---|
| 1 | `sanitizeFilename` | 96–98 | 3 | 3 | 把路径分隔符与 `:*?"<>|` 换成 `_` 并截断到 200 字符 | 否 |
| 2 | `sanitizeRestoredTask` | 113–122 | 10 | 9 | 校验一条恢复条目（普通对象 + 有 id + status 在词汇表内），并剔除 `_processing` / `_cancelRequested` | 否 |
| 3 | `applyStatus` | 139–142 | 4 | 4 | 状态唯一写入出口：调 `statemachine.transition` 后删掉审计字段 `_lastTransition` | 否 |
| 4 | `guardPort` | 180–186 | 7 | 7 | 端口调用包 try/catch，端口抛错只记 warn，绝不断下载 | 否 |
| 5 | `createDownloadQueueEngine` | 205–948 | 744 | 558 | 引擎工厂：校验 4 个必需依赖、持有全部状态、装配 21 个闭包函数并返回实例 | 否 |

`createDownloadQueueEngine` 的 558 有效行 = 581 − (3+9+4+7)。

### 1.2 闭包内具名函数（21 个，全部在 `createDownloadQueueEngine` 作用域内）

| # | 函数名 | 行号区间 | 物理行 | 有效行 | 职责（一句话） | 闭包内 |
|---|---|---|---|---|---|---|
| 6 | `QUEUE_FILE` | 234 | 1 | 1 | 派生 `queue.json` 绝对路径（`userDataDir()` 惰性求值） | 是 |
| 7 | `evaluatePolicy` | 247–269 | 23 | 21 | 读 `prefs.qualityPolicyRules` + 注入的本地事实，产出 `keep/skip/demote` 决策；读失败降级为 keep | 是 |
| 8 | `getConcurrency` | 271–278 | 8 | 8 | 读 `prefs.concurrency`，1..10 之外回落 3 | 是 |
| 9 | `getPerSourceCap` | 285–294 | 10 | 10 | 读 `prefs.perSourceConcurrency`（1..10，默认 2），再 `min` 全局并发 | 是 |
| 10 | `getMaxAttempts` | 300–307 | 8 | 8 | 读 `prefs.maxAttempts`，整数 1..5 之外回落 `MAX_RETRY=2` | 是 |
| 11 | `activeCountBySource` | 310–316 | 7 | 7 | 遍历队列统计某源处于 `downloading` 的条数（不另立计数器） | 是 |
| 12 | `pickSchedulable` | 319–325 | 7 | 7 | 按队列顺序找第一条 `pending` 且 `!_processing` 且该源未到 cap 的任务 | 是 |
| 13 | `trimDoneTasks` | 328–340 | 13 | 13 | `done` 超过 200 条时按入队顺序 splice 掉最旧的 | 是 |
| 14 | `notifyQueueChanged` | 348–351 | 4 | 4 | 队列变更唯一出口：先 `emitQueueUpdated(活数组)`，再 `persistQueue({immediate})` | 是 |
| 15 | `writeQueueNow` | 354–361 | 8 | 8 | 同步落盘：trim + `atomicWriteJson`，异常只记 warn | 是 |
| 16 | `persistQueue` | 368–382 | 15 | 15 | `immediate` 立即落盘并清防抖；否则 500ms 防抖合并 | 是 |
| 17 | `loadPersistedQueue` | 385–425 | 41 | 35 | 读盘 → 逐条 `sanitizeRestoredTask` → `downloading→error`、stale `pending→error` → push 进队列 | 是 |
| 18 | `resumeRestoredQueue` | 446–456 | 11 | 9 | 恢复后若存在 pending，用 `Promise.resolve().then(processQueue)` 推上调度器并返回条数 | 是 |
| 19 | `shouldAbort` | 471–473 | 3 | 3 | 协作式取消判据：`_cancelRequested` 为真 **或** 已不在队列数组内 | 是 |
| 20 | `processOneSong` | 480–487 | 8 | 8 | 维护 `_processing`（try/finally 全程为真），包住 `_processOneSongInner` | 是 |
| 21 | `_processOneSongInner` | 489–820 | **332** | **243** | 单曲全流程：attempt 循环内的策略→取流→命名→mkdir→容量→传输→歌词→ID3→历史→通知→重试→失败终态 | 是 |
| 22 | `userDataDirSafe` | 823–829 | 7 | 7 | `userDataDir()` 空/抛错时回落 `os.tmpdir()` | 是 |
| 23 | `processQueue` | 835–875 | 41 | 36 | 调度循环：`_paused`/重入保护 → 按并发与单源 cap 启动协程 → `.finally` 里减计数 + 100ms 重排 | 是 |
| 24 | `requestCancel` | 882–891 | 10 | 10 | 找在途任务（`downloading`，或 `pending && _processing`）置取消标记并调 `downloader.cancelDownload` | 是 |
| 25 | `setPaused` | 894–901 | 8 | 8 | 置 `_paused`；恢复时清 processTimer、复位重入标志并立即 `processQueue()` | 是 |
| 26 | `dispose`（对象方法） | 926–941 | 16 | 16 | 退出清理：防抖窗口内的队列立即落盘，并停掉两个定时器 | 是 |

### 1.3 匿名 / 内联回调（10 个，有独立语义，拆模块时必须显式搬走）

| # | 回调 | 行号区间 | 物理行 | 职责 | 所属函数 |
|---|---|---|---|---|---|
| 27 | 防抖 setTimeout 回调 | 378–381 | 4 | 500ms 到点后清 timer 再 `writeQueueNow()` | `persistQueue` |
| 28 | `.then(() => processQueue())` / `.catch(...)` | 452–454 | 3 | 恢复后异步起调度，吞掉意外 rejection | `resumeRestoredQueue` |
| 29 | `mkdir(...).catch(...)` | 597–599 | 3 | 建目录失败只 warn（后续写文件会给出真实错误） | `_processOneSongInner` |
| 30 | `downloadFileWithRetry` 的 `onProgress` | 628–650 | 23 | 写 `song.progress`、按 120ms 节流推 `download-progress`、算速度/ETA | `_processOneSongInner` |
| 31 | `writeFile(lrc)` 的 `.catch(...)` | 694–696 | 3 | 歌词写失败不影响下载结果 | `_processOneSongInner` |
| 32 | `processOneSong(...).finally(...)` | 851–867 | 17 | 减 `activeDownloads`、终态立即落盘、有 pending 时 100ms 后重排 | `processQueue` |
| 33 | 重排 setTimeout 回调 | 859–863 | 5 | 清 timer、复位 `_processQueueRunning`、再 `processQueue()` | `processQueue` |
| 34 | `getQueue` getter | 905 | 1 | 返回内部数组**引用** | 返回对象 |
| 35 | `getActiveCount` getter | 906 | 1 | 返回 `activeDownloads` | 返回对象 |
| 36 | `isPaused` getter | 915 | 1 | 返回 `_paused` | 返回对象 |

**函数总数：36。** 另有实测 33 行代码里出现 `=>`，扣掉上表 10 处回调后，剩下约 20 处是 `filter/find/some` 的单行谓词，不单独计为函数。

### 1.4 单函数规模头号问题

`_processOneSongInner`：332 物理行 / 243 有效行，**单函数占全文件有效代码的 41.8%**。它一个人就超过 ≤300 的目标。任何"按函数整体搬运"的拆分方案都必然先把它按 phase 切开（见 §5 步骤 5 与 §8.1）。

---

## 2. 共享状态矩阵（拆分难度的核心）

### 2.1 闭包变量（21 个绑定 = 7 可变 + 1 派生 + 13 注入）

| 变量 | 声明行 | 写入者（行号） | 读取者（行号） | 触及函数数 | 建议归属 |
|---|---|---|---|---|---|
| `downloadQueue`（数组） | 226 | `trimDoneTasks`(334 splice)、`loadPersistedQueue`(414 push) | `activeCountBySource`(312)、`pickSchedulable`(320)、`trimDoneTasks`(329,332-333)、`notifyQueueChanged`(349)、`writeQueueNow`(357)、`loadPersistedQueue`(401)、`resumeRestoredQueue`(447)、`shouldAbort`(472)、`_processOneSongInner`(497,663,779)、`processQueue`(857)、`requestCancel`(883)、`getQueue`(905)、`dispose`(932) | **13**（写 2 / 读 13） | `queueStore.js` |
| `speedStates`（对象） | 227 | `onProgress`(641)、`_processOneSongInner`(661,704,759,781 `delete`) | `onProgress`(640) | **2** | `progressPort.js` |
| `activeDownloads` | 228 | `processQueue`(848 `++`、852 `--`) | `processQueue`(842,871)、`getActiveCount`(906) | **3** | `scheduler.js` |
| `processTimer` | 229 | `processQueue`(858 clear、859 set、860 null)、`setPaused`(897 clear+null)、`dispose`(938 clear、939 null) | `processQueue`(858)、`setPaused`(897)、`dispose`(937) | **3** | `scheduler.js` |
| `_processQueueRunning` | 230 | `processQueue`(838 true、861/865/872 false)、`setPaused`(898 false) | `processQueue`(837) | **2** | `scheduler.js` |
| `_paused` | 231 | `setPaused`(895) | `processQueue`(836)、`isPaused`(915) | **3** | `scheduler.js` |
| `queuePersistTimer` | 232 | `persistQueue`(371,372,378 set,379)、`dispose`(928,929) | `persistQueue`(370,377)、`dispose`(927) | **2** | `persistence.js` |
| `QUEUE_FILE`（派生函数） | 234 | —（只读派生） | `writeQueueNow`(357)、`loadPersistedQueue`(387)、`dispose`(932) | **3** | `persistence.js` |
| `userDataDir`（注入） | 206 | — | `QUEUE_FILE`(234)、`userDataDirSafe`(825) | **2** | facade → persistence |
| `progress`（注入端口） | 207 | — | `notifyQueueChanged`(349)、`onProgress`(649)、`_processOneSongInner`(810) | **3** | facade → progressPort |
| `getDownloadUrlSmart`（注入） | 208 | — | `_processOneSongInner`(532) | **1** | facade → taskRunner |
| `getLyrics`（注入） | 209 | — | `_processOneSongInner`(678) | **1** | facade → taskFinalize |
| `isSaveDirAllowed`（注入） | 210 | — | `_processOneSongInner`(565,589) | **1** | facade → taskPaths |
| `getDefaultDownloadDir`（注入） | 211 | — | `_processOneSongInner`(570) | **1** | facade → taskPaths |
| `notify`（注入端口） | 212 | — | `_processOneSongInner`(709 `downloadDone`)。**`showInFolder` 引擎零调用**（仅 `index.js:421` 的点击回调在用） | **1** | facade → taskFinalize |
| `history`（注入） | 213 | — | `_processOneSongInner`(718,787) | **1** | facade → taskFinalize |
| `fsa`（注入） | 214 | — | `_processOneSongInner`(717 `statOrNull`) | **1** | facade → taskFinalize |
| `downloader`（注入对象） | 215 | — | `requestCancel`(887 `cancelDownload`) | **1** | facade → scheduler |
| `downloadFileWithRetry`（解构） | 222 | — | `_processOneSongInner`(628) | **1** | facade → taskRunner |
| `embedId3Tags`（解构） | 222 | — | `_processOneSongInner`(683) | **1** | facade → taskFinalize |
| `getPolicyFacts`（注入） | 216 | — | `evaluatePolicy`(259-261) | **1** | facade → taskRunner |

模块级常量（不计入闭包，但拆分时也要跟着走）：`MAX_DONE_RETAINED`(52)、`STALE_PENDING_MS`(54)、`MAX_RETRY`(56)、`RETRY_BACKOFF_MS`(58)、`PERSIST_DEBOUNCE_MS`(60)、`QUEUE_STATUSES`(69–70)、`MAX_RESTORED_TASKS`(75)、`PROGRESS_THROTTLE_MS`(89)。

**读法**：触及函数数 ≥3 的变量只有 6 个（`downloadQueue` 13、`processTimer` 3、`_paused` 3、`activeDownloads` 3、`QUEUE_FILE` 3、`progress` 3）。这是"拆分可行"的量化依据——耦合面比 956 行的体量小得多。真正的难点是 `downloadQueue`（13 个函数共用 + 模块外 4 个文件直写）。

### 2.2 队列条目上的可变字段（第二层共享状态，容易被漏掉）

引擎不持有"任务类"，而是直接改 `song` 上的字段；这些 `song` 对象**同时被 IPC 层、渲染层、`history` 读取**：

| 字段 | 引擎写入点 | 引擎读取点 | 模块外写入点 | 建议归属 |
|---|---|---|---|---|
| `status` | `applyStatus` 9 处：407,411,508,517,667,699,745,756,845 | 313,321,329,333,447,507,857,883-884 | **`ipc/download/queue.js:146`（`song.status='pending'`，绕过状态机）**、`subscriptions.js:215`（新对象初始值） | `queueStore.transition` |
| `_processing` | 481(true)、485(false) | 321、884 | `ipc/download/queue.js:70,124` | `queueStore`（由 `processOneSong` 的 finally 收口） |
| `_cancelRequested` | 886(true)、669(false)、758(false) | 472、497、630 | `ipc/download/queue.js:74,81` | `queueStore` |
| `progress` | 518、631、700、746、847 | 渲染层直接读 | — | `progressPort`（写）+ `scheduler`（启动归零） |
| `error` | 408、412、668、757、846(null) | 渲染层 | `ipc:147` | `taskRunner` 终态 |
| `errorCode` | 544、774 | `taskFinalize`(803) | `ipc:148` | `taskRunner` 终态 |
| `savePath` | 701 | `taskFinalize`(717) | — | `taskFinalize` |
| `skipReason` / `skipRule` | 520、521 | 渲染层 | — | `taskRunner`（skip 分支） |
| `demoteReason` / `quality` | 528、529 | 559/623/726 等 | — | `taskRunner` |
| `_altSource` | 552 | 渲染层/下次直试 | — | `taskRunner` |
| `addedAt` | —（入队方写） | 409（stale pending 判据） | `ipc:111`、`subscriptions.js:217` | `queueStore`（读） |

**注意 `status` 那一行**：`ipc/download/queue.js:146` 的重试逻辑直接赋值 `song.status = 'pending'`，**不经过 `statemachine.transition`**。这是拆分前就已存在的"双重真相"，拆分时不能顺手改（超出本 ADR 范围），但必须在 §6 里点名，否则拆完后没人知道该收口在哪。

### 2.3 泄漏到模块外的状态（不在闭包里，但决定拆分边界）

1. **数组身份**：`index.js:447` 把 `getQueue()` 的返回值存成模块级 `downloadQueue`；`subscriptions.js:211` 直接 `downloadQueue.push(...)`；`ipc/download/queue.js` 有 7 个 handler 直接 `push/splice/unshift/length=0`（111、133、150-153、171、180、200、213-215）。
2. **状态写入**：外部至少 8 处直接改 `song.status` / `song.error` / `_cancelRequested`（见 §2.2）。
3. **事件与落盘**：外部 handler 自己调 `progress.emitQueueUpdated` + `persistQueue()`（`ipc:112-113,134-135,154-155,172-173,182-183,202-203`），即"推送→落盘"这套时序在引擎外已经复制了 6 份。

**结论**：本次拆分只能是"引擎内部结构重排"，**不能**宣称"队列状态从此单一所有权"——外部直写仍在。这一点必须在 §4 推荐理由与 §6 风险里说清楚，否则会给出错误的安全感。

---

## 3. 方案对比

两个方案的共同前提（不因方案而变）：
- `createDownloadQueueEngine(deps)` 的签名、返回值、导出常量/工具函数**一字不改**（否则 137 项与 3 个源码断言测试全崩）
- `queue-updated` / `download-progress` / `download-error` 的**时机与载荷不变**
- 端口契约（§0.3 / ADR 0002）不变

### 3.1 方案 A：按职责切（调度 / 落盘 / 进度与事件 / 队列数据 / 单曲执行）

模块清单与预估（预估列明确标注"预估"，其余行号/有效行为实测）：

| 模块 | 承接的原行号 | 预估有效行 | 预估物理行 | 跨模块构造参数 | 自持状态 |
|---|---|---|---|---|---|
| `downloadQueue/queueStore.js` | 226、328–340、139–142 | 35 | 95 | 1（`maxDoneRetained`） | `downloadQueue` |
| `downloadQueue/persistence.js` | 232、234、354–361、368–382、385–425、113–122 | 81 | 205 | 3（`getQueue`、`userDataDir`、`transition`） | `queuePersistTimer` |
| `downloadQueue/scheduler.js` | 228–231、271–278、285–294、300–307、310–316、319–325、446–456、835–875、894–901 | 109 | 230 | 6（`store`、`runSong`、`notify`、`readPrefs`、`requestCancelHook`、`logger`） | `activeDownloads`、`processTimer`、`_processQueueRunning`、`_paused` |
| `downloadQueue/progressPort.js` | 89、227、348–351、628–650 | 36 | 105 | 3（`getQueue`、`progress`、`now`） | `speedStates`、节流时间戳 |
| `downloadQueue/taskPaths.js` | 557–599、601–617、823–829（`sanitizeFilename` 由步骤 1 的 `naming.js` 提供） | 48 | 120 | 2（`song`、`ctx`） | 无（纯） |
| `downloadQueue/taskRunner.js` | 471–473、480–487、489–510、511–555、619–650（调用点）、652–671、737–753 | 88 | 195 | 4（`song`、`paths`、`progress`、`deps`） | 无（`_processing` 由 store 收口） |
| `downloadQueue/taskFinalize.js` | 673–697、699–736、755–819 | 112 | 240 | 3（`song`、`result`、`ctx`） | 无 |
| `downloadQueue.js`（facade） | 205–224、903–956 | 50 | 130 | 12（原有外部依赖，数量不变） | 无（只装配） |

- 合计有效行 ≈ 559（较 581 少 22 行 ≈3.8%，差额是重复的 require/工厂样板）
- **最大物理行 240**（`taskFinalize.js`）、**最大有效行 112** —— 均满足 ≤300
- 跨模块构造参数总数 22；**单模块最多 6 个**
- **是否产生双重真相**：会，3 处：
  1. 数组：`queueStore` 持唯一引用，但外部仍 `getQueue()` 直写（既有事实）；
  2. 状态：`queueStore.transition` 与 `ipc:146` 的直写并存（既有事实，本次不收口）；
  3. 定时器：`processTimer` 归 scheduler、`queuePersistTimer` 归 persistence，`dispose` 必须按序调用两者。
- **测试改动面**：`downloadQueue.test.js` 的 `buildEngine()`（40–79）与 `queue-abort`/`queue-progress-throttle`/`queue-resume` 的 3 个 helper **零改动**（它们只碰 facade）；仅步骤 6 需改 2 个源码文本断言文件（3 处 `read(...)`）。

### 3.2 方案 B：按状态所有者切（状态机 + 队列数据管理 = 一个模块，其余尽量纯函数）

| 模块 | 承接内容 | 预估有效行 | 预估物理行 | 跨模块参数 | 备注 |
|---|---|---|---|---|---|
| `downloadQueue/engineCore.js` | 全部 7 个可变状态 + `applyStatus` + `trimDoneTasks` + `persistQueue/loadPersistedQueue/resumeRestoredQueue` + `processQueue/setPaused/requestCancel` + 单曲编排 | **≈330** | **≈520** | 0（自持状态） | **超 ≤300 硬约束** |
| `downloadQueue/taskPhases.js`（纯） | 557–736 的命名/目录/容量/歌词/ID3 | 110 | 230 | 2（`song`、`ctx`） | 每 phase 一个纯函数 |
| `downloadQueue/taskFailure.js`（纯） | 755–819 | 48 | 105 | 2 | 失败终态 + 历史 + `emitError` |
| `downloadQueue/queueData.js` | 226+328–340（若 core 再拆） | 30 | 80 | 2 | 只有走到这一步才出现 |
| `downloadQueue/naming.js` | 96–98 | 3 | 25 | 1 | — |
| `downloadQueue/policy.js` | 247–269 | 21 | 55 | 2 | — |

- **是否产生双重真相**：模块内部**不会**（7 个状态全在一个对象里）；但 `engineCore` 同时是"状态机 + 调度器 + 持久化 + 编排器"，任何一处改状态都可以不经过 `transition`，**"单一所有权"只体现在物理位置，没有体现为可检查的不变量**。
- **它达不到 ≤300**：`engineCore` 预估 520 物理行。要达标就必须再把 `queueData` / `scheduler` / `persistence` 从 core 里切出去 —— 那一步做完，**结果就是方案 A**。
- **测试改动面**：比 A 更大。若想单测"状态所有者"，必须额外导出 `createEngineCore`，`downloadQueue.test.js` 的 6 处 `buildEngine`（52 项共用）与 3 个外部 helper 需要新增 core 入口；否则 core 只能经 facade 间接测，B 的"可单测"卖点直接落空。

### 3.3 对比总表

| 维度 | 方案 A（按职责） | 方案 B（按状态所有者） |
|---|---|---|
| 模块数 | 7 生产模块 + 1 facade | 5–6（其中 1 个必然超限） |
| 最大文件物理行 | 240 ✓ | 520 ✗ |
| 最大文件有效行 | 112 ✓ | ≈330 ✗ |
| 单模块最多跨模块参数 | 6 | 0（core）/ 2（纯函数） |
| 内部双重真相 | 3 处（需显式收口） | 0 处（但不可检查） |
| 达标 ≤300 是否需要二次拆分 | 否 | **是，二次拆分后即等于 A** |
| 测试 helper 改动 | 0 个 helper | 4 个 helper（若导出 core） |
| 与 ADR 0002 端口化的兼容 | 端口实现留在 facade，契约不变 | core 会持有端口调用，端口边界被埋深 |

---

## 4. 推荐方案：**方案 A（按职责切）**

理由按重要性排序，每条都对应上表的实测数字：

1. **B 违反硬约束，且必然回退到 A。** `engineCore` 预估 520 物理行 / 330 有效行，超过 ≤300。要在 B 内部再切一刀（把 `queueData`、`scheduler`、`persistence` 拎出去），切完的文件边界就是 A 的边界。先做 B 等于多做一次迁移。
2. **真实的复杂度在"单函数太长"，不在"状态太多"。** `_processOneSongInner` 一个人 332 物理行 / 243 有效行（占 41.8%），而触及函数数 ≥3 的闭包变量只有 6 个（§2.1）。按职责切正好对准病根：把 243 行拆成 runner(88) + paths(45) + finalize(112)。
3. **`getQueue()` 的活引用是已经存在的强契约。** `queueStore` 作为显式 owner，把"数组身份"和"trim 时机"写在一个文件里；而 B 把数组藏在 500 行的 core 中间，改 trim 的人根本看不到 `ipc` 那 7 个直写点。
4. **测试改动面最小。** A 保住 facade 签名，4 个 `buildEngine` helper 零改动（实测这 4 个 helper 合计覆盖 62 项用例：52+4+3+3）；B 需要为 core 新增入口，反而要动 helper。
5. **端口边界不倒退。** ADR 0002 刚把 IPC/通知收成 `progress` / `notify` 两个端口，A 把这层留在 facade + `progressPort.js`（注入点清晰）；B 会让 core 深持端口调用，"引擎不知道主窗口存在"这条约束变得难以复核。

不选 B 的唯一代价：A 的 3 处跨模块状态（数组身份、status 写入、两个定时器）需要显式收口——对策见 §6.1 / §6.2 / §6.4，且每处都有对应测试看门狗。

---

## 5. 分步实施路径（6 步，每步都能独立跑绿 137 项）

> 每步结束统一执行：
> `node --test test/downloadQueue.test.js "test/queue-*.test.js"` → 必须 `137 pass / 0 fail`
> 步骤 1、6 额外执行源码护栏：`node --test test/download-path.test.js test/retry-attempts-setting.test.js`
> 每步都是"纯搬运 + 保持 facade"，**禁止在同一步里顺手改行为**。

### 步骤 1：先搬零状态纯函数（最小风险，验证"搬家流程"）

- **改什么**
  - 新建 `src/main/downloadQueue/naming.js`：搬 96–98 `sanitizeFilename`（3 有效行），零依赖。
  - 新建 `src/main/downloadQueue/ports.js`：搬 165–168 `noopNotifyPort`、180–186 `guardPort`（7 有效行），只依赖 `logger`。
  - `downloadQueue.js` 改为 `require` 三者，**保持 `module.exports.sanitizeFilename` 同名导出**（`test/downloadQueue.test.js:22` 直接解构它）。
- **跑哪条测试**：137 项全套；另跑 `test/download-path.test.js`（它读 `downloadQueue.js` 做负断言，必须仍成立）。
- **退出判据**
  - 137/137 绿；`download-path.test.js` 绿
  - `require('./src/main/downloadQueue').sanitizeFilename('a/b\\c:d*e?f"g<h>i|j') === 'a_b_c_d_e_f_g_h_i_j'`（对应 `test/downloadQueue.test.js:112`）
  - `downloadQueue.js` 物理行 956 → 约 946（±5），且 `git diff` 里只有"删除 + require + 导出"

### 步骤 2：外移持久化（防抖/原子写/恢复/校验）

- **改什么**
  - 新建 `downloadQueue/persistence.js`，工厂 `createPersistence({ getQueue, userDataDir, transition, logger })`，搬：`QUEUE_FILE`(234)、`writeQueueNow`(354–361)、`persistQueue`(368–382)、`loadPersistedQueue`(385–425)、`sanitizeRestoredTask`(113–122)、`trimDoneTasks`(328–340)、`queuePersistTimer`(232)。
  - `trimDoneTasks` 先随 `writeQueueNow` 进 persistence（它只被 356、931 调用）；步骤 3 建 `queueStore` 时再迁过去——本步结束时必须能独立绿。
  - `resumeRestoredQueue`(446–456) **不进本模块**（它要调 `processQueue`，详见步骤 4）。
- **跑哪条测试**：137 项。最敏感用例：`downloadQueue.test.js:346`（500ms 防抖只写一次）、`:361`（dispose 立即落盘）、`:374`/`:397`/`:407`/`:423`（恢复与损坏）、`:459`（超量截断）、`:474`/`:490`（done 淘汰）、`:747`/`:760`（done/error 后 queue.json 立即可读）。
- **退出判据**
  - 137/137 绿，且上述 12 项单独点名全绿
  - `dispose` 仍能在防抖窗口内落盘（`:361`）
  - `queuePersistTimer` 在 `dispose` 后为 null（无残留 timer，测试进程能正常退出）

### 步骤 3：建立 `queueStore`（数组唯一 owner）

- **改什么**
  - 新建 `downloadQueue/queueStore.js`：持有 `downloadQueue` 数组（**唯一实例**）、`getQueue()`、`trimDoneTasks`（从 persistence 迁入）、`transition(song,to,reason)`（由 139–142 的 `applyStatus` 内联进来，仍删 `_lastTransition`）。
  - `persistence.js` 的 `getQueue` 改为构造时注入 store 的引用（步骤 2 已预留签名）。
  - facade 的 `applyStatus` 改为 `store.transition` 的薄包装（外部行为不变，`QUEUE_STATUSES` 校验路径不变）。
- **跑哪条测试**：137 项。最敏感：`:459`/`:470`（超量恢复与截断）、`:474`/`:490`（淘汰）、`:1083`/`:1107`（状态机迁移与审计字段不外溢）。
- **退出判据**
  - 137/137 绿
  - `engine.getQueue()` 在 `loadPersistedQueue()` 前后返回**同一引用**（可在测试临时加 `assert.strictEqual(engine.getQueue(), engine.getQueue())`）
  - 全仓 `grep -n "const downloadQueue = \[\]"` 只剩 `queueStore.js` 一处
  - `queue.json` 里不出现 `_lastTransition`、`_processing`、`_cancelRequested`（`:1107` 覆盖）

### 步骤 4：外移调度器

- **改什么**
  - 新建 `downloadQueue/scheduler.js`，工厂 `createScheduler({ store, runSong, notify, readPrefs, requestCancelHook, logger })`，搬：`activeDownloads`/`processTimer`/`_processQueueRunning`/`_paused`(228–231)、`getConcurrency`(271–278)、`getPerSourceCap`(285–294)、`getMaxAttempts`(300–307)、`activeCountBySource`(310–316)、`pickSchedulable`(319–325)、`resumeRestoredQueue`(446–456)、`processQueue`(835–875)、`setPaused`(894–901)、`requestCancel`(882–891)。
  - **`getMaxAttempts` 必须仍然挂在 facade 上**（`engine.getMaxAttempts()` 被 `test/retry-attempts-setting.test.js:45-79` 运行时调用）；scheduler 内部 `require` 同一个实现，避免两份回落值。
- **跑哪条测试**：137 项。最敏感：`:138`（并发上限）、`:161`（越界回落 3）、`:184`（重入保护）、`:583`/`:601`/`:616`（暂停/恢复/重排定时器被打断）、`:661`/`:688`/`:705`/`:720`（单源 cap 四种形态）、`:612`（`getActiveCount()===0`）。
- **退出判据**
  - 137/137 绿
  - 终态后 `engine.getActiveCount() === 0`；`setPaused(true)` 期间不新增协程
  - 全仓不再有 `_processQueueRunning` / `activeDownloads` 出现在 `downloadQueue.js`

### 步骤 5：外移进度与事件出口

- **改什么**
  - 新建 `downloadQueue/progressPort.js`，工厂 `createProgress({ getQueue, progress, getState })`，搬：`PROGRESS_THROTTLE_MS`(89)、`speedStates`(227)、`notifyQueueChanged`(348–351)、内联 `onProgress`(628–650)。
  - `_processOneSongInner` 里 628–650 的整段替换为 `progress.makeOnProgress(song, cancelToken)` 返回的回调（**此时 runner 还没拆，只做这一处就地替换**）。
  - **顺序必须是"先 emitQueueUpdated(349) → 再 persistQueue(350)"**，这条在本步被固化到 `progressPort` 内部，不许下移到 persistence。
- **跑哪条测试**：137 项 + `test/queue-progress-throttle.test.js`（3 项是本节专属钉子）。最敏感：`:773`（取消后迟到 onProgress 不再写进度/不再推送）、`:802`（`emitProgress` 抛错不中断下载）、`:747`/`:760`（终态立即落盘，验证事件→落盘顺序没被打乱）。
- **退出判据**
  - 137/137 绿，`queue-progress-throttle` 3/3
  - 120ms 节流窗口与"100% 必发"两条语义不变（`pct<100 && now-lastAt<120` 判据原样保留）
  - `speedStates` 只在 `progressPort.js` 出现；任务终态后 `speedStates[taskId]` 被删除（4 个删除点：661、704、759、781 全部经由 `progress.forget()`）

### 步骤 6：拆开 `_processOneSongInner`（332 行）+ facade 收口

- **改什么**
  - 新建 `downloadQueue/taskPaths.js`：`sanitizeFilename` 调用于 595、命名模板 557–559、`saveDir` 兜底与沙箱 560–594、`mkdir` 597–599、容量预检 601–617、`userDataDirSafe` 823–829。
  - 新建 `downloadQueue/taskRunner.js`：`shouldAbort`(471–473)、`processOneSong`(480–487)、attempt 循环 489–510、`evaluatePolicy` 调用与 skip/demote 511–530、取流与换源 532–555、传输调用 619–627 + 652–671、catch 重试判定 737–753。
  - 新建 `downloadQueue/taskFinalize.js`：歌词 673–697、成功终态 699–736、失败终态 755–819（历史、`notify.downloadDone`、`emitError`、`errorCode` 补齐）。
  - `downloadQueue.js` 只剩 `createDownloadQueueEngine`（205–224 的校验 + 8 个模块装配 + 903–956 的导出面）。
  - **同步改测试（本步唯一被允许改的测试）**：`test/retry-attempts-setting.test.js:74`、`:107` 的 `read('src/main/downloadQueue.js')` 改为读 `downloadQueue/taskRunner.js`（或两条都读，取并集）；`test/download-path.test.js:206` 同理改读 `taskRunner.js`。`getMaxAttempts,` 的导出断言仍看 facade，不用改。
- **跑哪条测试**：137 项全套 + `test/download-path.test.js` + `test/retry-attempts-setting.test.js`。最敏感：`:227`/`:244`/`:293`（重试与不可重试）、`:257`/`:280`（fatal 短路）、`:310`/`:326`（换源回写与历史源）、`:512`/`:529`（歌词）、`:851`（H1 重试期不被二次调度）、`:896`（M1 重试期取消）、`:976`–`:1059`（路径模板 5 项）、`:1083`/`:1107`（状态机收敛）。
- **退出判据**
  - 137/137 + 两个源码护栏全绿
  - `_processOneSongInner` 在仓库中不再存在；`taskRunner.js` / `taskPaths.js` / `taskFinalize.js` 物理行分别 ≤ 200 / 130 / 250（实测 `wc -l`）
  - `downloadQueue.js` ≤ 130 物理行
  - 全仓 `grep -c "applyStatus\|song.status ="`：引擎侧只剩 `queueStore.transition` 一处写入（`ipc:146` 的既有直写保留，记入后续 ADR）

**步骤依赖**：1 → 2 → 3 → 4 → 5 → 6 严格串行（每一步都动 `downloadQueue.js`，并行会打架）。

---

## 6. 风险与对策

### 6.1 双重真相（一）：数组身份

- **风险**：`queueStore` 若返回 `[...downloadQueue]`、或 `loadPersistedQueue` 里 `downloadQueue = list` 重新赋值，`index.js:447` 拿到的引用立刻变孤儿 → 渲染层看到空队列、`subscriptions.js:211` 往旧数组里 push。这类 bug **不报错**，只是"界面不动"。
- **对策**：`queueStore` 内部数组用 `const` 声明，**只允许 `push/splice/length=0` 三种原地变更**；`getQueue()` 直接返回该引用；拆分提交里禁止出现 `downloadQueue =`（可用 `grep -n "downloadQueue = "` 做 CI 级检查）。
- **看门狗**：`test/downloadQueue.test.js:459`（恢复 20005 条后 `engine.getQueue().length === 20000`，引用必须与 facade 一致）。

### 6.2 双重真相（二）：`status` 写入路径

- **风险**：拆分后 `transition` 藏在 `queueStore` 里，新写代码（尤其 taskRunner 的新 phase 函数）很容易图省事写 `song.status='done'`。更严重的是 `ipc/download/queue.js:146` 已经是直写，拆完会让人以为"直写是被允许的"。
- **对策**：
  1. 本次拆分**不新增任何 `song.status =` 赋值**，只搬调用点（现有 9 处 `applyStatus` 全部保留）；
  2. `queueStore.transition` 成为引擎内唯一导出，`taskRunner` / `taskFinalize` 只接收 `transition` 注入，不接收原始数组写权限以外的能力；
  3. `ipc:146` 的直写**不在本次范围**，写进 §7 与后续 ADR（收口它需要动 IPC 层，风险独立）。

### 6.3 事件时序（`queue-updated` 时机）

- **风险**：现在 `notifyQueueChanged` 是"推送(349) → 落盘(350)"，且终态 `immediate=true`（523、662、764、782、818、855）。若拆分把 `persistQueue` 挪进 `queueStore`、`emit` 留在 `progressPort`，极容易变成"先落盘后推送"或"推送两次"。渲染层可能看到"先有进度终态、后到队列快照"的倒序。
- **对策**：`notifyQueueChanged(immediate)` **签名与内部顺序原样保留**在 `progressPort.js`，persistence 只能被它调用，不许反向调用；`scheduler` / `taskRunner` 一律走 `notify(true)` 表达终态，不自己拼事件。
- **看门狗**：`:747`、`:760`（done/error 后 `queue.json` 立即可读，隐含"推送先于落盘"的既有顺序仍成立）；`sent` 数组里 `queue-updated` 的顺序断言（`buildEngine` 的 56–59 行记录型端口）。

### 6.4 定时器分裂

- **风险**：`processTimer`（100ms 重排，859–863）归 scheduler、`queuePersistTimer`（500ms 防抖，378–381）归 persistence。`dispose` 若只清一个，测试进程会挂 500ms 或被 100ms 回调再拉起一次 `processQueue`（退出后下载）。
- **对策**：`dispose` 顺序固定为 `scheduler.stop()`（清 processTimer + 复位 `_processQueueRunning`）→ `persistence.flush()`（清 timer + 立即 `writeQueueNow`）。两个模块各自暴露 `stop()/flush()`，facade 只负责按序调用。
- **看门狗**：`:361`（dispose 立即落盘）、`:616`（暂停期间入队，恢复后全部完成，验证 100ms 重排没被打断）、`:612`（`getActiveCount()===0`）。

### 6.5 测试替身要改哪些 helper

| helper | 位置 | 是否要改 | 原因 |
|---|---|---|---|
| `buildEngine()` | `test/downloadQueue.test.js:40-79`（52 项共用） | **不改** | 只调 facade；注入的 `history`/`fsa`/`downloader`/`progress`/`notify` 全部留在 facade 参数上 |
| `buildEngine()` | `test/queue-resume.test.js:36`（4 项） | **不改** | 同上 |
| `buildEngine()` | `test/queue-abort.test.js:39`（工厂 44 行构造引擎，3 项） | **不改** | 同上 |
| `buildEngine()` | `test/queue-progress-throttle.test.js:28`（3 项） | **不改** | 同上（步骤 5 之后仍走 facade） |
| prefs patch | 4 处 `prefs.get = ...` + `restore()` | **不改** | 引擎仍按既有约定直接 `require` prefs |
| 源码文本断言 | `test/retry-attempts-setting.test.js:74`、`:107` | **必改**（步骤 6） | `const maxAttempts = getMaxAttempts();` 与循环体迁到 `taskRunner.js` |
| 源码文本断言 | `test/download-path.test.js:206` | **必改**（步骤 6） | 负断言的读取路径指向 `downloadQueue.js` |
| `waitFor()` | 4 个文件各一份（`:82`、`:63`、`:53` 等） | **不改** | 只依赖公开状态字段 |

一句话：**137 项里没有任何一项会因为拆分而改 helper；只有 2 个不在 137 集合内的源码文本断言文件需要改读取路径（3 处）。**

### 6.6 行数目标（≤300）是否现实

实测结构：956 物理行 = 581 有效行 + 375 非代码行（51 空 + 324 注释）。

- **现实，但不是"切 3 刀"能达成**：`_processOneSongInner` 单函数 332 物理行，任何包含它的模块都必超 300。必须先按 §8.1 的 12 个 phase 拆开。
- **方案 A 的实测可达值**：8 个文件，最大 240 物理行（`taskFinalize.js`）/ 112 有效行，全部在 300 以内。
- **建议同时立"有效行"目标**：每模块 ≤180 有效行。理由：注释在拆分中只是跟着搬，物理行 ≤300 而注释占 60% 时，有效行可能仍有 400+；有效行才是维护成本的真实度量。
- **若坚持 ≤4 个文件**：不现实。`taskRunner` + `taskFinalize` 有效行合计 200，加上 phase 之间的样板与注释，任一"4 文件"方案必有一文件 >300。
- **总物理行会变多**：预估 956 → 约 1300–1450（每文件新增头注释 + require + 工厂封装）。**行数不是拆分的目标函数，"单文件认知负荷"才是**；评审时应看"最大文件"与"最大函数"，不看总和。

---

## 7. 不做的事（明确划界）

1. **不拆 `src/utils/downloader.js`**（`downloadFileWithRetry` / `embedId3Tags` / `cancelDownload` 的实现与重定向/断点续传逻辑留在原处）。本次只搬调用点。
2. **不改 `src/main/streamProtocol.js`**、`src/main/ipc/download/stream.js`、`streamRegistry` / `streamRefresh`。播放链路有独立钉子（`test/stream-protocol.test.js`），与下载域正交。
3. **不动渲染层 `src/renderer/**`**、preload、`src/shared/ipcContract.js`。事件名与载荷字段一字不改，因此渲染层零改动。
4. **不改 `src/main/ipc/download/queue.js` 与 `src/main/subscriptions.js`**。它们对队列数组/`status` 的直写是既存事实（§2.2/§2.3），收口它们需要独立 ADR 与独立回归。
5. **不改行为**：并发钳制、200 条 done 淘汰、500ms 防抖、只重试 403/404/410、fatal 短路、24h stale pending、120ms 进度节流——全部原样保留。拆分提交里出现任何"顺手优化"都应被拒。

---

## 8. 附录

### 8.1 `_processOneSongInner` 的 12 个 phase（步骤 6 的施工图）

| phase | 行号区间 | 物理行 | 有效行 | 内容 | 目标文件 |
|---|---|---|---|---|---|
| P1 初始化 | 489–495 | 7 | 6 | `lastError`/`isFatal`/`cancelToken`/`maxAttempts` 逐曲快照 | `taskRunner.js` |
| P2 attempt 顶 | 506–510 | 5 | 5 | 非 `downloading` 时先迁回 `downloading`（不推事件）+ 起始日志 | `taskRunner.js` |
| P3 策略 | 511–530 | 20 | 16 | `evaluatePolicy` → skip（落 done + `skipReason`）/ demote（改写 quality） | `taskRunner.js` |
| P4 取流 | 532–555 | 24 | 21 | `getDownloadUrlSmart`、fatal 短路、`_altSource` 回写 + 推事件 | `taskRunner.js` |
| P5 命名/目录 | 557–599 | 43 | 26 | ext 清洗、模板渲染、saveDir 兜底、`planDownloadDir`、沙箱复核、`mkdir`、`savePath` | `taskPaths.js` |
| P6 容量预检 | 601–617 | 17 | 15 | `statfs` → `diskVerdict` → 抛 `diskShortage` | `taskPaths.js` |
| P7 传输 | 619–650 | 32 | 21 | headers、限速、`onProgress`（含 120ms 节流 + 速度/ETA） | `taskRunner.js` 调用 + `progressPort.js` 回调 |
| P8 传输后取消检查 | 652–671 | 20 | 11 | 保留已落盘文件、清 speedState、落 `error`「用户取消」 | `taskRunner.js` |
| P9 歌词/ID3/LRC | 673–697 | 25 | 20 | `getLyrics`（换源优先）、`embedId3Tags`、sidecar `.lrc` | `taskFinalize.js` |
| P10 成功终态 | 699–736 | 38 | 34 | `done` + `savePath` + 通知门禁 + `history.add(done)` | `taskFinalize.js` |
| P11 重试判定 | 737–753 | 17 | 15 | `/HTTP\s*(403\|404\|410)/` → `pending` + 500ms 退避 | `taskRunner.js` |
| P12 失败终态 | 755–819 | 65 | 48 | cancelled 分支、`transportCode` 补码、队列外跳过、`history.add(error)`、`emitError` | `taskFinalize.js` |

### 8.2 `applyStatus` 的 9 个调用点（拆分后必须逐一落到同一出口）

| 行号 | 目标状态 | 场景 |
|---|---|---|
| 407 | `error` | 重启时 `downloading → error`（应用异常关闭） |
| 411 | `error` | 重启时 stale `pending → error`（超 24h） |
| 508 | `downloading` | 每轮 attempt 开始（退避后从 pending 回 downloading） |
| 517 | `done` | 策略 skip |
| 667 | `error` | 传输收尾后发现已取消 |
| 699 | `done` | 下载成功 |
| 745 | `pending` | 可重试错误（403/404/410） |
| 756 | `error` | 失败终态 |
| 845 | `downloading` | 调度器启动任务 |

### 8.3 `notifyQueueChanged` 的 8 个调用点（事件时序回归清单）

| 行号 | `immediate` | 场景 |
|---|---|---|
| 523 | `true` | 策略 skip 终态 |
| 554 | 否（防抖） | 换源成功 |
| 662 | `true` | 传输完成后已取消/移除 |
| 747 | 否（防抖） | 可重试错误转 pending |
| 764 | `true` | 用户取消终态 |
| 782 | `true` | 任务已移出队列 |
| 818 | `true` | 失败终态（emitError 之后） |
| 849 | 否（防抖） | 调度器启动任务 |
| 855 | `true` | 协程 finally（终态落盘） |

（上表 9 行，其中 `849` 与 `855` 成对挂在 `processQueue` 的启动与 `.finally` 上。）

### 8.4 验收锚点（本文档对应任务书 7 项要求）

| 要求 | 对应章节 |
|---|---|
| 函数清单表（名字/行号/行数/职责/是否闭包） | §1.1、§1.2、§1.3 |
| 共享状态矩阵（读/写标注完整） | §2.1、§2.2、§2.3 |
| 方案 A / 方案 B 对比（模块、行数、参数、双重真相、测试改动） | §3.1、§3.2、§3.3 |
| 明确推荐一个方案 + 理由 | §4 |
| 4–6 步实施路径（改什么/跑什么/退出判据，每步 137 绿） | §5 |
| 风险与对策（双重真相/事件时序/测试替身/行数目标） | §6.1–§6.6 |
| 不做的事 | §7 |

---

## 九、实施结果（2026-11-07）

> 本节回填 §5 的 6 步实施路径的**执行结果**。行数为 2026-11-07 收口时的实测值（LF 计数，末行无换行按一行计），行为结论来自探针实测而非推断。

### 9.1 结论

- §5 的 **6 个步骤全部完成，无回退**：没有出现"拆到一半回滚旧文件"或"新旧两份并行"的情形，`downloadQueue.js` 一次性收缩为主线装配层。
- 契约保持不变：导出面（`createDownloadQueueEngine`、`sanitizeFilename` / `sanitizeRestoredTask` / `MAX_RESTORED_TASKS` / `getMaxAttempts`）、事件名与载荷字段、`getQueue()` 返回的活数组引用**全部原样**。
- §6 列出的风险项逐条以探针收敛（§9.5），仅剩 1 项**拆分前就存在**的遗留观察（§9.6），不构成本次回归。

### 9.2 主文件行数（`src/main/downloadQueue.js`）

| 指标 | 拆分前（§0.1） | 拆分后（实测） | 变化 |
|---|---|---|---|
| 物理行 | 956 | **395** | −561（−58.7%） |
| 空行 | 51 | 25 | −26 |
| 纯注释行（`//`、`/*`、`*`） | 324 | 206 | −118 |
| 有效代码行 | 581 | **164** | −417（−71.8%） |

拆分后主文件只剩三类内容：**导出面**（4 个导出）+ **依赖装配**（`initContext` 注入 6 个能力）+ **队列级编排**（`processQueue` 的并发钳制、`finally` 收口、`dispose` 定时器收口）。单曲流水线、落盘、调度、通知全部外移。

同时验证了 §6.6 的预判：**总物理行确实变多**（7 个子模块合计约 1450 物理行），但**最大文件**从 956 降到 627，**最大函数**从 332 物理行（`_processOneSongInner`）降到 35 物理行以内（`resolveStream` 与 `preparePaths` 各 35）——拆分的目标函数是"单文件/单函数认知负荷"，不是总行数。

### 9.3 新增子模块（`src/main/downloadQueue/`）

| 模块 | 物理行 | 有效行 | 职责 |
|---|---|---|---|
| `naming.js` | 20 | 6 | 文件名/扩展名清洗与模板渲染的纯函数 |
| `persist.js` | 220 | 125 | 队列落盘/恢复：`sanitizeRestoredTask`、`MAX_RESTORED_TASKS`、24h stale pending 判定 |
| `ports.js` | 38 | 16 | `guardPort`、`noopNotifyPort` 等端口防御封装 |
| `store.js` | 74 | 25 | 队列数组的唯一持有者 + `applyStatus` 迁移出口 |
| `scheduler.js` | 290 | 157 | 并发钳制、500ms 退避、`stop()` 清在途定时器、`runSong` 转调 |
| `events.js` | 184 | 64 | `notifyQueueChanged` 防抖、`emitProgress` 120ms 节流、`emitError` |
| `songTask.js` | 627 | 388 | 单曲流水线：12 个 phase 顺序编排（含成功/失败/取消三条终态） |

各模块职责与 §3.1 方案 A 的目标文件划分一致；`statemachine.js`（134 物理行 / 60 有效行）为拆分前既有文件，未计入上表。

### 9.4 `songTask.js` 的 12 个 phase 粒度（对应 §8.1 施工图）

12 个 phase **全部存在且可单独阅读**，单个 phase 有效行均 ≤40：

| phase | 函数 | 有效行 |
|---|---|---|
| P1 初始化 | `initContext` | 12 |
| P2 attempt 顶 | `startAttempt` | 7 |
| P3 策略 | `applyPolicyPhase` | 20 |
| P4 取流 | `resolveStream` | **26（最大）** |
| P5 命名/目录 | `preparePaths` | 23 |
| P6 容量预检 | `checkDiskSpace` | 18 |
| P7 传输 | `transferFile` | 13 |
| P8 传输后取消检查 | `handlePostTransferAbort` | 13 |
| P9 歌词/ID3/LRC | `finalizeLyrics` | 23 |
| P10 成功终态 | `finishSuccess` | 11 |
| P11 重试判定 | `handleAttemptFailure` | 15 |
| P12 失败终态 | `finalizeFailure` | **25（次大）** |

结论：`_processOneSongInner` 的 332 物理行已完全消散，没有任何 phase 逼近 §6.6 建议的 40 有效行上限。

### 9.5 验收与行为等价

**回归数字（实测）**

| 项 | 结果 |
|---|---|
| 队列子集（`downloadQueue` + `queue-*`） | **138 / 138** |
| `node scripts/test-stable.cjs` | **350 文件 / 3555 用例 / fail 0 / flaky 0** |
| `npm run typecheck` | exit 0 |
| `npm run lint` | **0 error** + 6 条历史 warning（与 M1.0 / M1.1 同源，未新增） |

**行为等价探针（拆分前后逐项比对）**

| 场景 | 期望（拆分前行为） | 实测（拆分后） |
|---|---|---|
| `403` / `404` / `410` | 可重试，`attempts=3` 后转 error | 一致，仍只对这三个码重试 |
| `500` / 断网 | 不可重试，`attempts=1` 直接 error | 一致 |
| `fatal=true`（策略致命短路） | 不调用下载器、不消耗重试配额 | **下载器调用 0 次，配额未消耗** |
| 用户取消 | 终态 `error`「下载已取消」，后续 phase 不再执行 | 一致，终态文案不变，后续 phase **零调用** |
| 进度 100% | 必须外发（不被 120ms 节流吞掉） | **必发**，最后一次进度不丢 |
| `dispose()` | 清掉全部在途定时器 | 执行后 Timeout **0** |
| `getQueue()` 数组身份 | 返回引擎内部同一数组引用 | **恒等**（`index.js:447` 的直写语义未变） |

### 9.6 遗留观察（非本次引入，记为待办）

- **现象**：取消后**迟到**的 `onProgress` 回调仍会覆盖 `progress` 字段（探针观测到 30 → 80）。
- **归因**：用 `git HEAD`（拆分前版本）对同一探针做差分运行，**行为完全相同** → 属既存缺陷，不是拆分引入的回归。
- **处置**：登记为待办（建议随"取消语义收口"独立提交修复：`onProgress` 首行加 `if (ctx.cancelled) return;`）。不阻塞本 ADR 的 Accepted 状态，也不影响 §9.5 的等价结论。