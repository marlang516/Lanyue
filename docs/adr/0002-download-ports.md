# ADR-0002：下载域 Port 契约（UI 推送与全局单例剥离）

| 项目 | 内容 |
|---|---|
| 编号 | 0002 |
| 标题 | 为下载引擎定义 5 个 Port，剥离 UI 推送（M1.1-B）与 context 全局单例（M1.1-C） |
| 状态 | **Accepted（已实施）** |
| 决策日期 | 2026-11-07 |
| 决策者 | 架构组 |
| 相关文档 | [`docs/adr/0001-production-upgrade.md`](0001-production-upgrade.md)、[`docs/process/M1-BASELINE.md`](../process/M1-BASELINE.md) |
| 影响范围 | `src/main/downloadQueue.js`、`src/main/index.js`、`src/main/ipc/download/queue.js`、`src/main/context.js`、`test/queue-*.test.js`、`test/downloadQueue.test.js`（**不含**渲染层、preload、`ipcContract`） |

> 本 ADR 只定义契约与改造顺序，**不改任何源码**。实施者按第五节顺序执行，按附录 A 逐行替换。

---

## 〇、证据口径（必读）

本 ADR 的所有行号来自**实测**，快照如下（2026-11-07 19:50 前后，工作区 HEAD）：

| 文件 | 行数 | git blob（`git hash-object`） | 备注 |
|---|---|---|---|
| `src/main/downloadQueue.js` | ≈892（`Measure-Object -Line` 计非空 720） | `459f82c239b2b9668359579d896238c92dda65bd`（43126 B，19:50:52） | 正被 M1.1-A 改造（已接入 `statemachine`，见 L139-142），**行号仍可能漂移** |
| `src/main/ipc/download/queue.js` | 271 | `20fc23c69d670ba1b1e64feb1f1fdeaf16d3e6cc` | 稳定（2026-10-31） |
| `src/main/context.js` | 59 | `43c41939c60c6e79928b2d6f5573a3bc900830ec` | 稳定 |
| `src/main/index.js` | — | `71b764c9ebcae773bc9e85c054f478a6206bf6d1` | 装配段 L385-416 / L548-560 |

**与 `M1-BASELINE.md` 的口径差异（以本文实测为准）：**

| 项 | 基线记载 | 本次实测 | 差异原因 |
|---|---|---|---|
| `downloadQueue.js` 行数 | 742 | **≈892**（非空 720） | 此前重构 + M1.1-A 接入状态机后增长 |
| `downloadQueue.js` 的 `safeSend` | 9 处 | **3 处调用点** | 9 是 `notifyQueueChanged()` 的调用点数（其中唯一的 `safeSend('queue-updated')` 出口在它内部，见 2.1） |
| `ipc/download/queue.js` 的 `getCtx()` | 10 处 | **9 处** | 基线多计 1（含注释或已合并的重复行）；本文以 `Select-String` 可机械复核的 9 处为准，见 2.4 |
| `context.js` 行数 | 57 | 59 | 微调 |

**行号漂移防护（必读）**：`downloadQueue.js` 正被 M1.1-A 并行修改，本文行号只对应上表 blob。实施前先执行：

```powershell
git hash-object -- src/main/downloadQueue.js   # 若不是 459f82c...，说明文件已变
```

若 hash 不同：**整篇行号作废**，改以「附录 A 的代码片段」定位，并运行「附录 D 重新锚定脚本」打印当前真实行号。下面是三个与行号无关的不变量，任何时刻都应成立：

```powershell
Select-String -Path src\main\downloadQueue.js -Pattern "safeSend\("            # 应恰为 3 处
Select-String -Path src\main\downloadQueue.js -Pattern "safeSend\('queue-updated'" # 应恰为 1 处
Select-String -Path src\main\ipc\download\queue.js -Pattern "getCtx\(\)"       # 应恰为 9 处（改造后 0）
```

---

## 一、背景与目标

### 1.1 今天引擎长什么样

`downloadQueue.js` 自称「依赖注入、可单测」，但实际上仍有三类硬耦合：

1. **UI 推送是构造参数 `safeSend`**（L164）。它不是一个抽象能力，而是 `context.safeSend` 的直传（`index.js:390`），而 `context.safeSend` 在发 `queue-updated` / `download-progress` 时**顺带**触发 `taskbarProgress.refresh()`（`context.js:21-23`）。于是「发一条 IPC」与「刷新任务栏」被焊死在一个函数里，引擎每推一条进度就隐式驱动一次 UI 的全队列 O(n) 扫描。
2. **桌面通知是构造参数 `notifier`**（L170），实现体在 `index.js:402-415` 里直接 `new Notification(...)` 并闭包 `shell.showItemInFolder`。引擎因此认识了一个「有 Electron 语义的对象」。
3. **ipc 层直接读全局单例**：`ipc/download/queue.js` 每个 handler 里现取 `context.getCtx()`（9 处）拿 `persistQueue/processQueue/...`，再直接 `safeSend('queue-updated', ...)`（8 处）。队列域**没有**属于自己的一等依赖入口，`register()` 无参（`queue.js:18`）。

### 1.2 不剥离会怎样（具体代价，不是口号）

| 不剥离的后果 | 具体表现 |
|---|---|
| 单测必须伪造 Electron 语义 | `buildEngine()` 只能塞 `safeSend: (ch, p) => events.push(...)`（`test/queue-progress-throttle.test.js:37`），测的是「函数被调用」而不是「端口被履行」；任何把 `safeSend` 改成 `emitX()` 的重构都会连带改十几处测试 helper |
| 无法替换投递通道 | 未来 MCP/CLI/worker/多窗口广播都只能复用「主窗口 webContents」，因为引擎只认一个 `safeSend(channel, payload)` |
| UI 副作用不可见 | `taskbarProgress.refresh` 藏在 `context.safeSend:21-23`，读 `downloadQueue.js` 的人**看不到**自己的进度推送还触发了 UI 扫描；`onQueueChanged`（托盘，L304-310）又是第二个隐藏副作用 |
| 模块依赖方向错 | ipc 层依赖 `context` 模块级单例 → `context.getCtx()` 未初始化就抛（`context.js:44-47`），handler 只能在函数体内 `require` 延迟求值，模块顶部无法静态检查依赖 |
| 拆卸成本单调上升 | 每新增一个下载相关 IPC（现在 8 个通道），就多一处 `getCtx()` + 多一处裸 `safeSend`，M1.1-C 的替换面随功能增长 |

### 1.3 目标（可验收，不是方向性描述）

- **引擎只依赖 5 个 Port**：`ProgressPort`、`NotifyPort`、`QueuePersistPort`、`DownloaderPort`、`ClockPort`（可选）。`downloadQueue.js` 内 `safeSend` = 0、`notifier.` = 0、`require('electron')` = 0。
- **ipc 队列域零全局单例**：`ipc/download/queue.js` 内 `getCtx()` = 0、`safeSend` = 0、`getDownloadQueue()` = 0，全部改为 `register(options)` 显式传入。
- **Electron 能力只存在于装配层**：`BrowserWindow/webContents.send`、`Notification`、`shell`、`app.getPath`、`tray` 的实现代码只允许出现在 `main/index.js` 及其专用适配器模块中。
- **行为零变化**：事件名、载荷字段、节流窗口、终态立即落盘时序、`test/queue-*.test.js` 语义全部不变。

---

## 二、现状清单（全部实测）

### 2.1 `downloadQueue.js` 的 `safeSend`：3 处调用点

| 行号 | 事件名 | 所在函数 | 触发时机 | 载荷 |
|---|---|---|---|---|
| **302** | `queue-updated` | `notifyQueueChanged(immediate)`（L301-311） | 队列**任何**变更的唯一出口：入队/状态迁移/选中源变化/终态/调度启动 | `downloadQueue`（**活引用**，数组本身） |
| **607** | `download-progress` | `_processOneSongInner` 内 `downloadFileWithRetry` 的进度回调（L588-607） | 传输层每 chunk；`progress < 100` 时按 `PROGRESS_THROTTLE_MS = 120`（L89）合并；**100% 必发**；`_cancelRequested` 后不再发 | `{ id, progress, receivedBytes?, totalBytes?, speedBps?, etaSec? }`（`id = song.taskId`） |
| **770** | `download-error` | `_processOneSongInner` 失败终态分支 | 重试耗尽/不可重试失败；**不含**用户取消（`lastError.cancelled` 分支只 `notifyQueueChanged(true)`，见 L724，不发 toast） | `{ id, title, artist, error, fatal }`（`id = song.taskId \|\| song.id`） |

> **「9 处」的来历**：`notifyQueueChanged()` 有 **9 处调用点**（`Select-String -Path src\main\downloadQueue.js -Pattern "notifyQueueChanged\("` 计数应为 10，含 L301 的定义），按代码顺序依次是：**L483**（质量策略跳过）、**L514**（换源成功）、**L620**（传输完成但已取消/移除）、**L707**（403 重试退避）、**L724**（用户取消终态）、**L742**（已被移出队列，跳过失败历史与 toast）、**L778**（error 终态落盘）、**L809**（调度启动一首）、**L815**（协程 `finally` 终态）。这 9 处最终都落到 L302 的唯一 `safeSend('queue-updated')`。

### 2.2 `onQueueChanged` 与 `notifier.notifyDownloadDone`

| 项 | 行号 | 用途 | 现实现 |
|---|---|---|---|
| `onQueueChanged` 调用 | **L304-310**（定义在 `notifyQueueChanged` 内，紧跟 `safeSend`+`persistQueue`） | 队列变更后的「额外 UI 回调」；`try/catch` 包裹，失败只 `logger.warn`，不影响队列 | `index.js:398-401` → `trayMod.updateTrayMenu()`（托盘菜单里的下载数量/进度） |
| `notifier.notifyDownloadDone` 调用 | **L667-668** | 单曲 `status='done'` 之后弹桌面通知；前置门禁 `prefs.get('notifications') !== false`（L665 一带）；`try/catch` 包裹（L666-670 一带），失败只 warn | `index.js:402-415`：`new Notification({title:'下载完成', body:...})`；`n.on('click')` → `shell.showItemInFolder(savePath)`（L411）；`n.show()` |

### 2.3 持久化事实（`QueuePersistPort` 的现状：**目前没有接缝**）

| 项 | 行号 | 说明 |
|---|---|---|
| `QUEUE_FILE` | **L192** | `path.join(userDataDir(), 'queue.json')`；引擎自己拼路径 |
| `writeQueueNow()` | **L313-321** | `trimDoneTasks()`（保留上限策略）+ `atomicWriteJson(...)`；异常吞掉只 warn |
| `persistQueue(opts)` | **L328-342** | 500ms 防抖（`PERSIST_DEBOUNCE_MS`，L60）；`{immediate:true}` 清定时器后立即整写 |
| `loadPersistedQueue()` | **L345-…** | `safeReadJson` → `res.ok/empty` 判据 → `sanitizeRestoredTask` 逐条清洗 → `downloading→error`、`pending>24h→error` |
| `dispose()` | **L886-894 一带**（`atomicWriteJson` 在 L892） | 退出时把待写队列**同步**落盘并清定时器 |

> 结论：持久化是**引擎内部的 IO**，不是注入项。把它做成 Port，收益是「格式/存储位置可换、引擎可无盘单测」，代价是必须严格保留**同步落盘**语义（见 6.3）。

### 2.4 `ipc/download/queue.js` 的 `context.getCtx()`：9 处

文件顶部 `const { getDownloadQueue, safeSend } = require('../../context');`（**L13**）；每个 handler 内**再** `require('../../context').getCtx()`（延迟求值，规避 `context.js:44-47` 的未初始化抛错）。

| 行号 | 取用的 getter | handler（IPC 通道） | 用途 |
|---|---|---|---|
| **54** | `persistQueue`, `processQueue` | `add-to-queue` | 入队后落盘 + 推调度 |
| **89** | `persistQueue`, `requestCancelDownload` | `cancel-download` | 在途取消入口 + 落盘 |
| **109** | `persistQueue`, `processQueue` | `retry-download` | 重排到队首后落盘 + 调度 |
| **136** | `persistQueue`, `requestCancelDownload` | `remove-queue-item` | 先取消在途（`cancelInFlight`，L33-49）再摘除 + 落盘 |
| **149** | `persistQueue` | `reorder-queue-item` | 排序变更后落盘 |
| **160** | `setQueuePaused`, `queueIsPaused` | `set-queue-paused` | 切换暂停并回读当前值 |
| **169** | `persistQueue` | `clear-finished-queue` | 清空 done 后落盘 |
| **182** | `persistQueue`, `requestCancelDownload` | `clear-all-queue` | 逐条取消在途 + 清空 + 落盘 |
| **201** | `persistQueue`, `processQueue` | `add-playlist-to-queue` | 批量入队后落盘 + 调度 |

**getter 使用频次**：`persistQueue` 8 次、`processQueue` 3 次、`requestCancelDownload` 3 次、`setQueuePaused` 1 次、`queueIsPaused` 1 次。

**同模块中同源的第二/第三类隐式单例（M1.1-C 一并清掉，否则只算半途）：**

| 类别 | 行号 | 说明 |
|---|---|---|
| `getDownloadQueue()` | **L53、88、108、135、148、168、181、200**（8 处） | 拿引擎内部数组的活引用；与 `engine.getQueue()` 同一个对象 |
| `safeSend('queue-updated', downloadQueue)` | **L78、101、122、141、152、174、188、254**（8 处） | 队列域裸推渲染层，绕过引擎的统一出口 |
| `makeTaskId()` 的 `Date.now()` | **L268** | 任务 id 生成（与引擎的 `ClockPort` 无关，属于 ipc 侧） |

> 全仓 `getCtx()` 实测分布（改造前基线，供 C 阶段对比）：`ipc/download/queue.js` 9 + `ipc/library/scan.js:29` 1 + `subscriptions.js:197` 1 = **11 处**。

### 2.5 `createDownloadQueueEngine` 的 12 项注入清单（L162-175）

| # | 名称 | 类型 | 必填 | 现实现位置 | 引擎内使用点 |
|---|---|---|---|---|---|
| 1 | `userDataDir` | `() => string` | 是（L176 抛） | `index.js:386` → `app.getPath('userData')` | L192 拼队列文件路径；`userDataDirSafe()` |
| 2 | `safeSend` | `(channel, payload) => void` | 是（L177 抛） | `index.js:390` → `context.safeSend` | L302 / L607 / L770 |
| 3 | `getDownloadUrlSmart` | `(song, quality) => Promise<UrlInfo>` | 是（L178 抛） | `index.js:391` ← `src/api` | L492 取流（含换源） |
| 4 | `getLyrics` | `(id, source, title, artist) => Promise<{lrc}>` | 是（L179 抛） | `index.js:392` ← `src/api` | L636 拉歌词 |
| 5 | `onQueueChanged` | `() => void \| Promise<void>` | 否 | `index.js:398-401` → `trayMod.updateTrayMenu()` | L304-310 |
| 6 | `isSaveDirAllowed` | `(dir) => boolean` | 否 | `index.js:394` → `approvedDirs.isApprovedDir` | L525 校根目录、L549 校模板渲染后的子目录 |
| 7 | `getDefaultDownloadDir` | `() => string` | 否 | `index.js:389` → `defaultDownloadDir(app.getPath('music'))` | 未设 `saveDir` 时的落点 |
| 8 | `notifier` | `{ notifyDownloadDone(song, savePath) }` | 否 | `index.js:402-415` | L667-668 |
| 9 | `history` | 模块 | 否（默认 `utils/history`） | **index.js 未注入**（走默认） | L691 写 done 历史、L764 写 error 历史 |
| 10 | `fsa` | 模块 | 否（默认 `utils/fsAsync`） | **index.js 未注入**（走默认） | `statOrNull` 取文件大小 |
| 11 | `downloader` | 模块 | 否（默认 `utils/downloader`） | **index.js 未注入**（走默认） | L588 `downloadFileWithRetry`、L641 `embedId3Tags`、L847 `cancelDownload` |
| 12 | `getPolicyFacts` | `(song) => Promise<PolicyFacts>` | 否 | `index.js:397` → `qualityPolicyFacts.getPolicyFactsForQueue` | L217-219 质量策略事实源 |

> **隐性债务**：第 9/10/11 项名义上「可注入」，但 `index.js` 装配段（L385-416）里根本没有它们——实际是 `require` 单例。它们含磁盘 IO（history / fsAsync）与 HTTP（downloader），是后续 `HistoryPort`/`FilePort`/`TransferPort` 的候选，**但不在本 ADR 范围**（见第七节）。

### 2.6 `context.js`（59 行）结构

| 行号 | 内容 | 与下载域的关系 |
|---|---|---|
| L8-10 | 模块级 `_ctx`、`_getMainWindow`、`_getDownloadQueue` | 全局单例本体 |
| **L14-27** | `safeSend(channel, payload)`：`_ctx` 未初始化直接 return；`isDestroyed()` 双重检查；整体 try/catch 吞掉；**L21-23 在 `queue-updated`/`download-progress` 时调 `taskbarProgress.refresh(_getDownloadQueue)`** | 引擎的 UI 推送 + 任务栏副作用的真实实现 |
| L29-42 | `init(opts)`：收 `app`、`persistQueue`、`processQueue`、`requestCancelDownload`、`setQueuePaused`、`queueIsPaused`、`setLibraryWatchDir` 共 7 个字段 | 其中 **5 个字段只服务下载域** |
| L44-47 | `getCtx()`：未初始化即 `throw` | 迫使 handler 延迟 `require` |
| L52 / L57 | `getMainWindow()` / `getDownloadQueue()` | 后者只服务下载域 |

装配点：`index.js:548-560` 的 `initContext({...})`，其中 `persistQueue/processQueue/requestCancelDownload/setQueuePaused/queueIsPaused` **五项**全部是引擎方法的转手闭包，M1.1-C 后应从 context 中消失；`getDownloadQueue` 与 `setLibraryWatchDir` 属跨域（任务栏刷新 / 订阅自动下载 / 曲库监听），本次**保留**（见 5.2 C7 与验收断言）。

---

## 三、Port 接口定义

> 仓库是纯 JS（`tsconfig.json` 仅做 `checkJs` 渐进），下面的 TS 只作**契约文档**。落地时以 JSDoc `@typedef` 抄进 `src/main/downloadPorts.js` 或 `downloadQueue.js` 头部，供 `tsc --noEmit` 校验。

```ts
// ───────────────────────── 公共数据形状（与现有 IPC 载荷逐字段对齐）─────────
export interface QueueRow {
  id: string | number;
  taskId?: string;
  source?: string;
  title?: string;
  artist?: string;
  album?: string;
  quality?: 'lossless' | 'hq' | 'standard';
  status: 'pending' | 'downloading' | 'done' | 'error';
  progress?: number;
  error?: string | null;
  errorCode?: string | null;
  saveDir?: string | null;
  savePath?: string;
  addedAt?: number;
  skipReason?: string;
  skipRule?: string | null;
  _processing?: boolean;      // 瞬态：调度中
  _cancelRequested?: boolean; // 瞬态：已请求取消
}

export interface ProgressPayload {
  /** 必须等于调用方传入的 taskId（见下文「id 二义性」） */
  id: string;
  progress: number;
  receivedBytes?: number;
  totalBytes?: number | null;
  speedBps?: number;
  etaSec?: number;
}

export interface DownloadErrorPayload {
  id: string;
  title?: string;
  artist?: string;
  error: string;
  /** true = 取流侧致命（VIP/登录/无流），渲染层弹「不可重试」话术 */
  fatal: boolean;
}

// ───────────────────────── 1) 进度/队列事件 ─────────────────────────
export interface ProgressPort {
  emitQueueUpdated(rows?: readonly QueueRow[]): void;
  emitProgress(taskId: string, payload: ProgressPayload): void;
  emitError(taskId: string, payload: DownloadErrorPayload): void;
}

// ───────────────────────── 2) 桌面通知 ─────────────────────────
export interface NotifyPort {
  downloadDone(song: QueueRow, savePath: string): void;
  showInFolder(path: string): void;
}

// ───────────────────────── 3) 队列持久化 ─────────────────────────
export interface QueuePersistPort {
  load(): Promise<readonly unknown[] | null>;
  save(rows: readonly QueueRow[]): void;
}

// ───────────────────────── 4) 取流/歌词/沙箱/策略事实 ─────────────────────────
export interface UrlInfo {
  url?: string;
  ext?: string;
  referer?: string;
  /** 致命：VIP/登录/无流 —— 引擎直接短路，不消耗重试（当前 `urlInfo.fatal` 分支语义） */
  fatal?: boolean;
  code?: string;
  error?: string;
  matchedSong?: { id: string | number; source: string };
  matchedFrom?: string;
}

export interface PolicyFacts {
  artists?: string[];
  albums?: string[];
  [k: string]: unknown;
}

export interface DownloaderPort {
  fetchUrl(song: QueueRow, quality: string, options?: Record<string, unknown>): Promise<UrlInfo | null>;
  fetchLyrics(id: string | number, source: string, title?: string, artist?: string): Promise<{ lrc: string }>;
  isSaveDirAllowed(dir: string): boolean;
  getPolicyFacts(song: QueueRow): Promise<PolicyFacts>;
}

// ───────────────────────── 5) 时钟（可选）─────────────────────────
export interface ClockPort {
  now(): number;
}
```

### 3.1 `ProgressPort` —— 3 个方法

| 方法 | 签名 | 语义 | 错误约定 | 现实现 | 注入方式 |
|---|---|---|---|---|---|
| `emitQueueUpdated` | `(rows?: readonly QueueRow[]) => void` | 队列**整表**快照推送（等价今天的 `safeSend('queue-updated', downloadQueue)`）。引擎在**每次状态变更后、持久化之前**调用一次，语义是「增量事件」（渲染层按 taskId 合并，非追加）。`rows` 缺省时由实现自取快照（兼容任务书写法 `emitQueueUpdated()`）。 | **不得抛**（best-effort）。丢失一条不应改变队列状态。实现内部必须自行 try/catch。 | `main/index.js:390` `safeSend` → `context.safeSend`（L14-27），后者**附带** `taskbarProgress.refresh()`（L21-23） | 构造参数（必填） |
| `emitProgress` | `(taskId: string, payload: ProgressPayload) => void` | 单任务增量进度。引擎侧已节流（120ms、100% 必发），**实现不得再做时间窗合并**，否则 100% 那一拍会被二次吞掉（`test/queue-progress-throttle.test.js` 钉的就是这条） | **不得抛**。允许丢（丢进度条，不丢任务） | `safeSend('download-progress', payload)`（L607） | 构造参数（必填） |
| `emitError` | `(taskId: string, payload: DownloadErrorPayload) => void` | 失败终态 toast。取消**不**发（L724 路径）；`fatal` 供渲染层换话术 | **不得抛** | `safeSend('download-error', {...})`（L770-769） | 构造参数（必填） |

**id 二义性（实施必读）**：`payload.id` 今天取 `song.taskId`（进度 L590 一带、错误 L763 的 `taskId || id`）。端口签名里 `taskId` 与 `payload.id` 重复，契约取「`payload` 原样转发、`taskId` 仅用于日志/断言」，实现**不要**重写 `payload.id`，否则渲染层按 id 合并的逻辑会分叉。

**`rows` 活引用与快照**：今天传的是 `downloadQueue` 数组本体（活引用），`webContents.send` 在调用栈内同步结构化克隆，因此渲染层看到的是「调用那一刻」的值。所以：
- 若实现是**同步**转发 → 可以直接用活引用（零拷贝，性能不变）。
- 若实现**延迟**转发（`setImmediate`、队列化、批量合并）→ **必须** `rows.map(r => ({...r}))` 快照，否则会推送「未来状态」（事件时序倒错，见 6.1）。

### 3.2 `NotifyPort` —— 2 个方法

| 方法 | 签名 | 语义 | 错误约定 | 现实现 | 注入方式 |
|---|---|---|---|---|---|
| `downloadDone` | `(song, savePath) => void` | 单曲完成桌面通知。**是否通知的门禁留在引擎**（`prefs.get('notifications') !== false`，L665），Port 只管「弹」。`song` 是队列条目（标题/艺术家），`savePath` 是最终落盘绝对路径。 | **不得抛**。今天引擎已 `try/catch`（L666-670），历史上 Notification 构造在无焦点/Linux 环境会抛 | `index.js:402-415`（`new Notification` + `n.show()`） | 构造参数（可选，缺省为 no-op；现状可缺省，见 L667 的 `notifier &&`） |
| `showInFolder` | `(path: string) => void` | 在系统文件管理器中定位文件。今天只被通知的 click 回调用到（`index.js:409-412`），**引擎侧暂无调用点**——保留它的目的是让通知实现不在内部硬编码 `shell`，测试可断言「点击是否触达 reveal」。 | **不得抛**（文件可能已被删除，`shell.showItemInFolder` 对不存在路径会静默失败/抛） | `shell.showItemInFolder(savePath)`（`index.js:411`） | 构造参数（可选）。**不要**做成 setter：click 回调在通知创建时闭包捕获，setter 会换掉已创建通知的目标 |

> 注意区分：`ipc/window.js:225` 的 `show-item-in-folder` 通道是**另一个域**（渲染层主动定位），本次不动；`NotifyPort.showInFolder` 只服务下载域的「通知点击」。

### 3.3 `QueuePersistPort` —— 2 个方法

| 方法 | 签名 | 语义 | 错误约定 | 现实现 | 注入方式 |
|---|---|---|---|---|---|
| `load` | `() => Promise<readonly unknown[] \| null>` | 读**原始**队列数组。返回值语义：`null` = 文件不存在/损坏/非数组（适配器已记 warn 并完成 `.bak` 备份）；`[]` = 空队列；数组 = 原样条目。**清洗、状态迁移、条数上限全部留在引擎**（`sanitizeRestoredTask` L363、`downloading→error`、`pending>24h→error`、`MAX_RESTORED_TASKS`）——它们是领域规则，不是存储细节。 | **不得抛**。启动恢复的外层 try（`index.js:442-446`）会把异常变成「静默空队列」，等于用户任务全丢。失败一律降级为 `null` | `safeReadJson(QUEUE_FILE())`（L347）+ `res.ok/empty` 判据 | 构造参数（必填） |
| `save` | `(rows: readonly QueueRow[]) => void` | **整表覆盖写**（原子替换）。**必须同步完成**（`atomicWriteJson` 是同步写）。`trimDoneTasks()` 的 200 条保留策略**留在引擎**，Port 只负责「把这些行原样写进去」。 | **不得抛**（今天 `writeQueueNow` 自己吞异常只 warn，L318-320）。写失败等于内存态与磁盘态分叉，下一次写会覆盖，不需要回溯 | `atomicWriteJson(QUEUE_FILE(), downloadQueue)`（L317、L892） | 构造参数（必填） |

> **为什么 `save` 必须是同步**：终态（done/error/cancelled）靠 `immediate:true` 绕开 500ms 防抖，注释明确写了「不能依赖调度器 `.finally` 的微任务时序」（L724 一带、L815 一带）。若 Port 改成 `await`/`Promise`，`waitFor` 观察终态时会早于落盘，`dispose()`（L892）也无法在 `window-all-closed` 内保证写完。**契约：`save` 返回 `void`，不得返回 Promise。**

### 3.4 `DownloaderPort` —— 4 个方法

| 方法 | 签名 | 语义 | 错误约定 | 现实现 | 注入方式 |
|---|---|---|---|---|---|
| `fetchUrl` | `(song, quality, options?) => Promise<UrlInfo \| null>` | 智能取流（含跨源换源）。`fatal=true` 表示 VIP/登录/无流 → 引擎短路不重试；`url` 缺失且非 fatal → 走 `throw` 路径进重试判定（只有 403/404/410 重试）。`matchedSong/matchedFrom` 会被引擎记回队列（L514） | **可 throw**（引擎 catch 后按 `HTTP (403\|404\|410)` 判可重试，L698-710 一带）；**fatal 必须用返回值表达，不能 throw**，否则会丢掉 `errorCode` 短路语义 | `index.js:391` ← `src/api.getDownloadUrlSmart` | 构造参数（必填） |
| `fetchLyrics` | `(id, source, title, artist) => Promise<{lrc}>` | 拉歌词。换源成功时用 `matchedSong` 的 id/source（更准）。空 `lrc` 合法 | **可 throw**：引擎 `try/catch` 后当作「无歌词」继续（L634 一带 `/* 歌词获取失败不影响下载 */`） | `index.js:392` ← `src/api.getLyrics` | 构造参数（必填） |
| `isSaveDirAllowed` | `(dir) => boolean` | 路径沙箱判定（词法快筛 + realpath 复核）。**同步**，**必须 fail-closed**：不确定就 `false` | **不得抛**。今天引擎**裸调**（L525、L549）没有 try；一抛就是整首下载失败 + 未捕获异常 | `index.js:394` → `approvedDirs.isApprovedDir` | 构造参数（可选；缺省「不限制」仅限单测，生产必须注入） |
| `getPolicyFacts` | `(song) => Promise<PolicyFacts>` | `already_have` 规则的本地事实源（本地已有艺人/专辑） | **可 throw**；引擎已降级为 `{}`（L217-222，只让该规则 opt-out） | `index.js:397` → `qualityPolicyFacts.getPolicyFactsForQueue` | 构造参数（可选） |

**保留不动的既有注入**：`downloader`（L173）里的 `downloadFileWithRetry` / `embedId3Tags` / `cancelDownload`，以及 `history`、`fsa`。它们已经是构造函数参数，M1.1 只做「归类」不做「重写」——把它们塞进 `DownloaderPort` 会扩大改动面且无收益（见第七节）。

### 3.5 `ClockPort`（可选）

| 方法 | 签名 | 语义 | 错误约定 | 现实现 | 注入方式 |
|---|---|---|---|---|---|
| `now` | `() => number` | 当前 epoch 毫秒。引擎内 **5 处** `Date.now()`：L358（恢复时 `pending` 超 24h 判死）、L592/L600（进度节流时间窗 + 速度采样）、L691/L764（历史 `finishedAt`） | 不得抛 | 全局 `Date.now` | 构造参数（可选，缺省 `{ now: () => Date.now() }`） |

**范围边界**：`setTimeout` 相关（`PERSIST_DEBOUNCE_MS` L338、`RETRY_BACKOFF_MS` 退避、调度重排 100ms）**不**纳入 `ClockPort`。它们改定时器语义就是改行为，且测试依赖真实短延时。`ClockPort` 只解决「可注入假时间做 24h 判死/节流断言」。

### 3.6 注入方式总表（为什么全用构造参数，不用 setter）

| Port | 必填 | 缺省行为 | 注入时机 |
|---|---|---|---|
| `ProgressPort` | 是 | 无（缺失启动即抛，与今天 `safeSend` 校验 L177 对齐） | 构造 |
| `NotifyPort` | 否 | `{ downloadDone(){}, showInFolder(){} }`（no-op） | 构造 |
| `QueuePersistPort` | 是 | 无（缺失无法持久化，启动即抛） | 构造 |
| `DownloaderPort` | 是（`fetchUrl`/`fetchLyrics` 至少存在） | 无 | 构造 |
| `ClockPort` | 否 | `Date.now` | 构造 |

**明确反对 setter（`setProgressPort()` 之类）**：
1. 引擎在 `index.js:385` 创建后**立刻**被使用（L443 `loadPersistedQueue`、L466 `resumeRestoredQueue`），中间没有安全的「setter 窗口」；漏设就是运行期 `undefined.emitX()`。
2. 测试可以通过 setter 在运行中换实现，掩盖装配错误——构造函数参数能让「少接线」在启动时炸出来，这正是 L176-181 现有风格。

**推荐组合形态（嵌套，让「外部世界」一眼可见）：**

```js
// index.js 装配段（示意，非最终代码）
const progress = createElectronProgressPort({
  safeSend,                                      // context.safeSend
  getQueue: () => (downloadQueueEngine ? downloadQueueEngine.getQueue() : []),
  onAfterEmit: () => trayMod.updateTrayMenu(),   // 原 onQueueChanged 折叠进来
});
const notify = createElectronNotifyPort({ Notification, shell });
const persist = createAtomicQueuePersistPort({ queueFilePath: () => path.join(app.getPath('userData'), 'queue.json') });
const downloaderPort = createApiDownloaderPort({ getDownloadUrlSmart, getLyrics, isSaveDirAllowed, getPolicyFacts });
const clock = { now: () => Date.now() };         // 可省略（默认值）

downloadQueueEngine = createDownloadQueueEngine({
  ports: { progress, notify, persist, downloader: downloaderPort, clock },
  deps:  { userDataDir, getDefaultDownloadDir, history, fsa, transfer: downloaderDefault },
});
```

- `createElectron*Port` / `createAtomic*Port` / `createApi*Port` 建议放 **`src/main/downloadPorts.js`**（≤120 行，只被 `index.js` require，**永不**被 `downloadQueue.js` require）。
- 兼容期（M1.1-B 第一个 PR）可先保留扁平写法 `{ progress, notify, persist, downloaderPort, clock }`，B 收尾再收敛成 `ports` 嵌套；两种形态引擎内部只解构一次，替换成本 3 行。

---

## 四、Electron 边界

**规则**：`downloadQueue.js` 只允许 `require` 纯函数/纯 IO 工具（`path`、`fs`、`logger`、`prefs`、`naming`、`downloadPath`、`diskSpace`、`speedMeter`、`qualityPolicy`、`netClass`、`statemachine`、`atomicFile`）。**禁止** `require('electron')`、`require('../../context')`、`BrowserWindow`、`Notification`、`shell`、`tray`、`dialog`、`approvedDirs`。

| 能力 | 代码位置（现状） | 必须留在主进程装配层的理由 | 归属 Port |
|---|---|---|---|
| `webContents.send` + `isDestroyed()` 双检 | `context.js:14-27` | 依赖 `BrowserWindow` 生命周期；窗口可能在任意时刻销毁（重开窗口/退出） | `ProgressPort` 实现 |
| `taskbarProgress.refresh()` | `context.js:21-23` | 依赖 `BrowserWindow.setProgressBar`；且是对**整个队列**的 O(n) 扫描，属于 UI 性能决策 | `ProgressPort.emitQueueUpdated`/`emitProgress` 实现内部（**不要**在引擎里调） |
| `trayMod.updateTrayMenu()` | `index.js:398-401` | 依赖 `Tray` 与菜单状态 | `ProgressPort` 实现（折叠 `onQueueChanged`） |
| `new Notification(...)` + `n.show()` | `index.js:402-415` | 依赖 Electron 通知通道与平台差异 | `NotifyPort.downloadDone` |
| `shell.showItemInFolder()` | `index.js:411` | 依赖 Electron shell | `NotifyPort.showInFolder` |
| `app.getPath('userData' / 'music')` | `index.js:386`、`389`、`421` | 依赖 `app` ready 时序 | `deps.userDataDir` / `deps.getDefaultDownloadDir`（保持现状，不包成 Port） |
| `approvedDirs.isApprovedDir()` | `index.js:394` | 主进程安全策略（含 `realpath` 复核、批准目录注册表），不属于 domain | `DownloaderPort.isSaveDirAllowed` |
| `dialog.showSaveDialog()` | `ipc/download/exportPlaylist.js:27` | 依赖 Electron dialog | **不在本次范围**（导出域，见第七节） |

**谁可以被 `downloadQueue.js` 认识**：只有第五节表格里的 5 个接口名 + 数据形状。引擎**不知道**「主窗口」这个概念存在——它只知道「有个地方能收队列快照」。

装配层结构（目标态）：

```
renderer ──ipcMain(webContents.send)──┐
tray / taskbar ───────────────────────┤
                                      ├── ProgressPort impl ──┐
Notification / shell ─────────────────┤   NotifyPort impl ───┤
atomicWriteJson + queue.json ─────────┤   QueuePersistPort ──┼──> downloadQueue.js (domain)
src/api(取流/歌词) ───────────────────┤   DownloaderPort ────┤
approvedDirs / qualityPolicyFacts ────┘                       │
Date.now ──────────────────────────────    ClockPort ─────────┘
```

---

## 五、改造顺序与验收断言

原则：**B 先、C 后，各自独立可回滚**。B 只动 `downloadQueue.js` + `index.js` 装配段 + 测试 helper；C 只动 `ipc/download/queue.js` + `context.js` + `index.js` 的参数透传。两者不共享文件的重叠区域，但 `index.js` 都涉及——建议 B 先合入，C 再改，避免 rebase 冲突。

### 5.1 M1.1-B：剥离 ProgressPort + NotifyPort

**改动清单**

| 步骤 | 文件 | 动作 |
|---|---|---|
| B1 | `src/main/downloadPorts.js`（新建） | 导出 `createElectronProgressPort({safeSend, getQueue, onAfterEmit})`、`createElectronNotifyPort({Notification, shell})` |
| B2 | `src/main/index.js` L385-416 | 构造上述两个 Port；删除 `safeSend` / `notifier` / `onQueueChanged` 三个注入项（后者折叠进 `emitQueueUpdated` 的 `onAfterEmit`）；L386/389/391/392/394/397 保持不变 |
| B3 | `src/main/downloadQueue.js` | L302 → `ports.progress.emitQueueUpdated(downloadQueue)`；L607 → `ports.progress.emitProgress(song.taskId, payload)`；L770 → `ports.progress.emitError(song.taskId \|\| song.id, {...})`；L667-668 → `ports.notify.downloadDone(song, savePath)`；删除 L149/164/177 的 `safeSend` 文档、参数、校验；删除 L152/167/304-310 的 `onQueueChanged`；删除 L153/170 的 `notifier` |
| B4 | `downloadQueue.js` 头部注释 | 删除 L80（`safeSend` 历史注记）中的字样，改为「进度事件」；否则 grep 断言不为 0 |
| B5 | `test/downloadQueue.test.js`、`test/queue-progress-throttle.test.js`、`test/queue-resume.test.js`、`test/queue-abort.test.js`、`test/net-fail-queue.test.js`、`test/after-queue-done.test.js` | helper 里的 `safeSend` 换成 `progress: createRecordingProgressPort()`, `notifier: {...}` 换成 `notify: createRecordingNotifyPort()`；**记录结构保持 `{ch, payload}`**，让既有断言（`e.ch === 'queue-updated'`）不改 |
| B6 | `src/main/context.js` | **不动**（taskbar 副作用仍由 `context.safeSend` 承担，B 阶段不迁移它，降低风险） |

**验收断言（机械可执行）**

```powershell
# 1) 引擎不再认识 renderer / 通知
(Select-String -Path src\main\downloadQueue.js -Pattern "safeSend").Count            # 期望 0
(Select-String -Path src\main\downloadQueue.js -Pattern "notifier\.").Count          # 期望 0
(Select-String -Path src\main\downloadQueue.js -Pattern "require\('electron'\)").Count # 期望 0

# 2) 端口确实被接线（引擎侧必须命中）
(Select-String -Path src\main\downloadQueue.js -Pattern "emitQueueUpdated|emitProgress|emitError").Count  # 期望 ≥3
(Select-String -Path src\main\downloadQueue.js -Pattern "\.downloadDone\(").Count    # 期望 1

# 3) 装配层确实是唯一实现处
(Select-String -Path src\main\index.js -Pattern "new Notification").Count            # 期望 1（移入 downloadPorts.js 后为 0）
(Select-String -Path src\main\downloadPorts.js -Pattern "webContents.send|new Notification|showItemInFolder").Count # 期望 ≥3
```

```powershell
# 4) 行为回归（事件名/载荷/节流全在这些用例里）
node --test test/downloadQueue.test.js test/queue-progress-throttle.test.js test/queue-resume.test.js test/queue-abort.test.js test/net-fail-queue.test.js test/after-queue-done.test.js test/auto-cover-on-done.test.js test/auto-lyric-on-done.test.js
```

**必须保持绿的具体断言**（现有用例锚点，改完逐条核对）：

| 用例 | 断言 | 为什么会被 B 打破 |
|---|---|---|
| `test/downloadQueue.test.js:126` | `sent.some(e => e.ch === 'queue-updated')` | fake port 的字段名/通道名若改，直接红 |
| `test/downloadQueue.test.js:266-267` | `sent.find(e => e.ch === 'download-error')` 存在 | `emitError` 的 `id` 若取了 `song.id` 而非 `taskId`，渲染层合并不上，测试也会失配 |
| `test/downloadQueue.test.js:869` | 取消时 `download-error` 计数 = 0 | B3 别把 L724 的取消终态误接到 `emitError` |
| `test/queue-progress-throttle.test.js` | 密集进度被合并 + **100% 必发** + `song.progress` 每次都更新 | 若 Port 实现里再节流一次，100% 会被吞 |
| `test/auto-cover-on-done.test.js` / `auto-lyric-on-done.test.js` | 观察 `queue-updated` 的新完成行 | `emitQueueUpdated` 必须在状态写入**之后**调用（顺序不能反） |

**手工冒烟（Electron 内，5 分钟）**

1. 启动 → 打开下载页：重启前遗留任务能一次整表显示（`index.js:250` 的 `did-finish-load` 补发不受影响）。
2. 下载 1 首：进度条连续走；任务栏进度同步（`taskbarProgress` 仍由 `context.safeSend` 驱动，B 阶段未拆）；托盘菜单数量实时变（`onAfterEmit`）。
3. 完成：桌面通知弹出；点击通知 → 资源管理器定位到文件（`showInFolder`）。
4. 失败 1 首（断网/无效 id）：红条出现，文案带 `fatal` 差异。
5. 关闭「下载完成通知」偏好 → 再下一首：**不弹**通知（门禁仍在引擎 L665）。

**回滚点**：B 的全部改动集中在 3 个文件 + 6 个测试 helper，`git revert` 单个 commit 即可；`downloadPorts.js` 是新增文件，无副作用。

### 5.2 M1.1-C：context 端口化

**改动清单**

| 步骤 | 文件 | 动作 |
|---|---|---|
| C1 | `index.js:544-560` | `registerAllIpcHandlers()` 里把引擎能力打包成显式依赖：`ipcDownload.register({ queue: { getQueue: () => downloadQueueEngine.getQueue(), persistQueue: () => downloadQueueEngine.persistQueue(), processQueue: () => downloadQueueEngine.processQueue(), requestCancel: (id) => downloadQueueEngine.requestCancel(id), setPaused: (v) => downloadQueueEngine.setPaused(v), isPaused: () => downloadQueueEngine.isPaused(), progress } })` |
| C2 | `ipc/download.js:16-20` | `queue.register(opts.queue)` 透传（`stream`/`exportPlaylist` 不动） |
| C3 | `ipc/download/queue.js:18` | `function register(queueDeps = {}) { const { getQueue, persistQueue, processQueue, requestCancel, setPaused, isPaused, progress } = queueDeps; ... }`；删除 L13 的 `require('../../context')` |
| C4 | `queue.js` 9 处 `getCtx()` | 按附录 A.2 逐行替换成对应的 `queueDeps.*` |
| C5 | `queue.js` 8 处 `safeSend('queue-updated')` | 全部改成 `progress.emitQueueUpdated(downloadQueue)`（与引擎共用同一出口，队列域不再有「第二套推送」） |
| C6 | `queue.js` 8 处 `getDownloadQueue()` | 全部改成 `getQueue()` |
| C7 | `context.js:29-42` | 删除 **5 个**方法字段：`persistQueue`、`processQueue`、`requestCancelDownload`、`setQueuePaused`、`queueIsPaused`；保留 `app`、`setLibraryWatchDir`、`getMainWindow`、`safeSend`。**`getDownloadQueue` 暂时保留**：`context.safeSend` 的 `taskbarProgress.refresh(_getDownloadQueue)`（L21-23）与 `subscriptions.js:203` 仍依赖它，删了会让任务栏进度与订阅自动下载同时失效 |
| C8 | `subscriptions.js:197-203`、`ipc/library/scan.js:29` | **延后**（跨域），但需在 PR 描述里列为已知残留；`subscriptions.js` 的 `persistQueue/processQueue` 也要走 `downloadQueueEngine` 直接引用（可行但跨域，建议单独 ADR） |

**验收断言**

```powershell
# 1) 队列域零全局单例
(Select-String -Path src\main\ipc\download\queue.js -Pattern "context").Count          # 期望 0
(Select-String -Path src\main\ipc\download\queue.js -Pattern "safeSend").Count         # 期望 0
(Select-String -Path src\main\ipc\download\queue.js -Pattern "getDownloadQueue").Count # 期望 0
(Select-String -Path src\main\ipc\download\queue.js -Pattern "getCtx\(\)").Count       # 期望 0

# 2) 全仓 getCtx 从 11 → 2（仅剩跨域）
(Select-String -Path src\main -Pattern "getCtx\(\)" -Recurse -Include *.js).Count      # 期望 2
# 具体应为：src\main\subscriptions.js:197、src\main\ipc\library\scan.js:29

# 3) context.js 不再持有下载域方法
(Select-String -Path src\main\context.js -Pattern "persistQueue|processQueue|requestCancelDownload|setQueuePaused|queueIsPaused").Count # 期望 0
```

```powershell
# 4) 队列行为回归（C 阶段的主战场）
node --test test/queue-resume.test.js test/queue-abort.test.js test/queue-bulk-remove.test.js test/queue-order.test.js test/queue-playlist.test.js test/downloadQueue.test.js test/queue-progress-throttle.test.js test/subscription-empty-check.test.js
# 5) 全量稳定性门禁
node scripts/test-stable.cjs   # 期望 350/350，fail 0
```

**手工冒烟（8 条通道逐条过，缺一不可）**

| 通道 | 观察点 |
|---|---|
| `add-to-queue` | 单曲入队，UI 立刻出现 pending，磁盘 `queue.json` 500ms 内更新 |
| `add-playlist-to-queue` | 批量入队，去重计数正确，只推**一次** `queue-updated`（L254 的 `queued > 0` 门禁） |
| `cancel-download` | 在途任务转 error「下载已取消」，**不**弹失败 toast |
| `retry-download` | error → pending 并插到第一个 downloading 之后 |
| `remove-queue-item` | 在途任务先取消再摘除，磁盘不出现「用户没要的文件」 |
| `reorder-queue-item` | 置顶/上移/下移仅对 pending 生效，失败返回 `{ok:false}` |
| `set-queue-paused` | 暂停后不启新任务，恢复立即调度；返回值 `paused` 与实际一致 |
| `clear-finished-queue` / `clear-all-queue` | 清空后 UI 归零，`removed` 计数正确，清全部时逐条取消在途 |

**顺序约束（否则 C 会红）**：C5 依赖 B 已落地的 `progress` 实例。若 C 先做、B 未做，`queue.js` 只能继续用 `safeSend`，等于把「同一件事两条投递路径」固化下来。**因此顺序不可颠倒。**

---

## 六、风险与对策

### 6.1 事件丢失 / 重复

| 风险 | 触发条件 | 对策 |
|---|---|---|
| **队列快照丢失** | `emitQueueUpdated()` 无参 + 实现用 `getQueue()` 闭包，而 Port 在引擎创建**之前**构造 → 闭包返回 `[]` | 适配器必须**延迟求值**：`getQueue: () => downloadQueueEngine ? downloadQueueEngine.getQueue() : []`；并在 `index.js:418`（`downloadQueue = engine.getQueue()`）之后加一条启动断言 `if (progress.__getQueueLength() !== downloadQueue.length) logger.warn(...)`（可选） |
| **进度尾部丢失** | Port 实现自行做时间窗合并/去重（「反正引擎已经节流了」） | 契约写明「实现不得再节流」；`test/queue-progress-throttle.test.js` 的 100% 断言即守门 |
| **事件重复（taskbar 双刷）** | `context.safeSend` 在 L21-23 **已经**会 `taskbarProgress.refresh`，若 Port 实现又显式调一次 | B 阶段**不迁移** taskbar：`createElectronProgressPort` 只调 `safeSend`，不碰 `taskbarProgress`。若将来把 taskbar 移出 `context.safeSend`，必须同一次提交里删掉 L21-23 的分支 |
| **事件重复（托盘双调）** | `onQueueChanged` 保留 + `emitQueueUpdated` 里又调 `updateTrayMenu` | B2 明确二选一：折叠进 `onAfterEmit` 时**删除** `onQueueChanged` 注入（推荐）；若要保留，则 `onAfterEmit` 只能是 `null` |
| **事件时序倒错** | Port 实现延迟转发（`setImmediate`）+ 传活引用数组 | 见 3.1：延迟转发**必须**快照 `rows.map(r => ({...r}))` |
| **终态事件与落盘竞态** | 先 `emitQueueUpdated` 后 `persistQueue`（现状顺序 L302→L303），渲染层可能看到「done」但磁盘还没写 | **保持现状顺序**，不要「优化」成先落盘：`immediate` 路径是同步写，实际差距仅在非 immediate；改成先落盘会让 `dispose()` 期间多一次写 |

### 6.2 Port 实现抛错时引擎不得崩溃

契约是「发射类不得抛」，但**不能只靠自觉**。建议在引擎侧加一个 8 行的守卫（唯一新增的横切逻辑，允许出现在 `downloadQueue.js`）：

```js
/** 端口调用守卫：UI/通知/持久化的失败绝不能影响下载状态机 */
function guardPort(fn, label) {
  try { return fn(); } catch (e) { logger.warn(`[port] ${label} 失败:`, e && e.message); }
}
// 用法：guardPort(() => ports.progress.emitQueueUpdated(downloadQueue), 'emitQueueUpdated');
```

- 对 `emitProgress` **不要**逐次加 try（每个 chunk 一次，热路径）；改为在 Port 实现内部 try/catch（`context.safeSend` 已是如此，L24-26）。
- `persist.save` 已在 `writeQueueNow` 内 try（L315-320），保留即可。
- `downloadDone` 已有 try（L666-670），保留。

### 6.3 顺序/时序契约（最容易被「顺手优化」破坏的三条）

1. **`save` 同步**：终态立即落盘 → `waitFor` 观察 → `.finally` 顺序（见 3.3 注）。
2. **`dispose()` 仍同步 flush**：退出路径 `window-all-closed` 里调用，必须能同步写完（L892）。
3. **`trimDoneTasks()` 留在引擎**：200 条保留策略是领域规则；若搬进 Port，`dispose()` 与普通写在 trim 时机上会分叉。

### 6.4 测试替身（fake Port）如何构造

推荐一个共享 helper（`test/helpers/fakePorts.js`，可被所有 queue 测试 require）：

```js
function createRecordingPorts() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    progress: {
      emitQueueUpdated: rec('queue-updated'),
      emitProgress: rec('download-progress'),
      emitError: rec('download-error'),
    },
    notify: { downloadDone: rec('downloadDone'), showInFolder: rec('showInFolder') },
    persist: { load: async () => null, save: rec('persist') },
    downloader: null, // 各用例按需覆盖
    clock: { now: () => 1700000000000 },
  };
}
```

- **向后兼容既有断言**：让 `rec` 产出 `{ ch, payload }`（而非 `{name,args}`）就能一行不改地复用 `downloadQueue.test.js:126/266/869` 的断言。建议在 helper 里同时保留两种视图（`calls[].ch` + `calls[].args`）。
- **断言「被调用几次」而不是「被调用过」**：`notifyDownloadDone` 今天就可能因重试/取消路径多发一次（L620 路径不发，L724 不发），用计数断言能钉住这一点。
- **不要用 `proxyquire`/`mock-require` 去打模块单例**：引擎在 `createDownloadQueueEngine` 顶部就解构绑定（L180），运行时替换模块导出无效——`test/queue-resume.test.js:31-35` 的注释已经踩过这个坑。

### 6.5 TOCTOU 不受影响（明确结论）

**结论：本次改造不改变任何 TOCTOU 语义，也不需要「顺便修」它。**

- 沙箱判定仍是「检查-后-使用」两次：L525 校 `song.saveDir`（根目录），L549 校 `dirPlan.dir`（模板渲染后的子目录，落盘前最后一道）。两次都直接调 `isSaveDirAllowed`。
- `isSaveDirAllowed` 背后是 `approvedDirs.isApprovedDir`：**词法快筛 + `realpath` 复核**（L543-545 注释即写明）。Port 化只是把函数放到参数里，不引入缓存 → realpath 每次仍执行。
- **风险点只有一个**：C/B 期间若有人给 Port 实现加 `memoize`（「同一次下载同一目录不必反复 realpath」），就会把「用户下载中途撤销目录授权」这个真实攻击面重新打开。**契约禁止在 `isSaveDirAllowed` 上加缓存**（见 3.4）。
- 路径最终仍由 `path.join(dirPlan.dir, sanitizeFilename(...))` 拼（L555），Port 不参与拼接，无法注入路径穿越。

### 6.6 其他风险

| 风险 | 对策 |
|---|---|
| **行号漂移**（M1.1-A 正在改同一文件） | 本文绑定 blob `d0941f2`；实施时先跑第〇节的 3 条 `Select-String` 锚定，再按附录 A 的代码片段替换 |
| **`queue-resume.test.js` 的静态断言** | 该用例注释明确「用静态断言补上 index.js 调用点」（`test/queue-resume.test.js:14-15`）。C1 改装配段前**先读**它的断言文本（可能 grep `downloadQueueEngine.resumeRestoredQueue` 的顺序），避免合法重构被 grep 断言打红 |
| **MCP 复用 handler** | `register.getInvokeHandler`（`register.js:108-110`）让 MCP 直接调 handler 工厂，`register(queueDeps)` 的签名变化会影响 MCP 侧对下载类通道的调用。**必须**确认 `ipc/mcp.js` / `mcp/tools.js` 只按通道名调用、不直接 `require('../ipc/download/queue')` |
| **`prefs` / `logger` 仍是模块单例** | 本 ADR 不解决（ConfigPort/LogPort 属 M1.2 候选）；但要在 PR 描述里写明「引擎可测性上限仍受 `prefs` 单例约束」，避免被误认为「已经纯函数化」 |
| **窗口重建后的快照** | `index.js:246-255` 在 `did-finish-load` 补发 `queue-updated`。C 阶段若把队列域推送全部收进 `ProgressPort`，**这条补发不受影响**（它用 `context.safeSend`，不是队列域代码）；若未来迁移 taskbar 出 `context.safeSend`，这条也要一起改 |

---

## 七、不做的事（明确划界）

1. **不拆 `downloadQueue.js`**（≈916 行）。文件再大也不在 M1.1 范围；拆文件与端口化是两个正交改动，混在一起会让回归无法归因。
2. **不动 `streamProtocol`**（`src/main/streamProtocol.js`）、`ipc/download/stream.js`、`streamRegistry`/`streamRefresh`。播放链路有自己的 `test/stream-protocol.test.js` 钉子，与下载域端口无关。
3. **不改渲染层**（`src/renderer/**`）、**不改 preload**、**不改 `src/shared/ipcContract.js`**。事件名（`queue-updated` / `download-progress` / `download-error`）与载荷字段**一字不改**，因此渲染层零改动。
4. **不迁移 `taskbarProgress`**。它今天住在 `context.safeSend:21-23`，B 阶段保持原样；迁移需要同时改 `context.js` 与 `index.js` 的跳转逻辑，收益低于风险。留待 M1.2「主进程 UI 副作用归口」。
5. **不新增 `HistoryPort` / `FilePort` / `TransferPort`**。`history`、`fsa`、`downloader` 已通过构造参数注入（虽然 index.js 走默认），端口化的收益是「归类」而非「解耦」，放到 M2。
6. **不做 `ConfigPort`（prefs）/ `LogPort`（logger）**。它们是全局单例，但改动面横跨全仓，且不阻塞 M1.1 的两个验收断言。
7. **不改 `ipc/download/exportPlaylist.js`、`downloadTemplates.js`**。前者直接用 `dialog`（导出域），后者已是 `register({ getMusicDir })` 的注入样板——**注意：任务描述里把 `stream.js`/`exportPlaylist.js` 称为「已注入化样板」，实测并非如此**（两者都不接受注入参数，直接 `require` `api`/`electron`），真正可参照的样板是 `downloadTemplates.js:60` 的 `register(options)` + `L28-39` 的「注入缺失就降级」写法。
8. **不重排 `notifyQueueChanged` 内部顺序**（推送 → 落盘 → 额外回调），这是既有行为，改了会让「终态落盘时序」类测试的隐含假设失效。

---

## 附录 A：逐行替换映射（实施时照抄）

### A.1 `downloadQueue.js`（M1.1-B）

| 现状行 | 现状代码（锚点） | 改为 |
|---|---|---|
| L149 | `@param {(channel:string, payload:any) => void} deps.safeSend 推送渲染层` | 删除；新增 `@param {ProgressPort} deps.progress` |
| L152 | `@param {() => (void\|Promise<void>)} [deps.onQueueChanged] ...` | 删除（折叠进 `emitQueueUpdated`） |
| L153 | `@param {Object} [deps.notifier] 桌面通知能力 ...` | 改为 `@param {NotifyPort} [deps.notify]` |
| L164 | `safeSend,` | `progress,` |
| L167 | `onQueueChanged,` | 删除 |
| L170 | `notifier,` | `notify = noopNotifyPort,` |
| L177 | `if (typeof safeSend !== 'function') throw ...` | `if (!progress) throw new Error('[DownloadQueue] 必须注入 progress');` |
| L302 | `safeSend('queue-updated', downloadQueue);` | `guardPort(() => progress.emitQueueUpdated(downloadQueue), 'emitQueueUpdated');` |
| L304-310 | `if (typeof onQueueChanged === 'function') { try { onQueueChanged(); } catch ... }` | 删除整块（托盘刷新移入 Port 实现） |
| L607 | `safeSend('download-progress', payload);` | `progress.emitProgress(song.taskId, payload);`（热路径不加 guard） |
| L667-668 | `if (notifier && typeof notifier.notifyDownloadDone === 'function') { notifier.notifyDownloadDone(song, savePath); }` | `notify.downloadDone(song, savePath);`（外层 try 保留） |
| L770 | `safeSend('download-error', {` | `guardPort(() => progress.emitError(song.taskId \|\| song.id, {` … 结尾补 `}), 'emitError');` |

### A.2 `ipc/download/queue.js`（M1.1-C）

| 行号 | 现状 | 改为 |
|---|---|---|
| L13 | `const { getDownloadQueue, safeSend } = require('../../context');` | 删除 |
| L18 | `function register() {` | `function register(queueDeps = {}) { const { getQueue, persistQueue, processQueue, requestCancel, setPaused, isPaused, progress } = queueDeps;` |
| L53 / L88 / L108 / L135 / L148 / L168 / L181 / L200 | `const downloadQueue = getDownloadQueue();` | `const downloadQueue = getQueue();` |
| L54 | `const { persistQueue, processQueue } = require('../../context').getCtx();` | 删除（已由参数解构） |
| L89 / L136 / L182 | `... { persistQueue, requestCancelDownload } ...` | 删除；`requestCancelDownload` → `requestCancel` |
| L109 / L201 | `... { persistQueue, processQueue } ...` | 删除 |
| L149 / L169 | `... { persistQueue } ...` | 删除 |
| L160 | `... { setQueuePaused, queueIsPaused } ...` | 删除；`setQueuePaused` → `setPaused`，`queueIsPaused` → `isPaused` |
| L78 / L101 / L122 / L141 / L152 / L174 / L188 / L254 | `safeSend('queue-updated', downloadQueue);` | `progress.emitQueueUpdated(downloadQueue);` |
| L139 / L186 | `cancelInFlight(song, requestCancelDownload)` | `cancelInFlight(song, requestCancel)`（形参名同步改，L33 的 JSDoc 也改） |
| L161-163 | `if (typeof setQueuePaused !== 'function') ...` | `if (typeof setPaused !== 'function') return { ok:false, error:'引擎未就绪' };` |

> `makeTaskId()`（L267-269）不动：`Date.now` 是 ipc 侧 id 生成，与 `ClockPort`（引擎内）无关。

### A.3 `context.js`（M1.1-C）

```diff
 function init(opts) {
   _getMainWindow    = opts.getMainWindow    || (() => null);
   _getDownloadQueue = opts.getDownloadQueue || (() => []);   // 保留：taskbar 刷新仍用它
   _ctx = {
     app:           opts.app,
-    persistQueue:  opts.persistQueue,
-    processQueue:  opts.processQueue,
-    requestCancelDownload: opts.requestCancelDownload,
-    setQueuePaused: opts.setQueuePaused,
-    queueIsPaused: opts.queueIsPaused,
     setLibraryWatchDir: opts.setLibraryWatchDir,
   };
```

同时 `safeSend` 里的 `taskbarProgress.refresh(_getDownloadQueue)`（L21-23）在 C 阶段**保留**——它不属于下载域端口，属于 UI 副作用；若删 `_getDownloadQueue` 则需改为 `require('./index').getQueue` 之类，**不建议**。因此下列内容**不删**：`_getDownloadQueue`、`getDownloadQueue()`、L21-23。C 阶段只删「引擎方法转手」的 5 个 ctx 字段。

---

## 附录 B：验收命令合集（复制即跑）

```powershell
# B 阶段
(Select-String -Path src\main\downloadQueue.js -Pattern "safeSend").Count                                  # 0
(Select-String -Path src\main\downloadQueue.js -Pattern "notifier\.").Count                                # 0
(Select-String -Path src\main\downloadQueue.js -Pattern "emitQueueUpdated|emitProgress|emitError").Count  # >=3
node --test test/downloadQueue.test.js test/queue-progress-throttle.test.js test/queue-resume.test.js test/queue-abort.test.js test/net-fail-queue.test.js test/after-queue-done.test.js test/auto-cover-on-done.test.js test/auto-lyric-on-done.test.js

# C 阶段
(Select-String -Path src\main\ipc\download\queue.js -Pattern "context|safeSend|getCtx\(\)").Count           # 0
(Select-String -Path src\main\context.js -Pattern "persistQueue|processQueue|requestCancelDownload|setQueuePaused|queueIsPaused").Count  # 0
(Select-String -Path src\main -Pattern "getCtx\(\)" -Recurse -Include *.js).Count                          # 2
node --test test/queue-resume.test.js test/queue-abort.test.js test/queue-bulk-remove.test.js test/queue-order.test.js test/queue-playlist.test.js test/downloadQueue.test.js test/subscription-empty-check.test.js
node scripts/test-stable.cjs                                                                                # 350/350, fail 0
```

---

## 附录 C：Port 数量与调用点统计（回报口径）

| 指标 | 数值 |
|---|---|
| Port 接口数 | **5**（Progress / Notify / QueuePersist / Downloader / Clock） |
| 端口方法总数 | **12**（Progress 3 + Notify 2 + QueuePersist 2 + Downloader 4 = **11 个必需**，Clock `now()` 为**可选第 12 个**） |
| `downloadQueue.js` 实测 `safeSend` 调用点 | **3**（L302 / L607 / L770） |
| `downloadQueue.js` 实测 `notifier.notifyDownloadDone` 调用点 | **1**（L668） |
| `downloadQueue.js` 实测 `onQueueChanged` 调用点 | **1**（L306） |
| `ipc/download/queue.js` 实测 `getCtx()` 调用点 | **9**（L54/89/109/136/149/160/169/182/201） |
| `ipc/download/queue.js` 实测 `getDownloadQueue()` / `safeSend` | **8 / 8** |
| `createDownloadQueueEngine` 注入项 | **12** |

> 上表「端口方法总数」一行按方法逐个数：Progress 3 + Notify 2 + QueuePersist 2 + Downloader 4 = **11 个必需方法**，Clock 的 `now()` 为**可选第 12 个**。接口（interface）数量为 **5**。

---

## 附录 D：重新锚定脚本（行号漂移时先跑这个）

`downloadQueue.js` 正被 M1.1-A 并行修改；下面的脚本**按代码片段**打印当前真实行号，与任何行号快照无关。实施前复制整段到 PowerShell 执行，用输出替换正文中的 `Lxxx`。

```powershell
$f = 'src\main\downloadQueue.js'
$anchors = [ordered]@{
  '1  deps 参数表'        = 'function createDownloadQueueEngine\(\{'
  '2  safeSend 校验'      = "typeof safeSend !== 'function'"
  '3  QUEUE_FILE'         = 'const QUEUE_FILE ='
  '4  notifyQueueChanged' = 'function notifyQueueChanged\('
  '5  emit queue-updated' = "safeSend\('queue-updated'"
  '6  persistQueue'       = 'function persistQueue\(opts\)'
  '7  writeQueueNow'      = 'function writeQueueNow\(\)'
  '8  loadPersistedQueue' = 'async function loadPersistedQueue\(\)'
  '9  emit progress'      = "safeSend\('download-progress'"
  '10 emit download-error'= "safeSend\('download-error'"
  '11 notifier.downloadDone' = 'notifier\.notifyDownloadDone\(song'
  '12 沙箱校验 1(根目录)' = 'isSaveDirAllowed\(songSaveDir\)'
  '13 沙箱校验 2(子目录)' = 'isSaveDirAllowed\(dirPlan\.dir\)'
  '14 savePath 拼接'      = 'sanitizeFilename\(renderFileName'
  '15 downloadFileWithRetry' = 'await downloadFileWithRetry\('
  '16 embedId3Tags'       = 'await embedId3Tags\('
  '17 dispose'            = 'dispose\(\) \{'
  '18 error 终态落盘'     = 'notifyQueueChanged\(true\);'   # 取最后一次出现
}

foreach ($k in $anchors.Keys) {
  $hits = Select-String -Path $f -Pattern $anchors[$k]
  $lines = ($hits | ForEach-Object { $_.LineNumber }) -join ', '
  "{0,-26} -> {1}" -f $k, $lines
}

"---- 计数不变量 ----"
"safeSend 调用点            : " + (Select-String -Path $f -Pattern "safeSend\('").Count        # 期望 3
"notifyQueueChanged 调用点  : " + ((Select-String -Path $f -Pattern "notifyQueueChanged\(").Count - 1)  # 期望 9
"notifier 调用点            : " + (Select-String -Path $f -Pattern "notifier\.notifyDownloadDone\(").Count  # 期望 1
"onQueueChanged 调用点      : " + (Select-String -Path $f -Pattern "^      onQueueChanged\(\);").Count       # 期望 1

"---- 跨域不变量（改造后应变 0）----"
"queue.js getCtx()          : " + (Select-String -Path 'src\main\ipc\download\queue.js' -Pattern 'getCtx\(\)').Count
"queue.js safeSend          : " + (Select-String -Path 'src\main\ipc\download\queue.js' -Pattern 'safeSend').Count
"main 全仓 getCtx()         : " + (Select-String -Path 'src\main' -Pattern 'getCtx\(\)' -Recurse -Include *.js).Count
```

**判读规则**

| 输出 | 含义 |
|---|---|
| `safeSend 调用点 = 3` 且 `notifyQueueChanged 调用点 = 9` | 与本文基线一致，正文行号可用（若 hash 相同） |
| `safeSend 调用点 = 0` | M1.1-B 已落地，实现者应按「附录 A 的 replacement 后形态」核对，而不是照抄正文行号 |
| `queue.js getCtx() = 0` | M1.1-C 已落地，验收断言改为「全仓 getCtx = 2」 |
| 任一计数与本文不符 | 说明 M1.1-A 又改了结构，**先比对 `git hash-object`，再按锚点重算**，不要凭记忆改源码 |

> `downloadQueue.js` 里 `notifyQueueChanged` 的定义与调用共用同一个正则，故计数减 1；若输出为正整数但语义对不上（例如多出 `applyStatus` 之类的同名封装），以 `git log -p` 为准，不要强行套本文的 9 处清单。

---

## 八、实施结果（2026-11-07）

> 本节为实施完成后回填，记录契约落地情况与偏差；第一至七节及附录 A-D 原文保持不变，行号快照仅代表决策时刻。

### 8.1 M1.1-B：UI 推送剥离（已完成）

- `src/main/downloadQueue.js` 内 `safeSend` / Electron `Notification` / `shell.` 均为 **0 命中**（仅残留 `prefs.get('notifications')` 一处设置读取，与 Electron Notification API 无关）。
- ProgressPort（`emitQueueUpdated` / `emitProgress` / `emitError`）与 NotifyPort（`downloadDone` / `showInFolder`）的实现落在组装根 `src/main/index.js`（`downloadProgressPort` L112/L118/L122，`downloadNotifyPort` L414/L425）。
- `guardPort` 包裹非热路径的 Port 调用：端口抛错只打印告警，不污染队列状态。对抗性探针（注入所有方法均抛错的 Port）下仍能完成下载，日志仅出现告警，条目正常进入终态。

### 8.2 M1.1-C：context 注入（已完成）

- `src/main/ipc/download/queue.js` 的 9 处 `getCtx()` 降为 **0**，改为 `register(queueDeps)` 构造注入（L40）。
- 该文件的 `require('../../context')` 已删除，不再触碰全局单例。
- 缺 deps 时构造期 fail-fast，不再把缺参错误推迟到运行时。
- 装配侧 `src/main/ipc/download.js` 的 `register(opts)` 将 `opts.queue` 透传为 `queue.register(...)`（L24）。

### 8.3 验收证据（2026-11-07）

| 验收项 | 结果 |
|---|---|
| queue 子集 | 136/136 通过 |
| play-queue | 16/16 通过 |
| `node scripts/test-stable.cjs` | 350/350 文件、3553 用例、fail 0、未执行 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error（6 条既有 warning，无新增） |
| `npm run build` | 双轨产物齐全 |
| `downloadQueue.js` 的 `safeSend` 调用点 | 0 |
| `ipc/download/queue.js` 的 `getCtx()` 调用点 | 0 |

### 8.4 与 ADR 的偏差（均已接受）

1. **Port 实现内联在 `src/main/index.js`，未新建 `src/main/downloadPorts.js`。**
   理由：减少一次跨文件间接层——Port 的构造本就是组合根职责，独立 ports 模块会退化为纯转手文件。代价是 `index.js` 略长，留待 M1.2 拆分装配段时处理。
2. **注入参数使用短名 `requestCancel` / `setPaused` / `isPaused` / `getQueue`，而非正文中的长名。**
   理由：与附录 A.2 的替换映射一致（A.2 即按短名书写），实施以附录为准，正文长名仅作描述用途。

### 8.5 范围外遗留

全仓 `src/main/**/*.js` 中 `getCtx()` 仍剩 **2 处调用点**：

- `src/main/subscriptions.js:197`
- `src/main/ipc/library/scan.js:29`

二者分属订阅域与曲库域，不在 M1.1（下载域）范围内，随对应域迁移时一并处理。补充：`src/main/context.js:46` 为函数定义，`src/main/ipc/cookie.js:17` 为注释提及，均非调用点。