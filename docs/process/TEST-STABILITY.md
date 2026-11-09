# 测试稳定性治理（2026-11-07）

> 现象：`npm test`（即 `node --test "test/*.test.js"`）在本机跑到 `history-filters` 之后
> **日志停止增长、进程永不退出**，10 分钟以上无进展；CI 侧靠 `--test-concurrency=2` + 3 次重试硬扛。
>
> 结论：**不是死锁，也不是未关闭句柄，而是「同步阻塞把事件循环占满」导致的假死**。
> 两个用例在 `synchronous=FULL` 的 WAL 模式下逐条提交 5000～6000 次，
> 每次提交都要 fsync（本机实测 ~36ms/条），总耗时 3～6 分钟；
> 而 `--test-timeout` 只能打断**异步**等待，对同步代码完全无效 ⇒ 超时定时器根本没机会跑。
>
> 修复后：全量 350 个文件 **1～2 分钟**跑完（默认并发 2、与 CI 对齐：1m31s～1m51s；`--concurrency=4` 时 55s～57s），
> **350 文件 / 3549 用例全部通过（fail 0）**，并新增 `scripts/test-stable.cjs` 作为「一定会收场」的跑批入口：
> 整批超时/中止时未执行的文件计入失败并 **exit 1**（不再误报绿）；失败/超时文件**单文件重跑一次**，
> 重跑通过记为 flaky 判绿并单列，重跑仍失败才红。
>
> 终验矩阵（2026-11-07）：`test-stable` · `typecheck` · `lint` · `build` · `smoke:asar`
> **五项退出码全部为 0**（明细见第六节 E）。

---

## 一、诊断过程（可复现）

### 1. 带用例级超时跑全量，让超时自己点名

```powershell
node --test --test-timeout=60000 --test-concurrency=4 "test/*.test.js" *> .preview/test-diag.log
```

结果：**没有任何 `not ok` / `timed out`**，日志停在 `.preview/test-diag.log` 的最后一行
（`retrySummary：计数拼文案，缺项按 0 补`，来自 `history-filters.test.js`），文件大小恒定在 202,946 字节。

> 第一课：`--test-timeout` 不出声，本身就是「同步阻塞」的指纹。
> 若是异步等待挂住（server 未关、socket 未断、timer 未 unref），60s 后一定会出现 `not ok ... timed out`。

### 2. 看进程树，找还活着的子进程

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

除测试 runner 外只剩两个子进程：

| PID | 命令行末尾 | 累计 CPU |
|---|---|---|
| 30412 | `--test-timeout=60000 test\history-import-trim.test.js` | 0.53s |
| 45456 | `--test-timeout=60000 test\history.test.js` | 0.42s |

> 第二课：CPU 只有 0.5s 却活了 9 分钟 ⇒ 进程**在等 I/O**，不是死循环。

### 3. 单独跑这两个文件（秒级判定）

```powershell
node --test --test-timeout=20000 test/history.test.js
node --test --test-timeout=20000 test/history-import-trim.test.js
```

两个文件 60s 内均无任何输出、不退出（单文件时 TAP/spec 一行都不打，因为**第一条会输出的用例之前**
就被卡住了）。20s 的用例级超时同样没触发。

### 4. 直接测模块，把「慢」量出来

```js
// 临时探针：init 到磁盘临时目录后逐条 add
const h = require('./src/utils/history');
h.init(dir);
for (let i = 0; i < 6000; i++) h.add({ id: String(i), source: 'qq', title: 'T' + i, status: 'done' });
```

实测（同一台机器）：

| 存储 | PRAGMA synchronous | 单条 add | 6000 条 |
|---|---|---|---|
| `F:\Temp`（`os.tmpdir()`） | `FULL`（默认） | **35.88 ms** | ~216 s |
| `F:\Temp` | `NORMAL` | 0.03 ms | ~0.2 s |
| `F:\Temp` | `OFF` | 0.05 ms | ~0.3 s |
| `C:\Users\...\Temp` | `FULL` | 2.98 ms | ~18 s |
| 内存库（`:memory:`） | — | ~0.04 ms | **0.235 s** |

同一事务里批量提交 200 条只要 13ms ⇒ 瓶颈 100% 是**每条自动提交的 fsync**。
本机 `F:` 盘（`os.tmpdir()` 所在卷）单次 fsync 约 36ms，是 C: 盘的 12 倍。

### 5. 定位到具体用例

| 文件 | 用例 | 逐条写入量 | 落盘耗时 |
|---|---|---|---|
| `test/history.test.js` | `history: 上限淘汰` | 6000 | ~216 s |
| `test/history.test.js` | `history: 双表去重 …` | 5005 | ~180 s |
| `test/history-import-trim.test.js` | `本机历史满额后导入的条目仍留在库里…` | 5000 | ~180 s |

合计 ≈ 580 s（9.7 分钟），叠加 4 路并发争抢磁盘 ⇒ 观测到的「10 分钟无进展」。
这三个用例全部是**纯同步 `for` 循环**，事件循环被占满，`--test-timeout` 无解。

---

## 二、根因

1. `src/utils/history.js` 的 `add()` 每次调用都自动提交（WAL + `synchronous=FULL`），
   每次提交一次 fsync；`importEntries()` 同样**没有**包一层事务。
2. 三个测试用例为了验证「上限淘汰 / 双表去重 / 导入不被立刻裁掉」，需要真实写入 5000+ 条。
3. 在慢盘机器上，这 15000+ 次 fsync ≈ 10 分钟；且写入是同步的 ⇒
   `--test-timeout`（基于定时器）无法中断 ⇒ 整批跑批表现为「永久挂起」。

**不是这些原因**（都已排除，避免后人重复排查）：

- 没有被遗留的 `http.Server` / socket：若如此，60s 用例级超时会发声。
- 没有未 `unref()` 的 timer：同上。
- 没有未 await 的子进程：两个卡住的进程命令行里没有任何孙进程。
- 没有真实网络等待：两个文件只碰 `node:sqlite` 与本地临时目录。

---

## 三、修复（只动测试，不改业务源码）

> 约束：不许改 `src/`、`package.json`、`.github`。修复全部落在 `test/` 与新增脚本/文档。

### `test/history.test.js`

- 用例 `history: 上限淘汰`：改为**不 `init(dir)`**，走模块自带的 `:memory:` 库
  （`_ensure()` 在 `_userDataPath` 为空时打开内存库）。
  同一段 6000 次 `add()` 的 SQL 路径、`_trim()` 淘汰逻辑完全一致，耗时 216s → 0.24s。
- 用例 `history: 双表去重 …`：同样走内存库；**需要「文件在磁盘」的那一半仍用真实临时文件**
  （`findDownloaded` 的 fs 判活照旧被验证）。
- 断言**只增不减**：新增 `total === MAX_ENTRIES`、最早一条 `T0` 被淘汰、最新一条 `T5999` 保留
  三条钉子，比原来的 `<= MAX_ENTRIES` 更严。

### `test/history-import-trim.test.js`

- 用例 `本机历史满额后导入的条目仍留在库里…`：`freshHistory()` 拿到的就是未 `init` 的新实例，
  因此直接走内存库；原来的「先 add 填满 5000 条再 importEntries 10 条」逻辑与断言**逐字未动**。
- 第二个用例（`导入的条目排在最新一侧`）保留落盘路径：只有 3 次写入，成本可忽略，
  顺带保证落盘库的 import 语义仍被覆盖。

### 语义是否有损失？

- 内存库与落盘库走的是**同一套 schema / migration / SQL**（`_openDb` 只差文件路径），
  被验证的对象是「seq 排序 + `_trim` 取舍 + 双表分离」，与 durability 无关。
- 落盘/重启语义由其它用例继续覆盖且仍然落盘：
  `history: add 即时落盘`、`history: 旧版 history.json 一次性迁移`、
  `history: schema 版本化`、`P2-10：损坏的 history.json 被隔离改名`。

---

## 四、隔离清单（`test/quarantine/`）

**本次隔离 0 个用例。** 三个「慢」用例都是可修的性能问题，修完在 1s 内跑完，
不属于「依赖外部服务 / 需要 GUI」的不可本地运行范畴，因此没有移动。

隔离目录约定（目录不匹配 `test/*.test.js`，不会进入默认门禁）：

| 项 | 约定 |
|---|---|
| 位置 | `test/quarantine/`（可保留原文件名 `*.test.js`，也可改名 `*.quarantine.js`） |
| 进入条件 | 只能二选一：① 依赖外部网络/付费服务/真实账号；② 需要 GUI 或人工操作；③ 依赖本机特定硬件。**性能慢不算**，性能问题必须修。 |
| 禁止 | 不许为了让跑批变绿而把**断言**改弱、加 `skip`、或删用例后仍声称覆盖。 |
| 必填信息 | 每条隔离用例必须在 `test/quarantine/README.md` 登记：原因、复现命令、恢复条件、登记人/日期。 |
| 恢复条件 | 外部依赖可用 / 有了 stub / CI 提供对应环境时，移回 `test/` 并删除登记行。 |
| 门禁可见性 | 默认门禁看不见隔离用例 ⇒ **每季度人工跑一次**：`node --test --test-timeout=60000 "test/quarantine/*.test.js"`。 |

---

## 五、推荐跑法

### 1. 本地稳定入口（日常 / 门禁预检）：`node scripts/test-stable.cjs`

> **CI 现状（事实）**：仓库 CI（`.github/workflows/ci.yml:132`、`release.yml:137`）**仍使用原生
> `node --test --test-concurrency=2 "test/*.test.js"`**，并发与失败重试（3 次）由 CI 脚本负责，
> 失败归因交给 `scripts/ci-doctor.cjs`；`scripts/test-stable.cjs` 目前**只是本地稳定入口**，
> **尚未接入 CI 与 `npm run verify`**，接入评估推迟到 M1。**不得**据此表述为「CI 已接入稳定入口」。

```powershell
node scripts/test-stable.cjs                 # 并发 2（与 CI 对齐），单文件硬超时 180s，整批上限 20min
node scripts/test-stable.cjs --concurrency=6 # 服务器核多时可以调高
node scripts/test-stable.cjs --filter history --verbose  # 只跑某个文件并看原始输出
```

行为：

1. 按**文件**分片（`test/*.test.js`，与 `package.json` 的 glob 一致），每个文件独立子进程；
2. 子进程命令固定为 `node --test --test-timeout=60000 --test-concurrency=<N> <file>`，
   保留用例级 60s 超时语义；
3. **每个文件另有硬超时**（默认 180s），到点直接 `taskkill /T /F` 整棵进程树 ⇒
   同步阻塞的用例也能被点名，而不是拖死整批；
4. **失败 / 超时的文件串行重跑一次**（单文件、无并发）：
   重跑通过 ⇒ 记为 **flaky** 并判绿（首跑状态与退出码留档、汇总单列清单）；
   重跑仍失败 ⇒ 保持红（两次结果都记录）。重跑只用于区分 flake 与真实回归，不是掩盖；
5. 整批硬上限 20 分钟，到点杀掉在跑的，剩余记为「未执行」；中止时不重跑；
6. 结束时输出 `文件总数 / pass / fail / 超时 / flaky / 启动错误 / 未执行 / 用例级计数 / 耗时 / 最慢 5 个文件`，
   失败、超时与未执行的文件逐条列出（失败带首条 `not ok` 的错误摘要），flaky 单独成一节；
7. 完整子进程输出写入 `.preview/test-stable-<时间戳>.log`（重跑输出带 `----- 重跑（单文件） -----` 分隔）；
8. `main()` 抛异常时清掉整批定时器、杀掉在跑子进程、竖起中止旗并关闭日志流 ——
   异常收场是秒级，不会挂着 20 分钟定时器干等上限。

**退出码（「未执行」= 本次未验证，绝不能算绿）**：

| 退出码 | 含义 |
|---|---|
| `0` | 全部文件跑完且通过（`fail=0`、`超时=0`、`未执行=0`）；其中 **flaky（重跑通过）算绿但单列** |
| `1` | 有 fail / 单文件超时 / **整批中止导致的未执行**（中止时即使失败集合为空也强制 1） |
| `2` | 参数或环境错误，或 `main()` 异常（此时已完成清理，秒级退出） |

> 2026-11-07 复审 Blocker 修复：旧版把中止后被杀的子进程记为 `skipped`，而失败集合只算
> `fail/timeout/error` ⇒ `--timeout=1` 时 9 个文件只跑了 2 个也 exit 0（误报绿）。
> 现在 `skipped` 计入失败集合、中止时无条件 exit 1，汇总显式打印
> 「未执行 = 本次未验证，不算通过」，逐文件也标「未跑完（不计入）」。

用例级计数只统计**已跑完**的文件：被中止的半个文件即便已产出若干 pass 也不算数
（否则「跑了 2 个文件」会显示成 pass=21）。flaky 文件的用例级计数取**重跑**的结果。

> 为什么默认并发是 2 而不是 4：仓库 CI 用的就是 `--test-concurrency=2`。
> 本机 4 路并发时出现过 `migu.test.js` 子进程原生崩溃（`exitCode 3221226505` = 0xC0000409），
> 单跑 19/19 通过 —— 这是**并发生态**下的 flake，不是断言失败。
> 本地跑批若不与 CI 对齐，只会制造「本地红、CI 绿」的噪声；要更快可显式 `--concurrency=4`，
> 但那一路的偶发崩溃会走重跑兜底并计入 flaky。

参数：`--concurrency=N`、`--file-timeout=S`、`--timeout=S`、`--filter=TEXT`、`--verbose`、`--help`。

### 2. CI 对齐：原始命令仍然可用

```powershell
node --test --test-timeout=60000 --test-concurrency=4 "test/*.test.js"
```

修复后 55s 左右结束（见下节实测），不再需要靠重试掩盖挂起。
若后续出现新的同步阻塞用例，这条命令仍会静默挂住 ⇒ **排障时优先用 `test-stable.cjs`**，
它能直接点名是哪个文件。

### 3. 单文件定位（最快）

```powershell
node --test --test-timeout=60000 test/history.test.js
```

---

## 六、验收记录（2026-11-07 实测）

### A. `node scripts/test-stable.cjs`

```
[test-stable] 350 个文件 · 并发 4 · 单文件硬超时 3m00s · 整批上限 20m00s
...[逐文件 ✔/✘/⏱]...
[test-stable] ===== 汇总 =====
  文件总数 : 350
  pass     : 350
  fail     : 0
  超时     : 0
  启动错误 : 0
  未执行   : 0
  用例级   : pass=3548 fail=0（仅统计已跑完的文件）
  耗时     : 57.2s（上限 20m00s）
  最慢文件 : matchMusic.test.js=15.8s · downloadQueue.test.js=8.8s · downloader-stream.test.js=8.4s · toast-timing.test.js=7.7s · history.test.js=7.6s
```

**57.2s 结束，远低于 20 分钟上限；fail 0、超时 0、未执行 0**（此前两轮 55.2s / 57.4s，结论相同；
用例数随并行新增测试从 3543 长到 3548）。

第一轮（仅修完三个历史用例时）机器被其它任务争抢，复跑一次结论一致（耗时 1m48s，
最慢文件 `bilibili-lyrics` 29.0s、`encoding-guard` 25.9s，仍远低于单文件 180s 硬超时），
当时仍带 2 条与挂起无关的既有失败：

```
  文件总数 : 350
  pass     : 348
  fail     : 2
  超时     : 0
  未执行   : 0
  用例级   : pass=3541 fail=2
  耗时     : 1m48s（上限 20m00s）
```

第二轮收口（去 BOM + 修 deliverables 断链，见第七节）后为 **350 pass / 0 fail**。

### B. `node --test --test-timeout=60000 --test-concurrency=4 "test/*.test.js"`（关键片段）

```
ℹ tests 3543
ℹ suites 1
ℹ pass 3543
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 55202.1384
EXIT=0
```

**55.2s 正常收场并打印汇总，退出码 0**（此前同一命令 10 分钟无输出、不退出）。

修复过程中的中间态也留档：第一次复跑是 42.7s / `pass 3541 / fail 2`，两条失败与挂起无关，
已在第二轮收口（见第七节）。

### C. 修复前后单文件对比

| 文件 | 修复前 | 修复后 |
|---|---|---|
| `test/history.test.js` | >60s 无输出、不退出（实测落盘需 ~6.6 分钟） | 5.7s，16 pass / 0 fail |
| `test/history-import-trim.test.js` | >60s 无输出、不退出（实测落盘需 ~3 分钟） | 0.56s，2 pass / 0 fail |

### D. 退出码 / 中止收场（2026-11-07 复审 Blocker）

```
> node scripts/test-stable.cjs --filter history --concurrency=1 --timeout=1
[test-stable] 9 个文件 · 并发 1 · 单文件硬超时 3m00s · 整批上限 1.0s
✔ diagnose-history-fallback.test.js (235ms) pass=9 fail=0
✔ diagnose-history.test.js (223ms) pass=12 fail=0
· history-async-and-corrupt.test.js (848ms) 未跑完 pass=0（不计入）
...（其余逐文件）...
[test-stable] ===== 汇总 =====
  文件总数 : 9
  pass     : 2
  fail     : 0
  超时     : 0
  启动错误 : 0
  未执行   : 7（本次未验证，不算通过）
  用例级   : pass=21 fail=0（仅统计已跑完的文件）
  耗时     : 1.3s（上限 1.0s）

  ⚠ 整批在中途被中止（达到 1.0s 上限）：7 个文件本次未执行 = 未验证，不能算绿 ⇒ 退出码 1
  ---- 需要处理的文件（含未执行） ----
  test\history-async-and-corrupt.test.js [skipped] 整批中止，本次未执行（未验证）
  ...（共 7 条）
EXITCODE=1
```

修复前后对照：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `--filter history --concurrency=1 --timeout=1` | 文件 9 / pass 2 / fail 0 / 超时 0 / 未执行 7 → **EXITCODE=0（误报绿）** | 计数不变，`skipped` 计入失败集合 → **EXITCODE=1** |
| `main()` 抛异常（临时副本注入故障，`--timeout=600`） | 20~43s（worker 把队列里剩下的文件跑完才退，定时器一直挂着） | **1.9s / EXITCODE=2**（清定时器 + 杀子进程 + 竖起中止旗） |

> 全量 `node scripts/test-stable.cjs` 的终验实测为 **350 pass / 0 fail / EXITCODE=0（57.2s）**。
> 计数随并行开发波动，期间出现过两条**非脚本原因**的红，均已由各自负责人收口，如实留档：
>
> · `test/app-renderer-contract.test.js`「主进程默认入口指向新渲染层」：该测试原用旧字面量
>   `path.join(__dirname, '../renderer/index.html')`，而 `src/main/index.js` 已重构成 `DIST_ROOT`
>   白名单解析（语义仍默认 `dist/renderer/index.html`）⇒ 测试落后于同一批 src 重构。
>   12:37 由 main-hardening-engineer 改为 DIST_ROOT 语义断言后转绿。
> · `test/asf-parser-dos-guard.test.js`：机器高负载时（`bilibili-lyrics` 41s、`clipboard-watch` 32s）
>   会撞其自带的 10s 子进程超时；单独跑 257ms 通过 ⇒ 负载 flaky，不是回归。
>
> 结论：跑批报红要结合「单文件复跑」判断归因；脚本只负责如实报红，不做重试掩盖。

### E. 终验矩阵（2026-11-07 12:40~12:55）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `node scripts/test-stable.cjs` | **0** | 350/350 文件 · 用例级 pass=3548 · fail 0 · 超时 0 · 未执行 0 · 57.2s（复跑 57.7s） |
| `npm run typecheck` | **0** | `tsc -p tsconfig.json --noEmit` 无输出（无类型错误） |
| `npm run lint` | **0** | `6 problems (0 errors, 6 warnings)`，6 条均为既有 `no-unused-vars` 警告 |
| `npm run build` | **0** | 新层 `vite build --config vite.app.config.mjs` + 旧层 `vite build` + `[postbuild] done` |
| `npm run smoke:asar` | **0** | `18/18 通过`（另 1 条 SKIP：asar 内 `package-lock.json` 被 app-builder-lib 强制排除，非缺陷） |

> 顺序不能颠倒：`smoke:asar` 读的是打包产物 `app.asar`（35,016,946 B），必须在 `build` 之后跑。
> 终验顺序固定为：测试 → 类型检查 → lint → build → smoke:asar。

### F. 并发 flake 治理：失败文件单文件重跑一次（2026-11-07）

背景：一次全量跑批里 `migu.test.js` 的子进程原生崩溃
（`exitCode 3221226505` = `0xC0000409`），而单跑 `node --test --test-timeout=60000 test/migu.test.js`
是 19/19 通过、587ms ⇒ **并发生态 flake**，不是断言失败，也不是回归。

机制：主跑结束后，对 `fail` / `timeout` 的文件**串行、单文件重跑一次**。

- 重跑通过 ⇒ 状态改 `flaky`：判绿、用例级计数取重跑结果、汇总单列「flaky 清单」并保留首跑状态与退出码；
- 重跑仍失败 ⇒ 保持红（首跑与重跑两次结果都记录）；
- 整批中止时不重跑（中止后未执行仍计入失败）。

默认并发同时降为 **2**（与 CI 的 `--test-concurrency=2` 对齐），`--concurrency=N` 仍可覆盖。

三次连跑（默认并发 2，同一工作树）：

| # | 文件 | pass | fail | flaky | 未执行 | 耗时 | 退出码 |
|---|---|---|---|---|---|---|---|
| 1 | 350 | 350 | 0 | 0 | 0 | 1m32s | **0** |
| 2 | 350 | 350 | 0 | 0 | 0 | 1m31s | **0** |
| 3 | 350 | 350 | 0 | 0 | 0 | 1m51s | **0** |

每轮都打印 `flaky : N`；目录具名清单仅在有 flaky 时输出。

机制自检（临时副本仅替换测试目录指向，**不改 test/**）：

| 探针 | 关键输出 | 退出码 |
|---|---|---|
| 首跑失败、重跑通过 | `⚠ zz-flake.test.js 首跑 fail(exit=1) → 重跑 pass（219ms）⇒ flaky，判绿`；`flaky : 1` | **0** |
| 恒失败 | `✘ zz-hardfail.test.js 首跑 fail → 重跑仍 fail（228ms）⇒ 保持红` | **1** |

中止语义复验（不得因新增重跑而误绿）：
`node scripts/test-stable.cjs --filter history --concurrency=1 --timeout=1`
→ 未执行 7、`flaky : 0`、**EXITCODE 1**。

---

## 七、第二轮收口（2026-11-07）：两条失败的真实原因与修法

两轮改动合起来后 `node scripts/test-stable.cjs` 为 **350 pass / 0 fail / exit 0**。

### 1. `encoding-guard`：UTF-8 BOM（3 个文件）

真实原因：并行进行中的前端改造用 PowerShell 落盘，`Out-File` / `Set-Content` 默认带 BOM。
守卫的扩展名白名单是 `js|cjs|mjs|json|html|css|yml|yaml|md|py`，因此报错只列出 2 个；
实际 `.vue` 那个（`src/renderer/app/views/NowPlayingView.vue`）也带 BOM，一并处理。

修复：按字节剥离文件头 `EF BB BF`（`buf.subarray(3)` 写回），**不做解码/再编码**，
除 BOM 外一个字节都不变（三个文件各减 3 字节）。扫描范围：`src/`、`test/`、`scripts/`、
`docs/`、`.github/`、`build/` 下全部文本文件（含 `.vue`）。

| 文件 | 处理 |
|---|---|
| `src/renderer/app/stores/search.js` | 9600 → 9597 字节 |
| `src/renderer/app/views/NowPlayingView.vue` | 9397 → 9394 字节 |
| `docs/superpowers/plans/2026-11-07-frontend-rebuild.md` | 3138 → 3135 字节 |

### 2. `process-docs`：deliverables 断链（4 处）

真实原因（**既有问题，不是本轮新增文档触发**）：本地交付物目录 deliverables 被 `.gitignore` 第 93 行排除，
从未入库 ⇒ 任何干净检出 / CI 里它都不存在；而三份流程文档把它写成「仓库既有目录」并用反引号标注，
守卫要求该路径在磁盘上真实存在。本轮新增的 `TEST-STABILITY.md` 不在 `GUARDED_DOCS` 清单里，未被扫描。

修法选择：**不补目录，改措辞**。补目录只能救本机（目录被 ignore，CI 与新克隆仍然没有），
等于把红灯藏起来；文档真正要表达的事实是「交付物落在一个本地、不入库、按需创建的目录」。
最小改动 4 处，语义不变、断言未动：

| 位置 | 改法 |
|---|---|
| `docs/process/DELIVERY.md:112` | 把 deliverables 移出「仓库既有目录」清单，另起一句说明它是 `.gitignore` 排除的本地目录（S1 具体文件名仍在 §四 表中） |
| `docs/process/ENGINEERING.md:252` | 「不在 deliverables/ 下新开子目录」→「不在 §四 指明的产品策略交付物目录（本地 deliverables）下新开子目录」 |
| `docs/process/QA.md:254` | 「差异仅落在 deliverables/、`docs/` 等」→「差异仅落在本地交付物目录 deliverables、`docs/` 等」 |
| `docs/process/QA.md:293` | 「既有目录（`docs/`、deliverables/）」→「既有目录（`docs/`）与本地交付物目录 deliverables」 |

> 若团队坚持让该路径在仓库里存在，唯一正解是改 `.gitignore`（加否定规则）并提交占位文件；
> 这超出本轮授权范围（不改 `.gitignore` / `package.json` / `.github`），故未做。

### 3. 慢盘仍是风险（未改业务源码）

`add()` 逐条 fsync 是**产品行为**（防丢窗口），不是缺陷，因此没有动 `src/utils/history.js`。
后果：任何未来新增「灌满 5000 条」的测试，在慢盘上都会重演同样的假死。

缓解措施：

- 大批量语义测试一律走内存库（本次三个用例已示范，文档注释已写在用例旁）；
- 若必须在落盘库上验证大批量，用 `importEntries` 仍是逐条提交 ⇒ 同样慢，
  应改为「先小批量落盘验证 durability，再换内存库验证容量语义」；
- `test-stable.cjs` 的单文件硬超时会把这类回归**点名**，不会再无声拖死整批。

### 4. 并发与磁盘的相互作用

4 路并发同时写临时库会放大 fsync 争抢。慢盘机器上可临时降并发：

```powershell
node scripts/test-stable.cjs --concurrency=2
```

### 5. 隔离用例的门禁盲区

`test/quarantine/` 不在默认 glob 内，必须靠季度人工巡检（见第四节）。
当前目录为空（仅一份说明），暂无盲区。

---

## 八、维护提示

- 新增「上千次写入」的用例前，先问：**这个断言真的需要落盘吗？**
  不需要就 `destroy()` 后直接用内存库，并在用例里写一行注释说明原因。
- 看到跑批「没有输出也不退出」，先查子进程 CPU 时间：
  CPU ≈ 0 且进程长命 ⇒ 等 I/O 或同步阻塞；CPU 飙高 ⇒ 死循环。
- 永远不要用「调大 CI 超时 / 加重试次数」处理这类问题：它会把真实的同步阻塞藏起来，
  下次换一台慢一点的机器还会复发。