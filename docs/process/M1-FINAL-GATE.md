# M1 最终验收记录（M1-FINAL-GATE）

> 独立验收子代理产出。**不采信任何历史文档结论**，以下所有数字均为本次实跑结果。
> 验收期间未修改任何源码；本文件是唯一写出的文件。

---

## 1. 验收环境与仓库状态

| 项 | 值 |
| --- | --- |
| 验收时间 | 2026-11-08 23:24:36 +08:00 |
| 仓库 HEAD | `c779429`（`chore(release): v1.0.38`） |
| 平台 / Shell | Windows / PowerShell |
| Node | v24.15.0（`package.json` engines 要求 >=22） |
| 工作区 | **不干净**，`git status --porcelain` 共 **97** 条 |

工作区明细：`modified=56`、`untracked=40`、`added=0`、`deleted=0`。

结构性事实（决定后续判定的关键前提）：
- 本次改造新增的分层目录 **全部处于 untracked 状态**：`src/main/ipc/library/domain/`、`src/main/ipc/library/infra/`、`src/main/ipc/playlist/`、`src/main/ipc/search/`、`src/main/ipc/subscriptions/`。
- 因此 `HEAD=c779429` 指向的提交里**不存在**这套三层结构，验收对象是"工作树 + 未提交文件"，而非某个可复现的 commit。

---

## 2. 九项门禁结果表

| # | 门禁命令 | 退出码 | 关键输出摘要 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `node scripts/test-stable.cjs` | **1** | 文件 351 / pass 341 / **fail 10** / 超时 0 / flaky 0 / 启动错误 0；用例级 pass=3506 **fail=10**；耗时 1m39s | ❌ FAIL |
| 2 | `npm run typecheck` | 0 | `tsc -p tsconfig.json --noEmit`，0 error | ✅ PASS |
| 3 | `npm run typecheck:renderer` | 0 | `vue-tsc -p tsconfig.renderer.json --noEmit`，0 error | ✅ PASS |
| 4 | `npm run lint` | **1** | `✖ 23 problems (1 error, 22 warnings)`；唯一 error：`src/main/ipc/subscriptions/infra/queue.js:43` `'findDownloadedAsync' is not defined  no-undef` | ❌ FAIL |
| 5 | `npm run build` | 0 | `[postbuild] done`，`copied: src/main/ipc -> dist/main/ipc` 等全量拷贝成功 | ✅ PASS |
| 6 | `npm run smoke:asar` | 0 | `18/18 通过`（asar 含全部 8 个平台模块、`installRejectionGuard`、双渲染层入口、生产依赖树 249 包无缺失） | ✅ PASS |
| 7 | 补充门禁 `node --test` 8 个文件 | 0 | `tests 96 / pass 96 / fail 0 / duration 1074ms` | ✅ PASS |
| 8 | `node --check src\main\index.js` | 0 | 无输出（语法通过） | ✅ PASS |
| 9 | 装配层运行时可达性（本代理追加的必查项，见 §4.3） | **1** | 51 个新分层文件实加载：OK 39 / **FAIL 12**，全部 `MODULE_NOT_FOUND` | ❌ FAIL |

> 门禁 5 与 6 虽然绿，但二者都是**静态**检查（拷贝 / 文件存在性 / 字符串锚点），不执行模块 `require` 图，因此**无法覆盖**门禁 9 暴露的启动期崩溃。这一点是本轮验收最重要的结论。

---

## 3. 失败项逐条定性（含原始报文）

### 3.1 【阻断级 · 源码】新分层 infra 层 12 个文件 `require` 路径深度错误，应用**无法启动**

`src/main/index.js` 在装配阶段执行：

```js
601: ipcSearch.register({ domain: searchDomain, infra: createSearchInfra() });
617: ipcPlaylist.register({ domain: playlistDomain, infra: createPlaylistInfra() });
619: ipcLibrary.register();
```

三者都会在 `require` 阶段抛错。实跑证据：

```
src\main\ipc\library\infra\approvedDirs.js   | MODULE_NOT_FOUND | Cannot find module '../../../../approvedDirs'
src\main\ipc\playlist\infra\api.js           | MODULE_NOT_FOUND | Cannot find module '../../../utils/crossSourceAggregate'
src\main\ipc\playlist\infra\cookie.js        | MODULE_NOT_FOUND | Cannot find module '../../utils/cookieStore'
src\main\ipc\playlist\infra\index.js         | MODULE_NOT_FOUND | Cannot find module '../../utils/prefs'
src\main\ipc\playlist\infra\prefs.js         | MODULE_NOT_FOUND | Cannot find module '../../utils/prefs'
src\main\ipc\playlist\infra\trash.js         | MODULE_NOT_FOUND | Cannot find module '../../../utils/playlistTrash'
src\main\ipc\search\infra\ai.js              | MODULE_NOT_FOUND | Cannot find module '../../../api/ai-music'
src\main\ipc\search\infra\api.js             | MODULE_NOT_FOUND | Cannot find module '../../../api'
src\main\ipc\search\infra\cookie.js          | MODULE_NOT_FOUND | Cannot find module '../../../utils/cookieStore'
src\main\ipc\search\infra\index.js           | MODULE_NOT_FOUND | Cannot find module '../../../api'
src\main\ipc\search\infra\logger.js          | MODULE_NOT_FOUND | Cannot find module '../../../utils/logger'
src\main\ipc\search\infra\prefs.js           | MODULE_NOT_FOUND | Cannot find module '../../../utils/prefs'
```

直接调用 `library.register()` 的原样输出：

```
[PluginRegistry] ... 8 个平台加载完成
REGISTER_FAIL|MODULE_NOT_FOUND|Cannot find module '../../../../approvedDirs'
```

**根因（源码）**：`infra/*.js` 位于 `src/main/ipc/<domain>/infra/`，距 `src/` 需要 **4 层上溯**（`infra → <domain> → ipc → main → src`），但多数文件按 **2～3 层** 书写；`library/infra/approvedDirs.js` 则相反（目标 `src/main/approvedDirs.js` 只需 3 层，却写了 4 层）。属系统性深度错位，非个别笔误。

**后果**：`library` / `playlist` / `search` 三个域在装配期即抛异常，主进程起不来。`subscriptions` 域 infra 可加载（因 queue.js 等使用 4 层正确写法），但不能抵消上述三域。

**注意**：`src/main/ipc/library.js:32` 的 `require('./library/infra/approvedDirs')` 写在 `register()` 函数体内（惰性），故 `require('src/main/ipc/library')` 本身成功，**掩盖**了故障，直到真正 `register()` 才爆。`dist/main/ipc/library/infra/approvedDirs.js` 同样加载失败，说明打包产物同样不可用。

---

### 3.2 【高 · 源码】`subscriptions/infra/queue.js` 使用未声明的 `findDownloadedAsync`（门禁 4 唯一 error）

原始报文：

```
F:\新建文件夹\Lanyue\src\main\ipc\subscriptions\infra\queue.js
  43:15  error  'findDownloadedAsync' is not defined  no-undef
```

`queue.js` 全文只有一条 import：

```js
const logger = require('../../../../utils/logger');
```

而 `autoEnqueue()` 第 43 行直接调用 `await findDownloadedAsync(song.id, song.source)`。该函数确实存在于 `src/utils/history.js:314` 并已导出（`:553`），**只是没有引入**。

**行为影响**：进入 `autoEnqueue` 且未被 `inQueue` 短路时，运行时抛 `ReferenceError`，订阅自动下载会中断。**根因：源码**（搬迁时漏了 import）。修复方向：补 `const { findDownloadedAsync } = require('../../../../utils/history');` 或经 `deps` 注入（该文件已按 deps 注入风格设计，注入更符合分层约定）。

---

### 3.3 【中 · 测试】4 个用例仍按旧签名调用 `ipcPlaylist.register()`

失败用例与原始报文：

| 文件 | 原始报文 |
| --- | --- |
| `test/favorites.test.js` | `Error: playlist.register: 缺少 domain` |
| `test/playlist-trash.test.js` | `Error: playlist.register: 缺少 domain` |
| `test/mcp-e2e.test.js` | `Error: playlist.register: 缺少 domain` |
| `test/crossSourceAggregate-primary.test.js` | `Error: playlist.register: 缺少 domain` |

`favorites.test.js:40`、`playlist-trash.test.js:166/252` 均为 `ipcPlaylist.register();`（无参）。新实现 `src/main/ipc/playlist.js` 顶部强制校验：

```js
if (!domain) throw new Error('playlist.register: 缺少 domain');
if (!infra) throw new Error('playlist.register: 缺少 infra');
```

**根因：测试**（fixture 未跟进注入式签名）。但**不构成源码无缺陷的证明**：即便补好 fixture，`playlist/infra` 仍因 §3.1 加载失败，测试无法转为绿。

---

### 3.4 【中 · 测试】5 个静态"源码锚点"测试指向已搬迁的旧文件位置

| 文件 | 失败用例 | 原始报文要点 |
| --- | --- | --- |
| `test/ab-clip.test.js:208` | 接线：菜单项 / 面板入口 / 主进程透传 / 零新通道 全齐 | `AssertionError: 主进程未透传起点`；`expected: /start: clip ? clip.start : null/`，`actual` 为现行 `library/convert.js` 全文（已瘦身为纯委托层） |
| `test/reconcile-renames.test.js:147` | 接线：扫描成功后对账并如实上报 | `AssertionError: 没引对账函数`；`expected: /require\('\.\.\/\.\.\/\.\.\/utils\/fileRelink'\)/`，`actual` 为现行 `library/scan.js` 全文 |
| `test/relink-refs.test.js:215` | 接线：rename-file 成功后必走 relink | `AssertionError: rename-file 没接回写`，`actual: false`；断言要求 `library/files.js` 的 `handle('rename-file')` 块内出现 `relinkFileRefs(` |
| `test/crossSourceAggregate-truncation.test.js` | 平台歌单取数用的是共享常量，与聚合判据同源 | `AssertionError: 取数上限须引用 SOURCE_FETCH_LIMIT...`；`expected: /getPlaylistSongs\(\s*platformIdOf\(source\)\s*,\s*playlistId\s*,\s*SOURCE_FETCH_LIMIT\s*\)/`，`actual` 为现行 `ipc/playlist.js` 全文 |
| `test/crossSourceAggregate-wiring.test.js:103` | 主进程：playlist 模块确实被装载 | `AssertionError: main/index.js 应调用 ipcPlaylist.register()`；`expected: /ipcPlaylist\.register\(\)/` |

**逐条核对结论（行为是否真丢失）——均未丢失，只是内联到了别处：**

- 起点透传：`src/main/ipc/library/domain/convert.js:67-68`
  ```js
  start: clip ? clip.start : null,
  end:   clip ? clip.end : null,
  ```
  → 断言锚点应改指向 `library/domain/convert.js`。
- 对账接线：`src/main/ipc/library/domain/scan.js:32` / `:55` 调用 `fileRelink.reconcileScannedRefs(...)`，`fileRelink` 由 `library.js:36-43` 注入；扫描返回值仍带 `relinked`。→ 功能在，静态 `require` 断言失效。
- rename 回写：`src/main/ipc/library/domain/files.js:27`
  ```js
  relinkResult = await relink.relinkFileRefs(oldPath, newPath);
  ```
  `:31` 返回 `{ success: true, relink: relinkResult }`；IPC 层 `library/files.js` 已瘦身为 `return await files.renameFile(oldPath, newPath);`。→ 功能在，测试却仍在 IPC 层找字面量（且测试自己写明"文件操作域拆到 library/files.js"，未同步到新的 domain 位置）。
- 取数上限：`src/main/ipc/playlist/infra/api.js:17-18`
  ```js
  const { getPlaylistSongs } = require('../../../api');
  const r = await getPlaylistSongs(platformIdOf(source), playlistId, SOURCE_FETCH_LIMIT);
  ```
  → `SOURCE_FETCH_LIMIT` 确实被传给取数接口，与聚合判据 `crossSourceAggregate.js:187` 同源；测试锚点却读 `ipc/playlist.js`（该文件只做 `fetched[src] = SOURCE_FETCH_LIMIT` 登记）。
- playlist 装载：`src/main/index.js:617` 为 `ipcPlaylist.register({ domain: playlistDomain, infra: createPlaylistInfra() })`，与 `/ipcPlaylist\.register\(\)/` 不匹配（有实参）。→ 装载在，断言写法过期。

**根因：测试**（架构重构未同步静态锚点）。这也说明重构缺少"同步更新测试"的收尾，属流程缺陷而非单纯偶发。

---

### 3.5 环境 flake 判定

`test-stable` 已内置"失败文件单文件串行重跑一次"机制，10 个失败文件全部重跑仍 fail（`首跑 fail → 重跑仍 fail`），`flaky:0`。**排除环境 flake**，均为确定性失败。

---

## 4. 装配层取证

### 4.1 register 调用完整性：20/20 齐备

`Select-String -Path 'src\main\index.js' -Pattern '\.register\('` 命中 **20** 处：

```
598: ipcWindow.register();
601: ipcSearch.register({ domain: searchDomain, infra: createSearchInfra() });
604: ipcDownload.register({
617: ipcPlaylist.register({ domain: playlistDomain, infra: createPlaylistInfra() });
618: ipcCookie.register();
619: ipcLibrary.register();
620: ipcPrefs.register();
621: ipcCheckLocal.register();
622: ipcHistory.register();
623: ipcAiMusic.register();
625: ipcSongStory.register();
627: ipcProvider.register();
629: ipcDownloadTemplates.register({ getMusicDir: () => app.getPath('music') });
630: ipcCloudSync.register();
642: ipcSubscriptions.register({
650: ipcMcp.register();
655: ipcAssistant.register();
658: ipcSmartPlaylist.register();
661: ipcTasteProfile.register();
664: ipcPlaylistAudit.register();
```

**编码事故未造成调用点丢失**（数量与分工完整），但 `601/617` 的实参本身不可用（§3.1）。

### 4.2 注入式接线逐条

| 域 | 域对象 | infra 工厂 | 装配位置 | 实参可用性 |
| --- | --- | --- | --- | --- |
| search | `require('./ipc/search/domain')` | `createSearchInfra()` | `:599-601` | ❌ infra 加载失败 |
| playlist | `require('./ipc/playlist/domain')` | `createPlaylistInfra()` | `:615-617` | ❌ infra 加载失败 |
| subscriptions | `subsDomain = ...createDomain({...})` | `subsInfra = ...createInfra({...})` | `:632-642` | ✅ 可加载，但 `register` 内部 `queue.js` 缺 `findDownloadedAsync`（§3.2） |
| library | 无显式 domain/infra 参数 | `ipcLibrary.register()` 内部惰性 require | `:619` | ❌ `library/infra/approvedDirs` 加载失败 |

### 4.3 新分层文件运行时可达性（决定性证据）

对 `src/main/ipc/{library,playlist,search,subscriptions}` 下全部 51 个 `.js` 逐个真实 `require`：

```
TOTAL 51  OK 39  FAIL 12
```

- **domain 层：全部 OK**
- **infra 层：library/playlist/search 全灭（12 个），subscriptions 存活**
- IPC 层薄壳（`library/*.js`、`playlist.js`、`search.js`）本身 OK

即：三层结构"形"已搭好（domain 纯逻辑可用），但 **infra 适配层是断的**，接不上真实 I/O。

### 4.4 编码合规：U+FFFD 0 命中

```
Select-String -Path 'src\main\index.js','src\main\ipc\playlist\infra\index.js' -Pattern ([char]0xFFFD) → count = 0
```

字节级复核（`TextDecoder('utf-8', { fatal: true })`，规避 PowerShell 控制台 GBK 误显示）：

| 文件 | BOM | U+FFFD | CRLF | 严格 UTF-8 |
| --- | --- | --- | --- | --- |
| `src/main/index.js` | 无 | 0 | 无 | 通过 |
| `src/main/ipc/playlist/infra/index.js` | 无 | 0 | 无 | 通过 |
| `src/main/ipc/search/infra/index.js` | 无 | 0 | 无 | 通过 |
| `src/main/ipc/library/infra/approvedDirs.js` | 无 | 0 | 无 | 通过 |

全仓扩展体检（`src` + `test` + `scripts` + `docs`，排除 `node_modules/.git/dist/.preview`，共 **852** 个 `js/cjs/mjs/vue/json/md`）：

```
files scanned 852   U+FFFD total 0   problem files 0
```

→ **112 行回填后无乱码残留，控制台里的"锟斤拷型"乱码纯属 PowerShell 默认 GBK 渲染，文件本身干净。**

### 4.5 安全护栏 / 关键机制仍在位

| 机制 | 位置 | 状态 |
| --- | --- | --- |
| 权限护栏（session-created + defaultSession） | `:75`、`:371` | ✅ |
| crashReporter 于 app ready 之前初始化 | `:68` | ✅ |
| 全局未捕获拒绝归口 | `:79` | ✅ |
| `sandbox: true` | `:240` | ✅ |
| IPC 契约经 argv 注入 `additionalArguments` | `:244` | ✅ |
| `LY_RENDERER_DIR` 穷举白名单 + realpath 防逃逸 | `:156`、`:186-221` | ✅ |
| `downloadProgressPort` 模块级单实例（引擎 + 队列 IPC 复用） | `:113`、`:435`、`:612` | ✅ |

### 4.6 dataMigration 接线（备份 v3）

| 项 | 证据 |
| --- | --- |
| 模块存在 | `src/utils/dataMigration.js` |
| schema 版本 | `dataMigration.js:22` `const BACKUP_SCHEMA_VERSION = 3;` |
| prefs 接线 | `src/utils/prefs.js:26` `const { migratePrefs } = require('./dataMigration');` |
| cloudSync 接线 | `src/main/ipc/cloudSync.js:21` `const { BACKUP_SCHEMA_VERSION, migrateBackup } = require('../../utils/dataMigration');`；`:95` `version: BACKUP_SCHEMA_VERSION` |
| 迁移函数 | `migratePrefs`（`:100`）、`migrateBackup`（`:201`） |
| 行为验证 | 门禁 7 内 `data-migration.test.js` 通过 |

→ 备份 v3 接线完整，且是本次改动中**唯一经真实行为测试并全绿**的新增能力。

---

## 5. 结论

**VERDICT: FAIL**

判定依据（按严重度）：

1. **阻断**：应用无法启动。`library` / `playlist` / `search` 三个域的 `infra` 层共 12 个文件 `require` 路径深度错误，装配期即 `MODULE_NOT_FOUND`。门禁 5/6 为静态检查，未能拦截。
2. **高**：`subscriptions/infra/queue.js` 漏 import `findDownloadedAsync`，订阅自动下载运行期必崩；这是门禁 4 的唯一 error。
3. **中**：10 个测试失败分两类——4 个 fixture 未跟进注入式签名，5 个静态锚点指向已搬迁文件（行为经核对均未丢失）。测试未随重构同步，属收尾缺失。
4. **已排除**：环境 flake（10 个失败文件重跑仍 fail，flaky=0）、编码事故残留（852 文件 U+FFFD=0、无 BOM、严格 UTF-8 通过）、调用点丢失（20/20 register 齐备）、安全护栏退化（7 项全部在位）。

**"9 项门禁"中 6 绿 3 红**（红：1、4、9）。即便只按任务清单看，也是 6/8 通过；而追加的门禁 9 揭示了比清单更严重的启动阻断问题。

修复后必须重跑全部九项——特别是门禁 9（模块可达性）应固化为常规门禁：`build` 与 `smoke:asar` 无法替代它。

---

## 6. 未覆盖 / 未验证项

- 未做真实 Electron 进程启动验证（环境无 GUI 会话），启动阻断结论由模块 `require` 图推得，非端到端复现。
- 未验证 `npm run package` 产物（`smoke:asar` 使用的是 `.preview/release-smoke` 下既有 app.asar，脚本自身已声明 "app.asar 早于 src/ 最新改动 ⇒ 改判工作树 dist/"）；发布包级别结论未闭环。
- 未覆盖 `check:attack-surface` / `check:dead-deps` / `check:icons` / `audit:deps`（不在本次清单内，属 `npm run verify` 扩展项）。
- 未验证渲染层实际 UI 行为、播放链路、下载链路等需要运行时的路径。
- 未评审代码风格/设计是否符合 ADR（仅做门禁与装配取证，不做架构评审）。
- 未确认 40 个 untracked 文件中是否有本不该入库的临时物（如 `fix_cookie.py`、`concept/`、`.opencode/`），按只读约束未做清理建议之外的判断。
- `lint` 的 22 个 warning 未逐一评估（`search/domain/*.js` 的 `validateKeyword` 未使用、`subscriptions.js` 的 `PREFS_KEY`/`TYPES`/`domainIsDue` 未使用等），可能暗示搬迁后残留死代码，未深入。

---

## 7. 复验（第二轮）

> 复验时间 2026-11-08 23:33–23:52 +08:00；HEAD 仍为 `c779429`，`git status --porcelain` **107** 条（上一轮 97 条）。
> 规则同上：**不采信任何"已修复"声明**，全部数字为本轮实跑。复验期间未改任何源码/测试，只写本文件。
> Node v24.15.0 / Windows / PowerShell。`npm` 的 `Unknown user config` 仅为 npmrc 提示，与门禁无关。

### 7.1 九项门禁实跑

| # | 门禁 | 命令 | 退出码 | 关键输出 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 全量稳定测试 | `node scripts/test-stable.cjs` | **1** | 文件 351 / pass 350 / **fail 1** / 超时 0 / flaky 0 / 启动错误 0；用例级 pass=3562 **fail=1**；耗时 1m31s。唯一红文件 `test\libraryIpc.integration.test.js`（首跑 fail → 串行重跑仍 fail ⇒ 保持红，**非 flake**） | ❌ FAIL |
| 2 | 主进程 typecheck | `npm run typecheck` | 0 | `tsc -p tsconfig.json --noEmit`，0 error | ✅ PASS |
| 3 | 渲染层 typecheck | `npm run typecheck:renderer` | 0 | `vue-tsc -p tsconfig.renderer.json --noEmit`，0 error | ✅ PASS |
| 4 | lint | `npm run lint` | 0 | `✖ 20 problems (0 errors, 20 warnings)`；上一轮唯一 error（`queue.js` `no-undef`）已消失 | ✅ PASS |
| 5 | 构建 | `npm run build` | 0 | `[postbuild] done`，全量拷贝成功 | ✅ PASS |
| 6 | asar 冒烟 | `npm run smoke:asar` | 0 | `18/18 通过`（8 平台模块、双渲染层入口、249 包依赖树无缺失） | ✅ PASS |
| 7 | 关键测试集（12 文件） | `node --test test/encoding-guard.test.js … test/crossSourceAggregate-wiring.test.js` | 0 | `tests 146 / pass 146 / fail 0 / duration 1151ms` | ✅ PASS |
| 8 | 主进程语法 | `node --check src\main\index.js` | 0 | 无输出 | ✅ PASS |
| 9 | 模块可达性 | 51 个新分层 `.js` 逐个 `require` | 0 | `TOTAL 51  OK 51  FAIL 0`（上一轮 39/12） | ✅ PASS（**但见 §7.3 的盲区**） |

### 7.2 三条对抗性验证（针对本轮声明的修复）

| # | 验证对象 | 方法 | 实测结果 | 结论 |
| --- | --- | --- | --- | --- |
| A | `subscriptions/infra/queue.js` 的 `findDownloadedAsync` | 读上下文 + 真实行为注入 | `:13 const history = require('../../../../utils/history');`；`:41 const findDownloadedAsync = deps.findDownloadedAsync \|\| history.findDownloadedAsync;`；`:47` 处使用。`typeof history.findDownloadedAsync === 'function'`。注入桩（`a1` 命中、`a2` 未命中）实跑：`queued=1`、`injected called=["a1/netease","a2/netease"]`、`queueIds=["a2"]` | ✅ 真修复（既有注入口，也有默认实现兜底；不是靠改 lint 规则掩盖） |
| B | `playlist.js` 的 `save-user-playlist` 陌生 id 分支 | 读代码 + 行为实跑（真 prefs + electron 打桩） | 代码路径 `:100-109`（`res.notFound` → 剔 `id` → 重走新建）。实跑 `{id:'pl_from_elsewhere', name:'imported-pl', songs:[1]}` ⇒ `SUCCESS=true NEW_ID=pl_1794152258452_32uas8 NAME=imported-pl RESTORED=undefined SONGS=1`，`IN_LIST=true`，`TRASH=undefined`。全仓（src+test）`trashNow` 命中 **0** | ✅ 真修复（旧行为复刻正确，且不再硬删） |
| C | `test/playlist-trash.test.js` 新锚点是否恒真 | 内存变异：把每个锚点命中的源码片段替换为 `/*MUTATED*/` 后重跑正则（**不落盘**） | `purgeExpired` / `trashRemove` / `trashView` / `trashPurge` / `infra/trash.js` 的 require 解构 → 变异后 **全部转假**；`trashRestore` 在 `playlist.js` 有 **2 处**真实调用点（撤销分支 + notFound 分支），删一处仍真、两处都删则转假 | ✅ 非恒真（但属**静态字面量**锚点：功能改成等价实现会误红，且写在注释里的同形文本会误绿；不构成行为证明） |

### 7.3 追加阻断发现：`src/main/ipc/library.js` 仍有 7 处 `require` 多上溯一层（门禁 1 唯一红项的真因）

门禁 1 唯一失败用例的原始报文（`node --test test/libraryIpc.integration.test.js`）：

```
Error: Cannot find module '../../../utils/libraryIndex'
Require stack:
- F:\新建文件夹\Lanyue\src\main\ipc\library.js
- F:\新建文件夹\Lanyue\test\libraryIpc.integration.test.js
    at Object.register (F:\新建文件夹\Lanyue\src\main\ipc\library.js:39:19)
code: 'MODULE_NOT_FOUND'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

直接调用装配入口的实跑（electron 打桩）：

```
LIBRARY_REGISTER_FAIL|MODULE_NOT_FOUND|Cannot find module '../../../utils/libraryIndex'
AT|Require stack: | - F:\新建文件夹\Lanyue\src\main\ipc\library.js
```

**这不是测试夹具过期**：`test/libraryIpc.integration.test.js:66` 的 `ipcLibrary.register();` 与 `src/main/index.js:619` 的调用形态完全一致（生产装配也无参），测试是对的，源码是错的。

出错行（`library.js`，`register()` 体内惰性 require）：

| 行 | 现写法 | 解析到 | 应为 |
| --- | --- | --- | --- |
| 39 | `../../../utils/libraryIndex` | `<repo>/utils/libraryIndex` ❌ | `../../utils/libraryIndex` |
| 41 / 60 / 78 | `../../../utils/logger` | `<repo>/utils/logger` ❌ | `../../utils/logger` |
| 66 | `../../../utils/audioConvert` | ❌ | `../../utils/audioConvert` |
| 77 | `../../../utils/dupScan` | ❌ | `../../utils/dupScan` |
| 79 | `../../../utils/audioProbe` | ❌ | `../../utils/audioProbe` |

对照同目录同类文件的正确写法：`src/main/ipc/prefs.js` 用的是 `require('../../utils/prefs')`、`require('../../utils/logger')`。

**判定链**：`library.register()` 在 `:39` 必抛 → `src/main/index.js:619 ipcLibrary.register()` 抛 → 装配函数 `registerAllIpcHandlers()` 中断，其后 `ipcPrefs` / `ipcHistory` / `ipcCloudSync` / `ipcSubscriptions` / `ipcMcp` 等 **13 个域全部不再注册**，主进程启动失败。**与上一轮 §3.1 同一类缺陷**，只是上一轮扫的是 `*/infra/`，漏了 `ipc/*.js` 薄壳本身。

**打包产物同病**：`dist/main/ipc/library.js` 第 39/41/60/66/77/78/79 行与源码逐字相同（build 只做拷贝，不校验解析），故 asar 内同样不可启动；门禁 5/6 依旧无法拦截。

### 7.4 门禁 9 的结构性盲区（本轮最重要的方法论结论）

门禁 9 本轮 `51/51 OK`，但应用**仍然起不来**。原因是门禁 9 只对文件做 `require`，而 `library.js` 的 7 处错路径写在 `register()` **函数体内**（惰性），`require('src/main/ipc/library')` 本身成功 → 假绿。

补充一条更强的、**零依赖、可固化**的门禁（本轮新增，实跑通过）：

```
# 静态解析 src 下全部相对 require（不执行模块，覆盖惰性分支）
FILES 371   RELATIVE_REQUIRES 521   UNRESOLVED 11
```

11 条未解析里只有 **7 条是真缺陷**（上表 `library.js`），其余为：
- `src/main/subscriptions.js:16`、`:319` —— 注释里提到旧路径（`require('../subscriptions')`），非代码；
- `src/utils/onlineLrc.js:5` —— 注释里的用法示例；
- `src/main/ipc/playlist.js:283` —— `try { require('./domain') } catch { }` 的**兼容再导出**：`src/main/ipc/domain` 目录不存在，该分支**永远抛、被静默吞掉**，四项常量再导出从未生效（低危死代码 + 静默失败，建议删或改指 `./playlist/domain`）。

### 7.5 装配层与编码取证（清单原样重跑）

| 项 | 实测 |
| --- | --- |
| `.register(` 命中数 | **20**（与上一轮一致，`601/617` 仍为注入式实参） |
| 关键接线 | `:600-601 ipcSearch.register({domain, infra: createSearchInfra()})`；`:616-617 ipcPlaylist.register({domain, infra: createPlaylistInfra()})`；`:644-651 ipcSubscriptions.register({...})`；`:641` 另见 `findDownloadedAsync` 显式注入 |
| 装配层实调 `register` | `ipcSearch.register` **OK**；`ipcPlaylist.register` **OK**；`ipcLibrary.register` **FAIL**（§7.3） |
| U+FFFD（4 个指定文件） | **0** |
| `node --check src\main\index.js` | 退出码 0，无输出 |
| 全仓编码体检（`src`+`test`+`scripts`+`docs`，853 个 `js/cjs/mjs/vue/json/md`，排除 `node_modules/.git/dist/.preview`） | `FILES=853  PROBLEM_FILES=0  FFFD_TOTAL=0`（无 BOM、无 U+FFFD、严格 UTF-8 全部通过） |

### 7.6 上一轮 3 类失败的独立核验结论

| 上一轮失败 | 声明 | 本轮实测 |
| --- | --- | --- |
| 12 个 infra 文件 `require` 深度错误（阻断） | 全部修正 | ✅ **属实**：门禁 9 `51/51 OK`，12 个 infra 文件全部可加载。**但同类缺陷在 `library.js` 薄壳残留 7 处**（§7.3），阻断未解除 |
| `queue.js` 缺 `findDownloadedAsync`（高） | 已修复 | ✅ **属实**：门禁 4 `0 error`；代码有默认实现 + 装配层显式注入；行为实跑正确（§7.2-A） |
| 4 个夹具旧签名 + 5 个静态锚点过期（中） | 已修复 | ✅ **属实**：`favorites` / `playlist-trash` / `mcp-e2e` / `crossSourceAggregate-primary` 与 `ab-clip` / `reconcile-renames` / `relink-refs` / `crossSourceAggregate-truncation` / `crossSourceAggregate-wiring` 合并实跑 `tests 70 / pass 70 / fail 0` |
| `save-user-playlist` 陌生 id 行为回归 | 已修复 | ✅ **属实**：§7.2-B，新 id 新建、名称与歌单内容保留、不进回收站、`trashNow` 全仓 0 |

---

## 8. 最终 VERDICT

**VERDICT: FAIL**

九项门禁 **8 绿 1 红**（红：门禁 1）。红项对应的不是测试质量问题，而是**启动阻断级源码缺陷**，因此不判 PARTIAL。

### 8.1 唯一失败用例与原始报文

| 文件 | 用例 | 原始报文（首行 + 关键帧） |
| --- | --- | --- |
| `test/libraryIpc.integration.test.js` | 整个文件未进入用例即崩（`:1:1` 文件级 fail） | `Error: Cannot find module '../../../utils/libraryIndex'`<br>`Require stack: - src\main\ipc\library.js`<br>`at Object.register (src\main\ipc\library.js:39:19) { code: 'MODULE_NOT_FOUND' }` |

`test-stable` 判定：`首跑 fail → 重跑仍 fail（612ms）⇒ 保持红`，`flaky 0` —— **确定性失败，非环境问题**。

### 8.2 根因归属（按严重度）

1. **【阻断 · 源码】** `src/main/ipc/library.js` 第 39/41/60/66/77/78/79 行共 **7 处** `require('../../../utils/...')` 多上溯一层，应为 `'../../utils/...'`。`register()` 惰性执行，故 `require` 静态检查与门禁 9 均假绿；实际装配到 `src/main/index.js:619` 必抛，主进程起不来，其后 13 个域的注册全部中断。`dist/` 与 asar 内同病。**归属：源码（重构遗留，与上一轮 12 个 infra 文件同类，修复时未覆盖 `ipc/*.js` 薄壳）**。
2. **【低 · 源码】** `src/main/ipc/playlist.js:283` `require('./domain')` 指向不存在的 `src/main/ipc/domain`，被空 `catch` 吞掉 —— 兼容再导出永不生效。不阻断启动，但属静默失败死代码。
3. **【低 · 门禁设计】** 门禁 9（逐文件 `require`）无法覆盖函数体内惰性 require；门禁 5/6 只做拷贝与字符串锚点。三者叠加造成"8 绿仍不可启动"。（上一轮已提示过前两点，本轮再次实证。）
4. **【已排除】** 环境 flake（`flaky 0`）、编码事故（853 文件 0 问题）、lint 真实错误（0 error）、typecheck（双端 0 error）、构建/asar 产物完整性（18/18）、上一轮 4 夹具 + 5 锚点 + queue 注入 + 陌生 id 行为（全部实测通过）。

### 8.3 复验通过所需的最小动作（供下一轮直接执行）

1. 把 `src/main/ipc/library.js` 的 7 处 `'../../../utils/` 改为 `'../../utils/`（改完 `node --check` + 实调 `ipcLibrary.register()` 验证）。
2. 顺手修正或删除 `playlist.js:283` 的兼容再导出（指向 `./playlist/domain`）。
3. **把本轮新增的静态 require 解析纳入常规门禁**（`src` 全量 521 条相对 require，要求 `UNRESOLVED=0`，或至少不含非注释项）——它比门禁 9 便宜且能覆盖惰性分支；再补一条"实调 4 个域 `register()`"的装配冒烟。
4. 之后重跑全部九项 + §7.4 静态解析 + §7.2 三条对抗验证；预期门禁 1 的 351 个文件全绿（当前 350/351）。

---

## 9. 复验（第三轮）

> 复验时间 2026-11-08 23:44–23:52 +08:00；HEAD 仍为 `c779429`，`git status --porcelain` **109** 条（第二轮 107 条）。
> 规则同前：**不采信任何"已修复"声明**，全部数字为本轮实跑；复验期间未改任何源码/测试/脚本，只写本文件。
> Node v24.15.0 / npm 11.12.1 / Windows + PowerShell。`npm warn Unknown user config …` 为 npmrc 提示，与门禁无关。

### 9.1 十项门禁实跑

| # | 门禁 | 命令 | 退出码 | 关键输出 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 全量稳定测试 | `node scripts/test-stable.cjs` | **1** | 文件 **352** / pass **351** / **fail 1** / 超时 0 / flaky 0 / 启动错误 0；用例级 pass=3583 **fail=1**；耗时 1m31s。唯一红文件 `test\toast-i18n.test.js`（首跑 fail → 串行重跑仍 fail 388ms ⇒ 保持红，**非 flake**） | ❌ **FAIL** |
| 2 | 主进程 typecheck | `npm run typecheck` | 0 | `tsc -p tsconfig.json --noEmit`，0 error | ✅ PASS |
| 3 | 渲染层 typecheck | `npm run typecheck:renderer` | 0 | `vue-tsc -p tsconfig.renderer.json --noEmit`，0 error | ✅ PASS |
| 4 | lint | `npm run lint` | 0 | `✖ 20 problems (0 errors, 20 warnings)`；无 error | ✅ PASS |
| 5 | 构建 | `npm run build` | 0 | `[postbuild] done`；新层 105 modules / 旧层 184 / main 1 / preload 2，全量拷贝成功 | ✅ PASS |
| 6 | asar 冒烟 | `npm run smoke:asar` | 0 | **18/18 通过**；asar 35,018,659 B；8 平台模块、双渲染层入口、249 包依赖树无缺失 | ✅ PASS（**注意 §9.4 的产物时效**） |
| 7 | 关键测试集（10 文件） | `node --test test/encoding-guard.test.js … test/libraryIpc.integration.test.js` | 0 | `tests 118 / pass 118 / fail 0 / cancelled 0 / skipped 0 / duration_ms 1101.99` | ✅ PASS |
| 8 | 主进程语法 | `node --check src\main\index.js` | 0 | 无输出 | ✅ PASS |
| 9 | 静态 require 解析 | `node scripts/check-require-paths.cjs` | 0 | `FILES 371 / RELATIVE_REQUIRES 502 / UNRESOLVED 0`；无 `ALLOWLISTED` 行 | ✅ PASS |
| 10 | 装配冒烟（electron 打桩） | 任务清单给的 `node -e …` | 0 | `{"library":"OK","playlist":"OK","search":"OK"}`；清单文字称"四域"但脚本实为 3 域，本轮**补测** `subscriptions` ⇒ `subscriptions: OK` | ✅ PASS（**4/4 域可注册**） |

### 9.2 四条对抗性验证

| # | 验证对象 | 方法 | 实测结果 | 结论 |
| --- | --- | --- | --- | --- |
| A | `playlist.js` 是否仍有指向不存在目录的 `require('./domain')`；四项常量再导出指向哪 | 全仓精确正则 + 目录存在性 + 运行时取值 | 全 `src` 中 `require('./domain')` 命中 **0**；`src/main/ipc/domain` **不存在**；`:19 const playlistDomain = require('./playlist/domain');`（顶层静态）；`:285-288` 四项再导出全部取自 `playlistDomain`。运行时：`FAVORITES_ID=favorites`、`FAVORITES_NAME=收藏`、`TRASH_KEY=playlistTrash`、`typeof songKey=function`，`domainMatches=true` | ✅ **旧兼容死代码已真删除/改指，再导出真实生效** |
| B | `test/require-path-resolution.test.js` 是否真能逮住错路径；扫描器是否真剔除注释 | 读代码 + 独立内存变异（不落盘） | 文件含 4 个用例：真实仓库 `UNRESOLVED===0`；合成 fixture `src/dir/nested/bad.js` 必须报出 `['../../../ok','./missing']` 且行号 `[4,5]`；注释/字符串噪声只允许提取 `./real`；`node_modules`/`dist` 不扫。独立复核：把 `library.js` 已修好的 `../../utils/libraryIndex` 在内存中改回 `../../../utils/libraryIndex`，扫描器立即报 `MUTATED_UNRESOLVED ["44:../../../utils/libraryIndex"]`；噪声串只提取到 `./real` | ✅ **非假绿：错路径必红、注释/字符串必剔除** |
| C | `scripts/check-require-paths.cjs` 白名单是否为空 | 读源码 + 实测输出 | `const ALLOWLIST = Object.freeze([]);`，`ALLOWLIST.length === 0`；CLI 无 `ALLOWLISTED` 行 | ✅ **白名单为空，门禁未被豁免口子架空** |
| D | 全仓编码体检 | Node `TextDecoder('utf-8',{fatal:true})` 字节级扫描 `src`+`test`+`scripts`+`docs`（排除 `node_modules/.git/dist/.preview`，扩展名 `js/cjs/mjs/vue/json/md`） | `FILES=855  BOM_FILES=0  FFFD_TOTAL=0  FFFD_FILES=0  INVALID_UTF8_FILES=0  PROBLEM_FILES=0` | ✅ **严格 UTF-8、无 BOM、无 U+FFFD** |

补充覆盖核对（防扫描器漏文件）：`src` 原始相对字面量 `require` 共 **521** 条，扫描器实际计入 **502** 条，差 **19** 条分布在 14 个文件；逐条打印原文后确认 **19/19 全部位于块注释或行注释中**（如 `subscriptions/infra/index.js:88-91` 的 JSDoc、`main/subscriptions.js:16/319`、`shared/errors.js:8`），**没有任何一条真实代码 require 被漏扫**。

### 9.3 唯一红项取证：`library.js:27` 行注释含 `/*`，触发"扫描器地基"守卫

原始报文（`test-stable` 日志，`node --test test/toast-i18n.test.js` 同源）：

```
failureType: 'testCodeFailure'
error: |-
  这些行注释里带了块注释标记，会让 stripComments 从该行起吞掉后续代码：
  src/main/ipc/library.js:27
  + actual - expected
  + [ 'src/main/ipc/library.js:27' ]
  - []
code: 'ERR_ASSERTION'
stack: TestContext.<anonymous> (test/toast-i18n.test.js:266:10)
✘ toast-i18n.test.js 首跑 fail → 重跑仍 fail（388ms）⇒ 保持红
```

违规行（`src/main/ipc/library.js:27`）：

```js
  // 子模块（library/domain/*、library/*.js）统一导出 register 函数本体
```

判据来源（`test/toast-i18n.test.js:248-268`）：任何 `.js` 的整行 `//` 注释中不得出现 `/*` 或 `*/`。因为仓内大量测试用**非贪婪块注释正则**做 `stripComments`，行注释里的 `/*` 会与"后面某个 `*/`"配对，把中间整段代码删掉，造成计数静默变小、孤儿表变长。该守卫是**确定性自测**：`test-stable` 首跑/重跑均 fail，`flaky=0`。

本轮影响边界（实测，不夸大）：
- **当前** `library.js` 第 27 行之后没有新的 `*/`，故朴素 `stripComments` 暂未真正吞掉代码：剥离后 `module.exports = { register }` 与全部 31 条 `require` 仍在，`node --check`、门禁 9、门禁 10 均不受影响。
- 但它是**潜伏炸弹**：今后只要在文件尾部补一段 JSDoc（`*/` 收尾），第 27 行起的 `register()` 主体会被整段当注释删除；门禁 9 使用的 `codeMask` 是行注释感知的（本轮实测 `library.js` 仍提取到 28 条相对 require，未被该行遮蔽），但仓内其余 `stripComments` 扫描器没有这个保护。
- 全 `src` 权威复核：同类违规 **仅此 1 处**（Node 逐文件按 `test/toast-i18n.test.js` 同判据扫描），不是大面积回潮。

根因归属：**源码/注释卫生（低危，非启动阻断）**。证据链：第二轮 §7.3 取证的同文件行号为 `libraryIndex:39`，本轮同一条 require 已到 `:44`（整体 +5 行）；`git diff -- src/main/ipc/library.js` 显示 `:27-29` 这三行说明注释是相对 `HEAD` 新增的工作树内容。即修复 7 条路径时顺带写入的说明文字引入了违规标记，属"修复动作自身引入的门禁回退"。

### 9.4 其他取证与产物时效

| 项 | 实测 |
| --- | --- |
| 上一轮唯一红项 `libraryIpc.integration.test.js` | ✅ **已真修复**：本轮 18/18 通过（809ms）；`library.register()` 实调 `OK`；`library.js` 的 7 条 `utils` 路径现均为 `../../utils/...` |
| `library.js` 静态 require | 顶层 `:12-14` + `register()` 内惰性 require 全部可解析；相对 require 提取 28 条（另 3 条为 `require('electron')` 裸模块，不属本门禁） |
| 订阅域（清单遗漏的第四域） | `ipcSubscriptions.register({subscriptions: stub})` ⇒ `OK`；`:632-651` 的 domain/infra 注入形态与本轮补测一致 |
| lint 残留 warning | 20 条，0 error；其中 `library.js:13/14` 的 `prefs`/`approvedDirs` 顶层 require 已无人使用，属搬迁后死引用（当前仅 warning，不阻断） |
| 构建产物 | `dist/main/ipc/library.js` 由 postbuild 直接拷贝，内容与源码一致；门禁 6 的渲染层锚已按脚本声明改判 `dist`（`app.asar` 早于 `src` 最新改动） |
| 文档自身编码 | 本文件追加后仍为 **UTF-8 无 BOM、LF**，第 1–8 章原文未改动（见 §10 的字节校验） |

---

## 10. 结论

**VERDICT: FAIL**

十项门禁 **9 绿 1 红**。红项不是产品运行阻断，而是一条**确定性测试失败**：修复 `library.js` 路径时新增的说明注释违反项目既有的"行注释不得含块注释标记"地基守卫。任务验收口径是"测试全绿"，当前 352 个测试文件仍有 1 个红，故不能判 PASS；由于其不影响启动、typecheck、lint、构建与装配，也不构成第二轮那种阻断级缺陷，失败范围已收敛到**一行注释措辞**。

### 10.1 失败用例与原始报文

| 文件 | 用例 | 原始报文（首行 + 关键帧） |
| --- | --- | --- |
| `test/toast-i18n.test.js` | `扫描器地基：任何 .js 的行注释里不得出现块注释标记（会把后面整段代码吞成注释）` | `AssertionError: 这些行注释里带了块注释标记，会让 stripComments 从该行起吞掉后续代码：`<br>`src/main/ipc/library.js:27`<br>`+ actual - expected`<br>`+ [ 'src/main/ipc/library.js:27' ]`<br>`- []`<br>`at TestContext.<anonymous> (test/toast-i18n.test.js:266:10)` |

`test-stable` 判定：`首跑 fail → 重跑仍 fail（388ms）⇒ 保持红`，`flaky 0 / 超时 0 / 启动错误 0` —— **确定性失败，非环境问题**。

### 10.2 根因归属

1. **【低 · 源码/注释卫生】** `src/main/ipc/library.js:27` 的行注释 `// 子模块（library/domain/*、library/*.js）统一导出 register 函数本体` 含两处 `/*`。该行与 `:28-29` 是本轮修复期间新增（第二轮 `libraryIndex` 在 `:39`，本轮 `:44`，整体 +5 行；`git diff` 显示为工作树新增）。它违反 `test/toast-i18n.test.js:248-268` 的全局不变量，导致门禁 1 红。
2. **【已排除 · 产品功能】** 启动链路已修复：门禁 10 四域 `register()` 全 `OK`；门禁 7 `libraryIpc.integration` 18/18；7 条错误路径已全部改为 `../../utils/...`；`playlist.js` 旧 `require('./domain')` 死代码已删除，四项常量再导出指向 `./playlist/domain` 且运行时取值正确。
3. **【已排除 · 环境】** 红项重跑仍失败（`flaky 0`）；编码 855 文件 0 问题；typecheck 双端 0 error；lint 0 error；构建/asar 18/18。
4. **【已排除 · 新增门禁本身】** 门禁 9 `371 文件 / 502 条相对 require / UNRESOLVED 0`；独立变异复核能把错误路径打红；白名单为空；原始 521 条与扫描 502 条的 19 条差额全部落在注释里，无真实代码漏扫。

### 10.3 复验通过所需的最小动作

1. 改写 `src/main/ipc/library.js:27` 的行注释，避开 `/*` 与 `*/`，例如：`// 子模块（library/domain 下、library 下）统一导出 register 函数本体`。
2. 无需改动测试或门禁脚本；改后 `node --test test/toast-i18n.test.js` 应为 50/50 绿。
3. 重跑门禁 1（预期 352/352 文件绿、用例 fail=0），并顺带复跑门禁 7/9/10 确认无连锁影响。
4. 可选清理：`library.js:13/14` 的 `prefs`/`approvedDirs` 顶层 require 已无人使用（lint warning），避免后续误判为"仍在依赖"。

### 10.4 已验证 / 仍未覆盖

**已验证**

- 全量 352 个测试文件中 351 个通过，唯一失败用例的原始报文、判据、根因与最小修复已定位。
- `typecheck` / `typecheck:renderer` 双端 0 error；`lint` 0 error（20 warning）。
- `build` 全量产物生成成功；`smoke:asar` 18/18；`node --check` 通过。
- 关键测试集 118/118；静态 require 解析 `UNRESOLVED=0`（且变异自测有效、白名单为空）。
- 装配冒烟：`library` / `playlist` / `search` / 补测 `subscriptions` 四域 `register()` 全部 `OK`。
- `playlist.js` 兼容死代码清除与四项常量再导出真实生效。
- 全仓 855 个 `js/cjs/mjs/vue/json/md` 严格 UTF-8、无 BOM、U+FFFD=0；本文件第 1–8 章原文未改。

**仍未覆盖**

- 未做真实 Electron 进程启动（无 GUI 会话）；启动结论由装配冒烟与模块解析推得，非端到端复现。
- `smoke:asar` 使用的是 `.preview/release-smoke` 下既有 `app.asar`，脚本自身声明其早于 `src/` 最新改动；**未执行 `npm run package`**，发布包级别未闭环。
- 未验证渲染层实际 UI、播放、下载、订阅自动下载等运行期链路。
- `lint` 的 20 条 warning 未逐条评估（其中 `library.js` 死引用已单独指出）。
- 未评审架构/ADR 符合性（本轮只做门禁与装配取证）。

---

## 11. 复验（第四轮）

> 复验时间 2026-11-08 23:52 – 2026-11-09 00:02 +08:00；HEAD 仍为 `c779429`，`git status --porcelain` **109** 条（与第三轮持平）。
> 规则同前：**不采信任何"已修复"声明**，全部数字为本轮实跑；复验期间未改任何源码/测试/脚本，只写本文件。
> Node v24.15.0 / npm 11.12.1 / Windows + PowerShell。
> 上一轮唯一红项声明：`library.js:27` 行注释改写 + `:13/:14` 的 `prefs`/`approvedDirs` 死引用清理 —— 已在 §11.2 A/B 中独立证伪/证实。

### 11.1 十项门禁实跑

| # | 门禁 | 命令 | 退出码 | 关键输出 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 全量稳定测试 | `node scripts/test-stable.cjs` | **0** | 文件 **352** / pass **350** / **fail 0** / 超时 0 / **flaky 2** / 启动错误 0 / 未执行 0；用例级 **pass=3584 fail=0**；耗时 5m31s。flaky 两文件首跑均 `3m57s` 硬超时、单文件串行重跑 `245ms`/`239ms` 通过 ⇒ 判绿；**另起第二遍整批复跑：352/352 全绿、flaky 0、1m30s、EXIT=0**（取证见 §11.3） | ✅ **PASS**（`toast-i18n` 由 1 红转 50/50 绿） |
| 2 | 主进程 typecheck | `npm run typecheck` | **0** | `tsc -p tsconfig.json --noEmit`，无输出 = 0 error | ✅ PASS |
| 3 | 渲染层 typecheck | `npm run typecheck:renderer` | **0** | `vue-tsc -p tsconfig.renderer.json --noEmit`，无输出 = 0 error | ✅ PASS |
| 4 | lint | `npm run lint` | **0** | `✖ 18 problems (0 errors, 18 warnings)`；较上轮 **20 → 18**（消失的正是 `library.js:13/14` 两条死引用 warning） | ✅ PASS |
| 5 | 构建 | `npm run build` | **0** | `[postbuild] done`；新层 105 / 旧层 184 / main 1 / preload 2（+preload-secondary 1）modules；拷贝 38 项全成功 | ✅ PASS（build 提示见 §11.4） |
| 6 | asar 冒烟 | `npm run smoke:asar` | **0** | **18/18 通过**；asar 35,018,659 B；8 平台模块、双渲染层入口、249 包依赖树无缺失 | ✅ PASS（**产物时效仍未闭环，见 §12**） |
| 7 | 关键测试集（11 文件，含 `toast-i18n`） | `node --test test/toast-i18n.test.js … test/libraryIpc.integration.test.js` | **0** | `tests 168 / pass 168 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 1110.9079`（第三轮 118 条 = 本轮 168 − `toast-i18n` 50 条） | ✅ PASS |
| 8 | 主进程语法 | `node --check src\main\index.js` | **0** | 无输出 | ✅ PASS |
| 9 | 静态 require 解析 | `node scripts/check-require-paths.cjs` | **0** | `FILES 371 / RELATIVE_REQUIRES 500 / UNRESOLVED 0`；无 `ALLOWLISTED` 行。较上轮 **502 → 500**，差额 2 恰为 `library.js` 顶层被删除的 `prefs`/`approvedDirs` 两条（见 §11.2 B） | ✅ PASS |
| 10 | 装配冒烟（electron 打桩） | 任务清单给的 `node -e …` | **0** | `{"library":"OK","playlist":"OK","search":"OK"}`；清单文字称"四域"但脚本实为 3 域，本轮**补测** `subscriptions` ⇒ `{"subscriptions":"OK"}` ⇒ **4/4 域可注册** | ✅ PASS |

十项退出码汇总：**1=0 2=0 3=0 4=0 5=0 6=0 7=0 8=0 9=0 10=0（10/10 绿）**。

### 11.2 四条对抗性验证

| # | 验证对象 | 方法 | 实测结果 | 结论 |
| --- | --- | --- | --- | --- |
| A | 全 `src`「行注释内含 `/*` 或 `*/`」违例行（不止 `library.js`） | 与 `test/toast-i18n.test.js:248-255` **完全同判据**独立复刻（`line.trim().startsWith('//') && /\/\*|\*\//.test(line)`），遍历 `src` 下全部 `.js`；再放宽到 `.js/.cjs/.mjs/.vue` 与"行内任意 `//` 之后"两种更严口径各扫一遍 | 精确判据：`EXACT_HITS=0`；放宽口径：`HITS=0`。`library.js:25` 现文为 `// 子模块（library/domain 下、library 下）统一导出 register 函数本体`，`:26-27` 两行注释亦无标记；原文那处 `/*` **确已消失** | ✅ **0 命中，回退已真修复且无同类别处** |
| B | `library.js` 顶层 `prefs`/`approvedDirs` 死引用是否已删、删除后是否缺引用 | 读顶层 `require` 清单 + 全文件符号检索 + 依赖消费链核对 + 产物字节比对 + 旁证（lint/门禁 9/门禁 7/门禁 10） | 顶层 require **只剩** `:12 const context = require('../context');`（`:13/:14` 两条已不存在）；文件内 `prefs`/`approvedDirs` 仅出现在 `:70-71` 作为 `domainConvert` 的注入键，且 `library/domain/convert.js:9` 解构、`:56 approvedDirs.approve(resolvedOutputDir)`、`:66 prefs.get('convertLoudnorm')` **真实消费**；`dist/main/ipc/library.js` 与源码 `Buffer.compare === 0`。旁证：lint 20→18（消失项正是这两条）、门禁 9 相对 require 502→500（恰减 2）、门禁 7 `libraryIpc` 18/18、门禁 10 `library: OK` | ✅ **死引用真删除，且删除未造成缺引用** |
| C | 全仓编码体检（`src`+`test`+`scripts`+`docs`，排除 `node_modules/.git/dist/.preview`） | Node `TextDecoder('utf-8',{fatal:true})` 字节级解码 + BOM 三字节判定 + U+FFFD 计数，扩展名 `js/cjs/mjs/vue/json/md` | `FILES=855 BOM_FILES=0 FFFD_TOTAL=0 FFFD_FILES=0 INVALID_UTF8_FILES=0 PROBLEM_FILES=0` | ✅ **严格 UTF-8、无 BOM、无 U+FFFD** |
| D | 第 1–10 章原文是否被改动 | 追加前后**字节级**对比：追加前测得 `PRE_LEN=42945`、`PRE_SHA256=EA8CEE35944551892F2C9B0946C17700DB68FF1A81C71490544BF3E3FEFB6760`；追加后对**前 42,945 字节**重算哈希；并核对章节标题与关键数字 | 见 §11.4 "D" 行：前缀 SHA-256 与追加前**逐字节一致**；`## 1.`–`## 10.` 标题全部命中；§10 的 `VERDICT: FAIL` 与 `352/351/fail 1`、`855`、`371/502`、`18/18`、`20 warning` 等关键数字原样保留 | ✅ **原文未改动，本轮为纯追加** |

### 11.3 门禁 1 的 flaky 取证（关键：不是用"重跑通过"掩盖真失败）

首跑（日志 `.preview\test-stable-2026-11-08T15-52-19-787Z.log`）：

```
⏱ resolveTrackService.test.js (3m57s) pass=0 fail=0     ← 硬超时 3m00s
⏱ retry-attempts-setting.test.js (3m57s) pass=0 fail=0  ← 同一批并发槽位、同一时刻卡死
[test-stable] 重跑 2 个失败/超时文件（单文件、串行、仅一次）
⚠ resolveTrackService.test.js 首跑 timeout → 重跑 pass（245ms）⇒ flaky，判绿
⚠ retry-attempts-setting.test.js 首跑 timeout → 重跑 pass（239ms）⇒ flaky，判绿
  文件总数 : 352   pass : 350   fail : 0   超时 : 0   flaky : 2   启动错误 : 0
  用例级   : pass=3584 fail=0
```

三层交叉取证：

| 证据 | 实测 |
| --- | --- |
| 单文件独立复跑（第 3 次执行） | `node --test test/resolveTrackService.test.js` ⇒ `pass 68 / fail 0 / 134ms`；`node --test test/retry-attempts-setting.test.js` ⇒ `pass 5 / fail 0 / 123ms` |
| 整批第二遍（并发 2 全量重跑） | 日志 `.preview\test-stable-2026-11-08T15-59-21-232Z.log`：`文件总数 352 / pass 352 / fail 0 / 超时 0 / flaky 0 / 用例 pass=3584 fail=0 / 1m30s`，`EXIT1_REPEAT=0` |
| 失败形态 | 两文件**同时**卡在 `3m57s` 且 `pass=0 fail=0`（零用例执行 ⇒ 进程卡在加载/IO 阶段，而非断言失败）；单独跑 0.12–0.14s 完成。判定为**环境瞬时卡顿**（磁盘/杀软扫描或并发槽位争用），非源码或测试缺陷 |

结论：门禁 1 的"绿"由 **三次独立证据** 支撑（首跑 fail=0 且用例 3584 全通过 + 单文件两次独立通过 + 整批第二遍 flaky=0），未以重跑掩盖确定性失败。

### 11.4 其他取证

| 项 | 实测 |
| --- | --- |
| D（承接 §11.2） | 追加后正文前缀 42,945 B 的 SHA-256 与追加前**完全相同**；本文件保持 **UTF-8 无 BOM、LF**，追加段以 `## 11.` 起始，未触碰第 1–10 章任何字节 |
| `library.js` 结构 | 94 行；顶层仅 `context`；`register(opts)` 内 6 个 infra + 6 个 domain + 6 个 IPC 层注册齐备；`module.exports = { register }` 仍在（`:94`） |
| 门禁 9 数量变化解释 | `RELATIVE_REQUIRES 502 → 500` 与本轮删除的两条顶层 require 精确吻合，无其他漂移（`FILES 371` 不变） |
| lint 残余 | 18 条 warning、0 error：`library/domain` 5 + `library/domain/dupScan` 1、`playlist.js` 2、`subscriptions.js` 3、renderer `engine.js` 2、test 4、`search/domain` 4；`library.js` 两条已随死引用清理消失 |
| 构建提示（非 error） | `Unknown input options: platform`（3 条，来自 vite 配置透传 rollup 选项）、`player.ts`/`errBrief.js` 动态+静态双重导入提示、`renderer-legacy` 单 chunk 645 kB > 500 kB 警告；退出码 0，产物完整 |
| asar 时效 | 脚本自身声明 `app.asar` 早于 `src/` 最新改动、渲染层断言改判工作树 `dist`；**本轮未执行 `npm run package`**，发布包级别仍未闭环（与第三轮同） |
| 复验期间源码零改动 | `git status --porcelain` 复验前后均为 **109** 条，HEAD `c779429`，唯一写入文件为本文件 |
| 装配面 | 4 域 `register()` 全 `OK`（`library`/`playlist`/`search`/补测 `subscriptions`）；8 个平台插件自动发现完成（`netease/qq/bilibili/kugou/kuwo/migu/fivesing/soda`） |

---

## 12. 最终结论

**VERDICT: PASS**

十项门禁 **10 绿 0 红**（退出码全部为 0）。上一轮唯一红项 `src/main/ipc/library.js:27` 的"行注释含块注释标记"已按判据**实改**：`test/toast-i18n.test.js` 由 fail 转为 50/50 绿，与其完全同判据的独立全 `src` 扫描 0 命中；同文件顶层 `prefs`/`approvedDirs` 死引用确已删除，且消费链（`library/domain/convert.js`）未受影响。验收口径"测试全绿 + typecheck 0 error + lint 0 error + 构建 smoke"全部兑现。

### 12.1 已验证

- 全量稳定测试 **352 文件 / fail 0 / 用例 3584 全通过**，并经三层证据排除 flaky 误判；第二遍整批复跑 **352/352、flaky 0**。
- `typecheck` / `typecheck:renderer` 双端 **0 error**；`lint` **0 error**（18 warning，较上轮减少 2 条死引用 warning）。
- `build` 成功（`[postbuild] done`，38 项拷贝完整）；`smoke:asar` **18/18**；`node --check` 通过。
- 关键测试集 **168/168**；静态 require 解析 **371 文件 / 500 条 / UNRESOLVED 0**，白名单为空。
- 装配冒烟 **4/4 域可注册**，8 平台插件全部自动发现。
- 全仓 855 个 `js/cjs/mjs/vue/json/md`：严格 UTF-8、无 BOM、U+FFFD=0。
- 本文第 1–10 章经字节级哈希比对确认**原文未改**，本轮为纯追加。

### 12.2 仍未覆盖（不因 PASS 而消失）

- **未做真实 Electron 进程启动**（无 GUI 会话）：启动结论由 4 域装配冒烟 + 模块解析 + 语法检查推得，非端到端复现。
- **未执行 `npm run package`**：`smoke:asar` 验的是 `.preview/release-smoke` 下既有 `app.asar`，脚本自身声明其早于 `src/` 最新改动；发布包级别未闭环，发布前必须重新打包并复跑该脚本。
- 未验证渲染层实际 UI 交互、播放链路、下载落盘、订阅自动下载等运行期行为。
- `lint` 18 条 warning 未逐条评估；构建的 `platform` 未知选项与 `renderer-legacy` 645 kB 单 chunk 提示未处置。
- 未评审架构/ADR 符合性（本轮只做门禁与装配取证）。
- 工作树 `109` 条改动仍未提交（HEAD 仍 `c779429`），验收对象是"工作树 + 未提交文件"，不是可复现的 commit。

### 12.3 残余风险

| 风险 | 等级 | 说明 / 缓解 |
| --- | --- | --- |
| 首跑 flaky（2 文件硬超时） | 低 | 已三重取证为环境卡顿；建议 CI 上把 `test-stable` 的并发降到 1 或提高硬超时，避免噪声 |
| 发布包未重打包 | 中 | PASS 仅覆盖工作树门禁；发版前需 `npm run package` → `npm run smoke:asar` 复跑 |
| 未真启动 Electron | 中 | 建议在打包后补一次冷启动冒烟（打开主窗口 + 一次 IPC 往返） |
| 18 条 lint warning | 低 | 不影响门禁；其中 `playlist.js:32/34` 再导出常量"声明后未用"属兼容层遗留，可后续收敛 |
| 109 条未提交改动 | 中 | 建议门禁通过后立即提交，使 PASS 可追溯到具体 commit |

---

## 13. 发版级收口（第五轮）

> 目的：补上第 12.2 节遗留项「未重建发布产物」。第四轮 `smoke:asar` 验的是**既有旧 asar**（产物不新鲜），本轮先用 `package:smoke` 重建目录模式产物，再对新产物复验全部门禁，并对 asar ↔ dist ↔ src 做逐字节取证。
> 约束：全程**零源码改动**（`git status --porcelain` 前后均为 109 条，HEAD 仍为 `c779429`），唯一写入为本文件追加段。

### 13.1 八项实跑

| # | 项 | 命令 | 退出码 | 关键输出 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 重建目录模式产物 | `npm run package:smoke` | **0** | `electron-builder 26.15.3`；`packaging platform=win32 arch=x64 electron=44.4.1 appOutDir=.preview\release-smoke\win-unpacked`；`updating asar integrity executable resource`；`signing with signtool.exe`；耗时 **43.39 s**；未出现跳过打包/复用旧 asar 的提示 | PASS |
| 2 | 对新 asar 冒烟 | `npm run smoke:asar` | **0** | `asar: .preview\release-smoke\win-unpacked\resources\app.asar (35088286 B)`；`18/18 通过`（含 `渲染层 bundle 断言源 = asar（app.asar 不早于 src/ 最新改动）`、`asar 内 assets/icon.png 与工作区当前图标一致`、`生产依赖树 249 个包…无缺失`） | PASS |
| 3 | 死依赖门禁 | `npm run check:dead-deps` | **0** | `检查 31 个被排除的包…`；`运行时插桩：遍历 src/ 下 371 个模块，实际加载第三方包 143 个；源码静态引用 7 个`；`✓ 全部 31 个排除项均未被运行时加载，排除仍然安全。` | PASS |
| 4 | 攻击面门禁 | `npm run check:attack-surface` | **0** | `扫描 src/ 下 371 个模块；分组包 express/body-parser/path-to-regexp；启动许可 src/main/mcp/mcpServer.js`；`✓ 四条判据全部成立：「server 从未启动」的豁免理由本轮重新复核通过。` | PASS |
| 5 | 图标门禁 | `npm run check:icons` | **0** | `全部 20 项通过。`（icon.png 512x512/15 KB/不透明 98.4%/无水印；icon.ico 7 档 16…256；两张 NSIS BMP 位深与尺寸合规） | PASS |
| 6 | 主进程类型检查 | `npm run typecheck` | **0** | `tsc -p tsconfig.json --noEmit` 无任何诊断输出 | PASS |
| 7 | 渲染层类型检查 | `npm run typecheck:renderer` | **0** | `vue-tsc -p tsconfig.renderer.json --noEmit` 无任何诊断输出 | PASS |
| 8 | 静态检查 | `npm run lint` | **0** | `✖ 18 problems (0 errors, 18 warnings)`；分布：`library/domain` 5、`library/domain/dupScan` 1、`playlist.js` 2、`search/domain` 4、`subscriptions.js` 3、renderer `engine.js` 2、test 4（与第 12 章记录一致，无新增） | PASS（0 error） |
| 9 | 装配冒烟（四域 `register()`，electron 打桩） | 内联 `node -`（脚本同任务清单第 8 项） | **0** | `{"library":"OK","playlist":"OK","search":"OK","subscriptions":"OK"}`；8 个平台插件自动发现完成 `netease/qq/bilibili/kugou/kuwo/migu/fivesing/soda` | PASS |

**与任务预期的偏差（如实记录）**：任务备注担心 `check:attack-surface` / `check:icons` 会因「工作树未提交的新文件」报红，实测**两项均退出码 0、无告警**，无需人工决策，也未做任何脚本或源码调整。

**环境噪声（非门禁项，均不影响退出码）**：① 每次 `npm run` 输出 6 条 `npm warn Unknown user config "electron_mirror"/"electron_builder_binaries_mirror"/"chromedriver_cdnurl"/"sharp_dist_base_url"/"sharp_libvips_binary_host"/"node_inspect"`；② 出现 `NODE_TLS_REJECT_UNAUTHORIZED=0` 的 Node 警告（来自外层 shell 环境变量，属**机器环境**配置，未修改任何仓库文件，建议 CI/发版机去掉该变量）；③ `node -` 打桩运行期有 `[crash] app.setPath is not a function` 等预期告警（打桩缺省 API 所致）。

### 13.2 产物新鲜度取证

**定位**：`Get-ChildItem -Recurse -Filter *.asar` 全仓仅 2 个 asar —— `node_modules\electron\dist\resources\default_app.asar`（Electron 自带，1980-01-01）与本次产物；按修改时间取最新者即本次产物。

| 对象 | size | sha256 |
| --- | --- | --- |
| 产物 asar：`.preview\release-smoke\win-unpacked\resources\app.asar` | 35,088,286 B | `68b829ec…fb134978c`（完整值见下） |
| asar 内 `dist\main\ipc\library.js` | 3,831 B | `d3c7b2ae…ea8ba8b5` |
| 工作树 `dist\main\ipc\library.js` | 3,831 B | `d3c7b2ae…ea8ba8b5` |
| 工作树 `src\main\ipc\library.js` | 3,831 B | `d3c7b2ae…ea8ba8b5` |

完整 sha256（取证原文）：

- `app.asar` = `68b829eccb2d6bb4cff518fd341af23321a0482831fc4be1cfda5ccfb134978c`
- 三者 `library.js` = `d3c7b2ae9b7e3a1f1245e9b6514c987977ab19eed370548619cd95f0ea8ba8b5`（长度均 3831）

**逐字节比对结果**：

| 比对 | 方法 | 结果 |
| --- | --- | --- |
| asar 内 `dist/main/ipc/library.js` ↔ 工作树 `dist/main/ipc/library.js` | `Buffer.compare` | **完全一致（0 差异）** |
| 工作树 `dist/main/ipc/library.js` ↔ `src/main/ipc/library.js` | `Buffer.compare`（postbuild 直拷） | **完全一致（0 差异）** |
| 扩展全量：asar 内 `dist\main\**.js`（112 个）↔ 工作树 `dist\main\**.js` | 逐文件 `Buffer.compare` | **identical 112 / diff 0 / missing 0** |

**时间戳与元信息**：

| 项 | 值 |
| --- | --- |
| asar mtime | `2026-11-09T00:06:25.420+08:00`（本轮打包生成，早于此轮 `smoke:asar` 运行时刻 00:06:38） |
| `src/` 最新 mtime | `2026-11-08T23:50:36.893+08:00`（`src\main\ipc\library.js`） |
| asar mtime vs src 最新 mtime | asar **晚 15 分 48.5 秒** |
| asar 内 `package.json` version | `1.0.38`，与根 `package.json` `1.0.38` 一致 |
| `win-unpacked\Lanyue.exe` | 246,324,736 B，mtime `2026-11-09 00:06:27`（随同一轮打包刷新） |

**取证方法学备注（可复现）**：Windows 上 `@electron/asar` 的 `extractFile` 内部按 `path.sep` 切分目录，必须传 `dist\main\ipc\library.js`（反斜杠）而非 POSIX 风格 `dist/main/ipc/library.js`，否则抛 `was not found in this archive`（本次即先踩到此坑，改分隔符后取证成功）。另注意 `asar.listPackage()` 返回的条目带前导 `\`。

**结论：产物新鲜（FRESH）**。判定依据三条同时成立：① asar mtime 晚于 `src/` 全局最新改动；② asar 内嵌的 `dist/main` 与工作树 `dist/main` **112/112 全一致**；③ `dist/main` 与 `src/main` 逐字节一致（postbuild 直拷路径未漂移），因此「asar→dist→src」三级链条闭合，不存在「新源码 + 旧产物」的错配。

### 13.3 结论

| 判定项 | 结果 |
| --- | --- |
| 发布产物是否重建 | **是**（`package:smoke` 43.39 s 全新产出，asar 35088286 B） |
| 产物是否新鲜 | **是**（见 13.2，三级比对 + 112 文件全量比对 + mtime 单调性） |
| 对**新**产物复跑 `smoke:asar` | **18/18 PASS** |
| 八项门禁 | **8/8 退出码 0** + 装配冒烟 4/4 OK |
| 源码/脚本改动 | **0**（`git status` 前后均 109 条，HEAD `c779429`） |

**是否能宣布「发版级收口完成」：可以——就「目录模式产物 + asar 新鲜度 + 门禁全绿 + 四域装配」这一范围而言已闭环。**

**仍未闭环（不因本节 PASS 而消失）**：

1. **未产出 NSIS 安装包**：本轮为 `--dir` 目录模式（`build/smoke.config.cjs`），正式发版仍需 `npm run package`（`build/config.cjs`，含安装器与签名产物）并复跑 `smoke:release`。
2. **未真启动 Electron GUI**：四域 `register()` 为打桩装配冒烟，`win-unpacked\Lanyue.exe` 冷启动、主窗口渲染、一次真实 IPC 往返未验证。
3. **运行期行为未验**：播放/下载落盘/订阅自动下载/云同步等未做端到端验证。
4. **`lint` 18 条 warning 仍在**（0 error，不影响门禁）。
5. **工作树 109 条改动仍未提交**（HEAD 仍 `c779429`），本轮验收对象是「工作树 + 未提交文件」，不是可复现的 commit；发版前须提交并重打产物，否则本次取证无法按 commit 复现。
6. **发版机环境变量 `NODE_TLS_REJECT_UNAUTHORIZED=0`** 会在打包/联网环节关闭 TLS 校验，属供应链风险，建议在 CI 与发版机上显式剔除。
7. **`win-unpacked\Lanyue.exe` 体积 246 MB** 偏大，未评估是否由 `--dir` 模式未压缩或依赖膨胀导致；正式 `package` 时应复核安装包体积预算。

**第 12 章 VERDICT 与本节的合并口径**：第 12 章 PASS = 工作树门禁全绿；第 13 章 = 重建产物后复验仍全绿且产物新鲜。两者合并后，剩余阻塞发版的项仅为「正式安装包 + 真实冷启动 + 提交」三类，均为发版流程动作，不含已知代码缺陷。
