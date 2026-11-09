# M1 现状基线（只读测绘）

> 采集时间：2026-11-07
> 采集方式：只读命令（Get-ChildItem / Select-String / node -e 静态读取 `src/shared/ipcContract.js` 导出对象）
> 全部数字为实测值；无法确认的标注「待实测」。
> 本文档只做测绘，不含任何代码改动。

---

## 一、代码体量

### 1.1 主进程（`src/main/**/*.js`）

| 指标 | 实测值 |
|---|---|
| 文件数 | 70（全部为 `.js`，无 `.ts`） |
| 总行数 | 9013 |
| 平均行数 | 128.76 行/文件 |
| **> 800 行的文件数** | **0** |
| 最大文件 | `src/main/downloadQueue.js` 742 行 |

**> 800 行清单：空。**（最大 742 行，距 800 阈值差 58 行）

前 20 名（供拆分排序参考）：

| 行数 | 文件 | 是否 >800 |
|---|---|---|
| 742 | `src/main/downloadQueue.js` | 否 |
| 556 | `src/main/index.js` | 否 |
| 363 | `src/main/streamProtocol.js` | 否 |
| 350 | `src/main/subscriptions.js` | 否 |
| 323 | `src/main/ipc/playlist.js` | 否 |
| 303 | `src/main/playCache.js` | 否 |
| 286 | `src/main/mcp/tools.js` | 否 |
| 265 | `src/main/ipc/cloudSync.js` | 否 |
| 254 | `src/main/ipc/window.js` | 否 |
| 246 | `src/main/userSourceValidator.js` | 否 |
| 234 | `src/main/ipc/download/queue.js` | 否 |
| 224 | `src/main/ipc/ai-music.js` | 否 |
| 218 | `src/main/updater.js` | 否 |
| 192 | `src/main/ipc/search.js` | 否 |
| 189 | `src/main/loginWindow.js` | 否 |
| 168 | `src/main/approvedDirs.js` | 否 |
| 165 | `src/main/mcp/mcpServer.js` | 否 |
| 162 | `src/main/tray.js` | 否 |
| 155 | `src/main/streamRegistry.js` | 否 |
| 149 | `src/main/ipc/mcp.js` | 否 |

结论：主进程**不存在**「单文件超千行」的巨无霸，主要问题不是体量而是**职责混装**（见第二、四节）。

### 1.2 渲染层（`src/renderer/app`，按目录分组）

| 目录 | 文件数 | 行数 | 文件类型 |
|---|---|---|---|
| `views/` | 9 | 2064 | 全部 `.vue` |
| `stores/` | 9 | 2018 | 全部 `.js` |
| `components/shell/` | 7 | 558 | 全部 `.vue` |
| `core/` | 8 | 546 | 全部 `.js` |
| `components/player/` | 3 | 516 | 全部 `.vue` |
| `components/data/` | 4 | 447 | 全部 `.vue` |
| `components/common/` | 1 | 100 | `.vue` |
| 根目录（`App.vue`/`main.js`/`player.js`） | 3 | 75 | 1 vue + 2 js |
| **合计** | **44** | **6324** | 19 js + 25 vue |

`src/renderer/app` 目录下文件总数 47（另 3 个为 `.css` / `.html`）。全仓 `src/renderer` 共 47+174 个文件，其中 **`src/renderer/js/` 是遗留渲染层：172 个 js，28949 行，单文件最大 1384 行** —— 它不在 `tsconfig.renderer.json` 的 include 范围内（见 1.3），属于 M1 的**排除项**，但会在后续清理期形成认知负担，需在里程碑中显式声明不碰。

单文件 Top 10：

| 行数 | 文件 |
|---|---|
| 451 | `views/SearchView.vue` |
| 378 | `stores/player.js` |
| 344 | `views/SettingsView.vue` |
| 310 | `views/DownloadView.vue` |
| 295 | `stores/playlist.js` |
| 294 | `stores/search.js` |
| 279 | `stores/settings.js` |
| 268 | `views/DiscoverView.vue` |
| 228 | `views/PlaylistView.vue` |
| 220 | `views/NowPlayingView.vue` / `components/player/PlayerBar.vue` |

### 1.3 TS 迁移工具链现状（实测）

- `tsconfig.renderer.json`：`allowJs: true`、`checkJs: true`、`strict: true`、`noEmit: true`，include = `src/renderer/app/**/*.{js,vue,ts}`。
- `package.json` 脚本：`typecheck:renderer` = `vue-tsc -p tsconfig.renderer.json --noEmit`；`typecheck` = `tsc -p tsconfig.json --noEmit`。
- 依赖：`typescript ^5.9.3`、`vue-tsc ^2.2.12`。
- 即当前是「JSDoc 强校验 JS」而非真 TS。迁移工作量 = 44 文件 / 6324 行改扩展名 + 补真实类型。
- `npm run typecheck:renderer` 当前是否 0 error：**待实测**（本次未执行，避免超出只读测绘范围）。

---

## 二、electron 依赖分布

实测 25 个文件、33 处 `require('electron')`（含 `require('electron').xxx` 内联形态）。

| 文件 | 取用能力 | 职责 | 是否 domain 候选 |
|---|---|---|---|
| `src/main/index.js` | `app, BrowserWindow, Notification, protocol, session` + 内联 `shell` | 应用启动/生命周期/窗口/装配根 | 否（组合根，需**瘦身**但保留） |
| `src/main/tray.js` | `app, Menu, Tray, nativeImage` | 托盘 | 否（外壳适配层） |
| `src/main/appMenu.js` | `Menu` | 菜单 | 否 |
| `src/main/globalShortcuts.js` | `globalShortcut` | 快捷键 | 否 |
| `src/main/loginWindow.js` | `BrowserWindow` | 登录窗 | 否 |
| `src/main/playQueue.js` | `app` | 播放队列持久化（仅取 app 存路径） | **是**（存储路径应注入） |
| `src/main/crash.js` | `crashReporter` | 崩溃上报 | 否 |
| `src/main/updater.js` | `BrowserWindow` ×5（动态取窗口） | 自动更新 | 否（外壳） |
| `src/main/clipboardWatch.js` | `clipboard` | 剪贴板监听 | 否 |
| `src/main/corsHeaders.js` | `session` | 响应头注入 | 否 |
| `src/main/preload.js` / `preload-secondary.js` | `contextBridge, ipcRenderer` | 预加载桥 | 否（必须留在 electron 层） |
| `src/main/ipc/register.js` | `ipcMain` | IPC 注册与参数校验 | 否（唯一合法 ipcMain 出口） |
| `src/main/ipc/window.js` | `BrowserWindow, dialog, shell, app` | 窗口/文件对话框 | 否（外壳），但 `open-folder` 等服务调用需注入 |
| `src/main/ipc/cloudSync.js` | `dialog` + 内联 `app.getPath('userData')` | 云同步（导入导出） | 部分（路径注入后可迁） |
| `src/main/ipc/download/exportPlaylist.js` | `dialog` | 歌单导出保存对话框 | **是（下载域）**，需 `FileDialogPort` |
| `src/main/ipc/downloadTemplates.js` | 内联 `app.getPath('music')` | 下载模板默认目录 | **是（下载域）**，需 `PathPort` |
| `src/main/ipc/ai-music.js` | `app` | AI 生成音乐 | 部分（版本/路径注入） |
| `src/main/ipc/ai-assistant.js` | 内联 `app.getVersion()` | AI 助手 | 部分 |
| `src/main/ipc/mcp.js` | 内联 `app.getVersion()` | MCP 状态 | 部分 |
| `src/main/ipc/songStory.js` | 内联 `app.getPath('userData')` | 歌曲讲解 | 部分 |
| `src/main/ipc/tasteProfile.js` | 内联 `app.getPath('userData')` | 口味画像 | 部分 |
| `src/main/mcp/auditSink.js` | 内联 `app.getPath('userData')` | MCP 审计落盘 | 部分 |
| `src/main/ipc/library/convert.js` | `dialog, shell` | 音频转码 | **是（曲库域）**，需 dialog/shell 端口 |
| `src/main/ipc/library/files.js` | `shell` | 文件操作 | **是（曲库域）**，需 shell 端口 |

职责归类小结：

- **纯外壳（不可迁 domain）**：`index/tray/appMenu/globalShortcuts/loginWindow/crash/updater/clipboardWatch/corsHeaders/preload*/ipc/register/ipc/window` = 12 个。
- **domain 候选（下载/曲库/歌单/搜索）**：`ipc/download/exportPlaylist`、`ipc/downloadTemplates`、`ipc/library/convert`、`ipc/library/files`、`playQueue` = 5 个。
- **仅需「路径/版本」小注入即可去电子化**：`ipc/cloudSync、ipc/ai-music、ipc/ai-assistant、ipc/mcp、ipc/songStory、ipc/tasteProfile、mcp/auditSink` = 7 个。
- **搜索域/歌单域零直取**：`ipc/search.js`（192）、`ipc/playlist.js`（323）实测**无** `require('electron')`，已具备去电子化前提。

---

## 三、IPC 契约形态（`src/shared/ipcContract.js`，508 行）

### 3.1 数量（实测）

| 指标 | 数量 |
|---|---|
| `CHANNELS` 通道总数 | **153** |
| 其中 invoke 方向 | 114 |
| 其中 send 方向 | 16 |
| 其中 receive 方向 | 27 |
| **`METHODS` 条目** | **111** |
| **`EVENTS` 条目** | **18** |
| 带 `args` 声明的通道 | 84 |
| 无 `args`（无参透传）的通道 | 69 |
| 参数规格（ArgSpec）总数 | 134 |
| 含 object 参数的通道 | 19 |

映射覆盖：`METHODS ∪ EVENTS` 的值共 129 条通道，**未映射通道 24 条**（`cloud-sync-*` 3、`mcp-*` 5、`ai-assistant-*` 3、`smart-playlist-generate` 1、`desktop-lyric-*` 4、`mini-close` 1、`focus-search`/`sleep-timer` 2、`update-*` 5）。这些是「有通道但渲染层无统一方法名」的入口，schema 化的优先级低，但**契约完整性检查需要显式豁免清单**（现状靠 `test/ipc-contract.test.js` 静态比对）。

### 3.2 参数形态分类（实测）

| 类型（`k`） | 出现次数 | 说明 |
|---|---|---|
| `str` | 73 | 带 max 截断，是当前主力 |
| `any` | 21 | **无约束**，schema 化的最大盲区 |
| `obj` | 19 | 仅校验「是对象」，**无字段级约束** |
| `int` | 8 | def + max |
| `bool` | 5 | |
| `enum` | 4 | `lossless/hq/standard`、`up/down/top`、`shutdown/sleep/quit` 等 |
| `arr` | 4 | 仅 max 长度 |

三形态兼容：`normalizeArgs()` 同时接受**位置参数**、**单数组**、**单对象**（按声明参数名取键），见文件 503-508 行。这意味着「object 参数」有两层含义：① 声明为 `t.obj()` 的 payload 槽位；② 整通道聚合为单对象的调用形态。

### 3.3 object 参数字段样例（19 个通道，实测清单）

| 通道 | 参数签名 | 对象字段是否可推导 |
|---|---|---|
| `get-download-url-smart` | `song:any, quality:str, options:obj` | 否，`options` 字段 **待实测**（需读 handler） |
| `add-to-queue` | `song:obj` | 否（song 形状见 `core/song.js`，契约内未声明） |
| `add-playlist-to-queue` | `payload:obj` | 否 |
| `export-playlist` | `params:obj` | 否 |
| `proxy-play` | `url:str, referer:str, refresh:obj` | 否 |
| `save-download-template` | `template:obj` | 否 |
| `subscribe-update` | `key:str, patch:obj` | 否 |
| `check-local-exists` | `payload:obj` | 否 |
| `convert-audio` | `params:obj` | 否 |
| `query-history` | `opts:obj` | 否 |
| `ai-generate-music` | `params:obj` | 否 |
| `ai-generate-lyrics` | `params:obj` | 否 |
| `ai-translate-lyrics` | `params:obj` | 否 |
| `ai-add-history` | `item:obj` | 否 |
| `ai-provider-save` | `patch:obj` | 否 |
| `save-user-playlist` | `playlist:obj` | 否 |
| `aggregate-cross-source` | `opts:obj` | 否 |
| `mcp-audit` | `opts:obj` | 否 |
| `ai-assistant-tool-call` | `name:str, args:obj, confirmed:bool, scope:enum, runId:str` | 否（`args` 为自由形状，风险最高） |

**结论：契约层「可推导 schema」的粒度只到 `名称 + 类型 + 长度/枚举`，19 个 `obj` 以及 21 个 `any` 没有任何字段级 schema。** 这是渲染层 TS 迁移的真正阻塞点——没有对象形状，就无法生成可用类型。字段级形状需逐个读 handler（本次仅读契约，字段表标注「待实测」，M1 第二子线补齐）。

`obj` 规格的实现（`coerceVal` 的 `obj` 分支）只做 `typeof === 'object' && !Array.isArray`，**不做键白名单、不做原型污染防护**，与 `arr` 的截断策略不对称。

---

## 四、下载引擎耦合（A → B 边）

### 4.1 范围口径

- 按「文件名/内容含 `download`」实测命中 **29 个文件**（子串匹配，含更新器、歌单等误命中）。
- 其中**下载链路核心文件 13 个**（下表和图中的节点）：

| 文件 | 行数 |
|---|---|
| `src/main/downloadQueue.js`（引擎） | 742 |
| `src/main/downloadQueue/statemachine.js` | 117 |
| `src/main/ipc/download.js`（组装根） | 22 |
| `src/main/ipc/download/queue.js` | 234 |
| `src/main/ipc/download/stream.js` | 93 |
| `src/main/ipc/download/exportPlaylist.js` | 59 |
| `src/main/ipc/downloadTemplates.js` | 132 |
| `src/main/qualityPolicyFacts.js` | 77 |
| `src/main/diskSpace.js` | 63 |
| `src/main/speedMeter.js` | 33 |
| `src/utils/downloader.js` | 619 |
| `src/utils/downloadPath.js` | 104 |
| `src/utils/qualityPolicy.js` | 194 |

合计 2489 行。

### 4.2 边表（实测 `require` 关系）

**A. 组合根 → 下载模块**

| From | To |
|---|---|
| `main/index.js` | `./downloadQueue`、`./ipc/download`、`./ipc/downloadTemplates`、`./qualityPolicyFacts`、`./streamProtocol`、`./streamRegistry`、`./playCache`、`./approvedDirs`、`./context`、`./taskbarProgress`、`../shared/downloadDefaults` |
| `main/ipc/download.js` | `./download/stream`、`./download/queue`、`./download/exportPlaylist` |

**B. IPC 分片 → 引擎/基础设施**

| From | To | 关键点 |
|---|---|---|
| `ipc/download/queue.js` | `../register`、`../../context`（**10 处**）、`../../queueOrder`、`utils/history`、`utils/logger` | 队列读写全部经 `context.getCtx()` 取 `persistQueue/processQueue/requestCancelDownload/setQueuePaused/queueIsPaused` |
| `ipc/download/stream.js` | `../register`、`../../streamRegistry`、`../../streamRefresh`、`../../../api`、`utils/urlGuard` | 取流直接调 `api`，绕过 domain 边界 |
| `ipc/download/exportPlaylist.js` | `../register`、`utils/fsAsync`、`electron.dialog`（内联） | 保存对话框硬耦合 electron |
| `ipc/downloadTemplates.js` | `../../utils/prefs`、`../../shared/downloadDefaults`、`../../utils/downloadPath`、`../../utils/naming`、内联 `electron.app.getPath('music')` | 模板默认目录硬耦合 |

**C. 引擎 → 下游能力**

| From | To |
|---|---|
| `downloadQueue.js` | `./diskSpace`、`./speedMeter`、`../utils/downloader`、`../utils/downloadPath`、`../utils/qualityPolicy`、`../utils/naming`、`../utils/history`、`../utils/fsAsync`、`../utils/atomicFile`、`../utils/relinkRefs`、`../utils/prefs`、`../utils/logger`、`../shared/downloadDefaults`、`../shared/netClass` |
| `utils/downloader.js` | `./logger`、`./fsAsync`、`./urlGuard`、`../shared/netClass`、`node-id3`、node `fs/https/http/child_process` |
| `utils/downloadPath.js` | `./naming`、**`../main/approvedDirs`**（utils 反向依赖 main，违反分层） |
| `qualityPolicyFacts.js` | `../utils/libraryIndex`（下载域读曲库索引：跨域读） |
| `streamProtocol.js` | `./streamRegistry` |
| `streamRefresh.js` | `../api` |
| `streamRegistry.js` | 无 |

**D. 反向/旁路耦合（最需要处理的 4 条）**

1. `utils/downloadPath.js → main/approvedDirs.js`：工具层反向依赖主进程层。
2. `downloadQueue.js` 内 **9 处 `safeSend('queue-updated' | 'download-progress' | 'download-error', ...)`** + `onQueueChanged`（托盘刷新）+ `notifier.notifyDownloadDone`（Electron Notification + `shell.showItemInFolder`）：引擎自带 UI 推送与桌面通知。
3. `createDownloadQueueEngine({...})` 注入清单实测为 12 项：`userDataDir、getDefaultDownloadDir、safeSend、getDownloadUrlSmart、getLyrics、isSaveDirAllowed、getPolicyFacts、onQueueChanged、notifier、history/prefs/fsa 等默认实现` —— 注入面偏大，其中 8 项是「能力端口」，可直接固化为 Port 接口，已是**半成品依赖注入**。
4. `ipc/download/queue.js` 对 `context.getCtx()` 的 **10 处** 调用是隐式全局单例；`context.js`（57 行）把 `persistQueue/processQueue/requestCancelDownload/setQueuePaused/queueIsPaused/setLibraryWatchDir` 与 `getMainWindow/getDownloadQueue` 塞进同一 mutable 容器，是下载域与窗口/曲库域的共同耦合点。

**E. 死代码实测**

`src/main/downloadQueue/statemachine.js`（117 行）在 `src/` 与 `test/` 全域检索中**仅被 `test/queue-statemachine.test.js` 引用**，生产运行路径无引用 —— 属于「测试保活的影子实现」，与 `downloadQueue.js` 内联状态机并存，是迁移期的双重事实来源，必须先收敛（删除或正式接入）。

---

## 五、M1 四条子线拆解（预估，非实测）

| 子线 | 涉及文件 | 预估人日 | 风险 | 可并行 | 前置 | 验收断言 |
|---|---|---|---|---|---|---|
| **L1 契约 schema 化** | `src/shared/ipcContract.js`(508)、`test/ipc-contract.test.js`、`preload.js`/`preload-secondary.js` 派生链 | 2.5 | 中 | 可并行（独占契约文件） | 无 | ① 19 个 `obj` 全部产出字段级 schema；② `ai-assistant-tool-call.args` 与 `get-download-url-smart.options` 补白名单/形状校验；③ `normalizeArgs` 三形态兼容行为不变（既有 `ipc-contract` 测试全绿）；④ 新增「新增 obj 参数必须带字段 schema」的静态断言 |
| **L2 下载域垂直切片** | `main/downloadQueue.js`(742)、`main/downloadQueue/statemachine.js`(117)、`main/ipc/download.js`(22)、`ipc/download/{queue 234, stream 93, exportPlaylist 59}`、`ipc/downloadTemplates.js`(132)、`utils/{downloader 619, downloadPath 104, qualityPolicy 194}`、`main/{qualityPolicyFacts 77, diskSpace 63, speedMeter 33}` | 6.5 | **高** | 不可与 L4 并行（同改 `index.js` 装配） | 已具备（`realpathContain` + `t.shape` 样板） | ① 新 `domain/download/**` 内 `require('electron')` = 0；② `safeSend/notifier/onQueueChanged` 全部改为 Port 实现，引擎内无直接推送；③ `utils/downloadPath → main/approvedDirs` 反向依赖消除；④ `downloadQueue.test.js`、`queue-*.test.js`、`net-fail-queue.test.js`、`stream-failure*.test.js`、`downloader*.test.js` 全绿 |
| **L3 渲染层 TS 迁移** | `app/` 全部 44 文件 / 6324 行（`stores` 2018 + `core` 546 先行；`views` 2064 + `components` 1621 次之） | 6.0 | 中 | 可与 L1/L2/L4 并行（互不重叠文件） | 类型依赖 L1 输出；`stores` 部分依赖 L2 的下载 API 形状 | ① 44 文件 `.js/.vue` → `.ts`/`<script setup lang="ts">`；② `npm run typecheck:renderer` 0 error 且 `strict` 保持 true；③ 不放宽 `tsconfig`（禁 `any` 兜底）；④ `src/renderer/js/` 遗留目录行数不变（明确不碰） |
| **L4 全局单例治理（context/approvedDirs/electron 直取）** | `main/context.js`(57)、`main/approvedDirs.js`(168)、`main/permissions.js`(96)、`main/taskbarProgress.js`(70)、`main/index.js`(556 装配)、其余 7 个「路径/版本小注入」文件 | 4.0 | **高** | 不可与 L2 并行（同改 `index.js`） | L2 完成后再收口 | ① `context.getCtx()` 的 10 处调用降为构造注入；② `main/index.js` ≤ 400 行；③ 直取 electron 文件从 25 降至仅外壳集合（12）；④ 启动/退出落盘链路 `queue-resume.test.js`、`play-queue-*.test.js` 全绿 |

合计预估 **19 人日**（L1 2.5 + L2 6.5 + L3 6.0 + L4 4.0），为**估算值**，非实测。

依赖与冲突要点：

- L1 独占 `ipcContract.js`，是唯一**零冲突**起点。
- L2 与 L4 都动 `src/main/index.js` 的装配段（L2 改 `createDownloadQueueEngine` 注入、L4 改 `context.init`），**必须串行**。
- L3 与三者文件集不重叠，可全程并行，但类型生成需等 L1 的 object schema。
- `statemachine.js` 归属 L2 决策（收敛为唯一实现）。

---

## 六、里程碑切分

### M1.0 试点（最小可验收垂直切片）

**目标**：用最小面积验证「契约 schema + 端口注入 + 单测」三件套模板，验证周期 1 周内。

- 试点对象（选面积小、边界清晰的下载域边缘）：
  - `src/main/ipc/downloadTemplates.js`（132 行）
  - `src/utils/downloadPath.js`（104 行，同时消 `utils → main/approvedDirs` 反向依赖）
  - `src/shared/downloadDefaults.js` + 契约中 5 条 `*-download-template` 通道
  - L1 的 `obj` schema 骨架（`save-download-template.template` 先做样板）
- **退出条件**：
  1. `save-download-template` 的 `template` 具备字段级 schema，非法字段被拒且有单测；
  2. `downloadTemplates`/`downloadPath` 无 `require('electron')`，`app.getPath('music')` 变为注入；
  3. `downloadTemplatePreview.test.js`、`download-path.test.js`、`download-path-symlink.test.js`、`downloadDefaults.test.js` 全绿；
  4. 产出「新增 domain 模块 checklist」（供 L2 复用）。

### M1.0 实测结果（2026-11-07）

**1. downloadTemplates 去 electron（改为端口注入）**

- `src/main/ipc/downloadTemplates.js` 已无 `require('electron')`。
- 改为 `configureDownloadTemplates({ getMusicDir })` 接收注入，由组装根 `src/main/index.js` 传入 `app.getPath('music')`。
- 注入缺失时回退空串，行为与改前一致。

**2. realpath 判据下沉到 utils**

- 新增 `src/utils/realpathContain.js`，只 `require` `path` / `fs`，承载 `normalize` / `isInside` / `realpathDeep` / `isInsideReal` / `isInsideRealAny`。
- `src/main/approvedDirs.js` 改为 `require('../utils/realpathContain')` 并原样 re-export，对外 8 个导出不变。
- `src/utils/downloadPath.js` 改为 `require('./realpathContain')`，`utils → main` 反向依赖消除。
- `test/download-path-symlink.test.js` 的接线钉从「必须 require main」改为「必须 require utils 同源判据」，并新增「`realpathContain` 只 require node 内置模块」断言。

**3. 契约 schema 样板（`t.shape`）**

- `src/shared/ipcContract.js` 新增 `t.shape` 原语：字段白名单 + 必填校验 + 只判不转。
- 仅用于 `save-download-template` 的 `template` 参数。
- 其余 18 个 `t.obj()` 通道行为未变。

**4. 回归证据（2026-11-07）**

- download 子集 63/63 通过。
- `test/download*.test.js` 122/122 通过。
- `node scripts/test-stable.cjs`：350/350 文件通过，fail 0，未执行 0。
- `npm run typecheck` exit 0。
- `npm run lint` exit 0（保留 6 条历史 warning）。
- `npm run build` exit 0，`dist/renderer/index.html` 与 `dist/renderer-legacy/index.html` 均产出。

**5. 遗留（归 M1.1）**

- M1.0 只覆盖下载域边缘。
- `downloadQueue.js` 主体、`context.getCtx()` 端口化、UI 推送（`safeSend` / `notifier`）剥离均未动，归 M1.1。

### M1.1 下载域主体迁出

**目标**：把 742 行引擎与 4 个 IPC 分片整体迁为 `domain/download`，切断 UI/托盘/electron 直连。

- 范围：L2 全量 + L4 的 `context` 端口化（先做下载相关 6 个 getter）。
- **退出条件**：
  1. `downloadQueue.js` 拆为「状态机 / 调度 / 落盘 / 命名」4 个 ≤300 行模块；
  2. 引擎内 `safeSend`/`notifier`/`onQueueChanged` 全部经 Port，`grep safeSend src/main/downloadQueue.js` = 0；
  3. `statemachine.js` 二选一收敛（删除或接入），且仅存在一处状态迁移真相；
  4. `index.js` ≤ 450 行，装配段只做 wiring；
  5. 下载/队列/取流相关测试全绿（见 L2 验收断言）+ 手工冒烟：入队→暂停→重启恢复→取消。

#### M1.1 实测结果（2026-11-07）

- **状态机收敛**：`downloadQueue.js` 已接入 `statemachine`，状态迁移统一走唯一出口 `applyStatus`；此前「重试轮次回到 `downloading`」会绕过状态机的缺口已闭合，重试路径不再直接改状态字段。
- **Port 剥离（M1.1-B）**：`downloadQueue.js` 内 `safeSend` / Electron `Notification` / `shell.` 均 0 命中；ProgressPort（`emitQueueUpdated`/`emitProgress`/`emitError`）与 NotifyPort（`downloadDone`/`showInFolder`）的实现落在 `src/main/index.js` 装配层；`guardPort` 保证端口抛错不污染队列状态（对抗性探针：注入全部方法抛错的端口仍完成下载，仅打印告警）。
- **context 注入（M1.1-C）**：`src/main/ipc/download/queue.js` 的 9 处 `getCtx()` 降为 0，改为 `register(queueDeps)` 构造注入；`require('../../context')` 已删除；缺 deps 时构造期 fail-fast。
- **验收数字**：queue 子集 136/136、play-queue 16/16、`test-stable` 350/350 文件 / 3553 用例 / fail 0 / 未执行 0、typecheck exit 0、lint 0 error + 6 条既有 warning、build 双轨产物齐全。
- **行数事实与拆分缺口**：`downloadQueue.js` 已从 742 行增至实测 **953 行**（非空 902 行，其中注释 321 行、空行 51 行），接入状态机与 Port 带来净增；M1 验收目标「单文件 ≤800 行」在 M1.1 结束时**未达成**，**已于 M1.2 达成（395 行）**——拆分结果见下方 `#### M1.2 引擎拆分完成（2026-11-07）`。

#### M1.2 引擎拆分完成（2026-11-07）

> 本小节收口 M1.1 遗留的「单文件 ≤800 行」缺口：把 `src/main/downloadQueue.js` 的单曲流水线按 ADR 0003 §8.1 的 12 个 phase 拆到 `src/main/downloadQueue/`。它与下方「M1.2 渲染层 TS 与域边界收尾」是两条独立工作流，只是沿用了任务书的里程碑编号。

- **行数**：`downloadQueue.js` **956 → 395** 物理行（有效代码 581 → 164），拆分后空行 25、纯注释 206。「单文件 ≤800 行」**已达成**，余量 405 行。（M1.1 段记录的 953 为不同取样时点；ADR 0003 §0.1 的实测基线为 956，本行以其为准。）
- **7 个子模块**（`src/main/downloadQueue/`，物理行 / 有效行）：

  | 模块 | 物理行 / 有效行 | 职责 |
  |---|---|---|
  | `naming.js` | 20 / 6 | 文件名与扩展名清洗、模板渲染 |
  | `persist.js` | 220 / 125 | 队列落盘/恢复、`sanitizeRestoredTask`、24h stale pending |
  | `ports.js` | 38 / 16 | `guardPort` / `noopNotifyPort` 端口防御 |
  | `store.js` | 74 / 25 | 队列数组唯一持有者 + `applyStatus` 迁移出口 |
  | `scheduler.js` | 290 / 157 | 并发钳制、500ms 退避、`stop()` 清定时器 |
  | `events.js` | 184 / 64 | `notifyQueueChanged` 防抖、进度 120ms 节流、`emitError` |
  | `songTask.js` | 627 / 388 | 单曲流水线：12 个 phase 顺序编排 |

- **12 个 phase 粒度**：`songTask.js` 内 `initContext` / `startAttempt` / `applyPolicyPhase` / `resolveStream` / `preparePaths` / `checkDiskSpace` / `transferFile` / `handlePostTransferAbort` / `finalizeLyrics` / `finishSuccess` / `handleAttemptFailure` / `finalizeFailure` **12 个全部存在**，有效行均 ≤40（最大 `resolveStream` = 26，其次 `finalizeFailure` = 25、`preparePaths` = 23）。
- **验收数字**：队列子集 **138/138**；`node scripts/test-stable.cjs` **350 文件 / 3555 用例 / fail 0 / flaky 0**；`npm run typecheck` exit 0；`npm run lint` **0 error** + 6 条历史 warning（未新增）。
- **行为等价探针**：403/404/410 → `attempts=3` 重试；500 / 断网 → `attempts=1` 直接 error；`fatal=true` → 下载器 0 调用且不消耗配额；用户取消 → 终态 error「下载已取消」且后续 phase 零调用；进度 100% 必发；`dispose()` 后 Timeout 0；`getQueue()` 数组身份恒等。
- **遗留观察（非本次引入）**：取消后**迟到**的 `onProgress` 仍会覆盖 `progress`（30 → 80）；用 `git HEAD` 拆分前版本做差分复现，行为相同，记为待办，不计本次回归。

#### M1.2 渲染层 TS 完成（2026-11-08）

> 本小节收口下文 `### M1.2 渲染层 TS 与域边界收尾` 的**第 1 条**退出条件（`typecheck:renderer` = 0 error）。分批拆解与收敛顺序见 [`M1-TS-STRICT-BASELINE.md`](./M1-TS-STRICT-BASELINE.md) §3，逐步实测证据见 [`M1.2-FINAL-VERIFY.md`](./M1.2-FINAL-VERIFY.md)。

- **B1 `core/` 8 文件**：错误 **83 → 0**。新增 `src/renderer/app/core/env.d.ts`，声明 `window.musicAPI`（全局桥类型出口），使 `core/bridge` 不再依赖隐式全局。
- **B2 `stores/` 9 文件 + `stores/types.ts`**：错误 **295 → 0**。新增 `stores/types.ts` 收敛跨 store 共享的 state 与 DTO 类型。
- **B3 `components/` 15 个 `.vue`**：错误 **78 → 0**。全部改为 `<script setup lang="ts">`；**7 处模板适配**已逐条记录（仅对齐类型，不改运行时行为）。
- **B4 `views/` 9 + `App.vue` + `main.ts`/`player.ts`**：错误 **67 → 0**。
- **全仓 `typecheck:renderer` 演进**：703 → 630 → 150 → 67 → **0**（703 为历史引用基线，630 / 150 / 67 为分批收敛的实测中间值）。
- **反向验证（证明门禁真的会红）**：注入 `const __probe_ci: number = 'x';` → `typecheck:renderer` **exit 2** 并报 `TS2322`；删除注入后回到 **exit 0**；被注入文件 SHA256 与注入前**完全一致**（无残留）。
- **CI 门禁转硬**：`.github/workflows/ci.yml:62` 步骤改名为 `Typecheck (Renderer)`，`continue-on-error` **已删除**——该步骤失败即整条流水线变红。
- **验收数字**：`node scripts/test-stable.cjs` **350 文件 / 3555 用例 / fail 0 / flaky 0**；`npm run lint` **0 error** + 6 条历史 warning（未新增）；`npm run build` exit 0，产出 **936 B** 的 `dist/renderer/index.html`。
- **编码扫描**：46 个 `.vue` / `.ts` / `.js` 源文件，**BOM 0、U+FFFD 0**。
- **仍未收口（不在本小节范围）**：下文退出条件第 2–5 条（由契约生成 `bridge` 类型、electron 直取 ≤12、未映射 24 通道豁免白名单、`src/renderer/js/` 冻结并给出删除里程碑）**均未完成**，故 **M1.2 整体仍不得标记为完成**。

### M1.2 渲染层 TS 与域边界收尾

**目标**：渲染层 44 文件 / 6324 行完成 TS 化，并交付可用于前端的 IPC 类型；清理剩余 electron 直取。

- 范围：L3 全量 + L1 剩余 14 个 `obj` schema + L4 剩余项。
- **退出条件**：
  1. `npm run typecheck:renderer` = 0 error（`strict` 未放宽），44 文件全部 TS；
  2. 渲染层通过 `core/bridge.js` 获得**由契约生成的**方法签名，不再手写 `window.musicAPI` 形状；
  3. 直取 `require('electron')` 文件数 ≤ 12（仅外壳集合），且清单写回本文档附录；
  4. `ipc-contract.test.js` 中「未映射 24 通道」改为显式豁免白名单，新增通道漏声明即失败；
  5. `src/renderer/js/`（172 文件 / 28949 行）保持冻结（不新增引用），并给出后续删除里程碑编号。

---

## 附录：所用命令

```powershell
# 1) 主进程行数（前 30）
Get-ChildItem src\main -Recurse -File -Filter *.js | ForEach-Object { [pscustomobject]@{Lines=(Get-Content $_.FullName).Count; Path=$_.FullName.Replace("$PWD\","")} } | Sort-Object Lines -Descending | Select-Object -First 30 | Format-Table -AutoSize

# 1b) 主进程文件类型与总量
Get-ChildItem src\main -Recurse -File | Group-Object Extension | Select-Object Name,Count | Format-Table -AutoSize
Get-ChildItem src\main -Recurse -File -Filter *.js | ForEach-Object { (Get-Content $_.FullName).Count } | Measure-Object -Sum -Average

# 2) 渲染层按目录分组
Get-ChildItem src\renderer\app -Recurse -File -Include *.js,*.vue | ForEach-Object { [pscustomobject]@{Lines=(Get-Content $_.FullName).Count; Dir=($_.DirectoryName.Replace("$PWD\src\renderer\app\","")); Name=$_.Name} } | Group-Object Dir | ForEach-Object { [pscustomobject]@{Dir=$_.Name; Files=$_.Count; Lines=($_.Group | Measure-Object Lines -Sum).Sum} } | Sort-Object Lines -Descending | Format-Table -AutoSize

# 2b) 渲染层单文件行数 + 遗留渲染层体量
Get-ChildItem src\renderer\app -Recurse -File -Include *.js,*.vue | ForEach-Object { [pscustomobject]@{Lines=(Get-Content $_.FullName).Count; Path=$_.FullName.Replace("$PWD\src\renderer\app\","")} } | Sort-Object Lines -Descending | Format-Table -AutoSize
Get-ChildItem src\renderer\js -Recurse -File -Filter *.js | ForEach-Object { (Get-Content $_.FullName).Count } | Measure-Object -Sum -Average -Maximum

# 3) electron 依赖（含子目录、含内联 require）
Get-ChildItem src\main -Recurse -File -Filter *.js | Select-String -Pattern "require\('electron'\)" | ForEach-Object { [pscustomobject]@{File=$_.Path.Replace("$PWD\",""); Line=$_.LineNumber; Text=$_.Line.Trim()} } | Format-Table -AutoSize -Wrap

# 4) 契约数量（静态读取导出对象，不执行业务逻辑）
node -e "const c=require('./src/shared/ipcContract.js');const ch=c.CHANNELS;const ks=Object.keys(ch);const specStat={};ks.forEach(k=>(ch[k].args||[]).forEach(([,s])=>{specStat[s.k]=(specStat[s.k]||0)+1;}));console.log(JSON.stringify({channels:ks.length,invoke:ks.filter(k=>ch[k].invoke).length,send:ks.filter(k=>ch[k].send).length,receive:ks.filter(k=>ch[k].receive).length,methods:Object.keys(c.METHODS).length,events:Object.keys(c.EVENTS).length,withArgs:ks.filter(k=>Array.isArray(ch[k].args)).length,spec:specStat}));"
node -e "const c=require('./src/shared/ipcContract.js');const ch=c.CHANNELS;const mapped=new Set([...Object.values(c.METHODS),...Object.values(c.EVENTS)]);console.log(Object.keys(ch).filter(k=>!mapped.has(k)).join(','));"

# 5) 下载耦合边
Get-ChildItem src\main -Recurse -File -Filter *.js | Select-String -Pattern "download" -List | Select-Object -ExpandProperty Path
Get-ChildItem src\main -Recurse -File -Filter *.js | ForEach-Object { $f=$_.FullName.Replace("$PWD\",""); Select-String -Path $_.FullName -Pattern "require\(['""]([^'""]+)['""]\)" -AllMatches | ForEach-Object { $_.Matches | ForEach-Object { [pscustomobject]@{From=$f; To=$_.Groups[1].Value} } } } | Where-Object { $_.To -match 'download|playCache|stream|subscription|approvedDirs|diskSpace|qualityPolicy|queueOrder|taskbar|context' } | Sort-Object From | Format-Table -AutoSize
Select-String -Path src\main\downloadQueue.js -Pattern "notify|safeSend|onQueueChanged|notifier" | Select-Object LineNumber,Line
Select-String -Path src\main\index.js -Pattern "createDownloadQueueEngine" -Context 0,30
Select-String -Path src\**\*.js,test\*.js -Pattern "statemachine"

# 6) 工具链
Select-String -Path tsconfig.renderer.json -Pattern '.'
Select-String -Path package.json -Pattern 'typescript|vue-tsc|typecheck|"test"|"lint"|"build"'
Get-ChildItem test -File | Where-Object { $_.Name -match 'download|queue|stream|play' }
```

> 说明：全程未执行任何写操作（除本文件），未运行 `npm run typecheck*`，故 1.3 节的「当前 error 数」标注为待实测。
