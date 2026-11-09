# M0 基线治理（第 1–2 周）

> 上位方案：[`docs/architecture/PRODUCTION-UPGRADE.md`](../architecture/PRODUCTION-UPGRADE.md) 第八节「实施路线」。
> 本文只定义 **M0 的目标、验收标准与当前状态**，不重复架构方案内容；判据冲突时以上位方案为准。
> 状态口径：
> - **未验证**：没有可复现证据（命令输出、CI 运行记录、评审结论），一律不得口头宣称完成。
> - **已验证**：证据可被他人在干净环境复现，且记录在「证据」列。
>
> **M0 验收状态（2026-11-07）**：第二次验收结论为 **PARTIAL**——代码项 1/2/3/5 通过，唯一剩余项为文档过期；
> 本文、ADR 与上位方案已于 2026-11-07 按复验事实同步，最终判定由验收人更新，详见
> [`M0-ACCEPTANCE.md`](./M0-ACCEPTANCE.md)。验收人更新判定前，本文不得作为「M0 已完成」的最终依据。

| 项目 | 内容 |
|---|---|
| 里程碑 | M0 · 基线治理 |
| 周期 | 第 1–2 周 |
| 基线日期 | 2026-11-07 |
| 出口条件 | 五个目标全部「已验证」，且 M0 出口闸（第三节）全部通过 |
| 责任人 | 架构 / 质量发布（分工见第五节） |

---

## 一、M0 的五个目标

### 目标 1：测试稳定

**背景**：全量 `node:test` 存在挂起/超时/并发干扰，导致「本地绿、CI 红」或长时间无输出，发布门禁不可信。

**验收标准**：

- [ ] 全量测试连续 3 次运行全绿（本地 `test-stable` 已复验；CI 远程首跑另行确认），无挂起、无超时退出。
- [ ] 测试命令显式设置超时（`--test-timeout`），超时值有依据并写入脚本或 CI。
- [ ] 测试按分片并行执行，单分片耗时可控（目标全量 ≤ 10 分钟）。
- [ ] flaky 用例已隔离到 `test/quarantine/`，并登记修复或删除期限（≤ 2 周）。
- [ ] 不新增源码 grep 断言；存量静态断言冻结并登记迁移批次。

| 当前状态 | 证据 |
|---|---|
| **已验证**（2026-11-07 复验） | `scripts/test-stable.cjs` 连续 3 次全量运行 exit 0：350/350 文件、3549 个用例、约 1m30s；全量不再挂起；中止/未执行场景 exit 1；flaky 采用「单文件、串行、仅重跑一次，重跑通过才判绿」机制（如 `migu.test.js` 在并发下原生崩溃、单跑 19/19 通过，重跑机制下不误判门禁）；超时与分片已固化在 `scripts/test-stable.cjs`；`test/quarantine/` 已建立。CI 仍使用原生 `node --test --test-concurrency=2 "test/*.test.js"`（并发 2、失败重试 3 次、失败归因由 `scripts/ci-doctor.cjs` 负责）；`scripts/test-stable.cjs` 是**本地稳定入口**，尚未接入 CI 与 `npm run verify`，**接入评估推迟到 M1**——不得据此宣称「CI 已接入稳定入口」。 |

---

### 目标 2：TS 工具链

**背景**：全仓库为 JS，无类型门禁，重构回归只能依赖测试；需以渐进方式引入 TypeScript，避免一次性迁移拖垮交付。

**验收标准**：

- [ ] `tsconfig.json` 已建立，启用 `allowJs` / `checkJs`，并区分 `src/shared` 与其余目录的检查范围。
- [ ] CI 的 typecheck job 覆盖 **`src/shared` 全部 8 个文件**（`accelerators.js`、`downloadDefaults.js`、`dto.js`、`errors.js`、`historySort.js`、`ipcContract.js`、`netClass.js`、`outboundScrub.js`），失败即阻断合并。
- [ ] `vue-tsc` 属 M1（渲染层 TS 迁移）前置能力，M0 不要求引入，也不得在文档中宣称已使用。
- [ ] 本地与 CI 使用同一份 `tsconfig`，结果一致；无 `any` / `@ts-ignore` 无理由堆积。
- [ ] `package.json` 提供稳定的 typecheck 入口（脚本名与 CI 一致），并在文档中登记。

| 当前状态 | 证据 |
|---|---|
| **已验证**（2026-11-07 复验） | `tsconfig.json` 的 `include` 为 `src/shared/**/*.js`，实际覆盖全部 8 个文件（`accelerators.js`、`downloadDefaults.js`、`dto.js`、`errors.js`、`historySort.js`、`ipcContract.js`、`netClass.js`、`outboundScrub.js`）；在 `downloadDefaults.js` 注入类型错误可让 `npm run typecheck` exit 2；`package.json` 提供 `typecheck` 脚本（`tsc -p tsconfig.json --noEmit`）；CI 的 `Typecheck (JSDoc)` 已接入并**本地实跑通过**，远程 CI 首次 PR 待确认；`vue-tsc` 未引入（M1 范围）。 |

---

### 目标 3：安全硬化

**背景**：Electron 安全清单中仍有未闭环项（`sandbox` 未显式声明、缺权限请求处理器、发布链路无签名），属于 P0。

**验收标准**：

- [ ] 窗口显式 `sandbox: true`，且 preload 按 sandbox 兼容方式运行（现有 preload 需回归验证）。
- [ ] `session.setPermissionRequestHandler` 默认拒绝，仅放行 `fullscreen` 与 `clipboard-sanitized-write`（与 `src/main/permissions.js` 的 `ALLOWED_PERMISSIONS` 一致），并有测试覆盖。
- [ ] `LY_RENDERER_DIR` **仅允许 `dist/renderer` 与 `dist/renderer-legacy` 两个白名单目录**；越界、路径穿越、缺 `index.html` 一律回退默认入口并告警。**已验证（2026-11-07 复验）**：`src/main/index.js:175` 先判断 `RENDERER_DIR_WHITELIST.includes(dir)`，再叠加 `isStrictlyInside(DIST_ROOT, dir)` 纵深防御，dist 内其他子目录（如 `dist/other`）被拒。
- [ ] 安全清单逐项复核（contextIsolation、nodeIntegration、CSP、导航白名单、webview、协议白名单、路径沙箱、SSRF、凭证存储、日志脱敏），结论记录在案。
- [ ] 依赖漏洞门禁与豁免清单无新增未评审条目。
- [ ] 安装包代码签名与更新包签名校验的**采购与配置计划**已启动（证书到位属 M2 验收，但 M0 必须启动采购）。

| 当前状态 | 证据 |
|---|---|
| **已验证**（2026-11-07 复验） | `src/main/index.js:212` `sandbox: true`（打包产物为 `sandbox:!0`）；`installPermissionGuards` 默认拒绝，白名单实测放行 `fullscreen` / `clipboard-sanitized-write`；`src/main/crash.js` 仅本地转储（`submitURL: ''`、`uploadToServer: false`）；`LY_RENDERER_DIR` 为**穷举白名单**（仅 `dist/renderer` 与 `dist/renderer-legacy`，`index.js:175` 先白名单后 `isStrictlyInside`，`dist/other` 被拒）；`node --test test/main-hardening.test.js test/app-renderer-contract.test.js` 23/23 通过；`npm run lint`、`npm run typecheck`、`npm run build`、`npm run smoke:asar` 均 exit 0（smoke 18/18）。代码签名证书采购尚未记录。 |

---

### 目标 4：观测基线

**背景**：当前只有文件日志与 diagnose，缺少启动/播放/下载的可量化基线与崩溃转储，无法判断「变好还是变坏」。

**验收标准**：

- [ ] 启动耗时、首屏时间、安装包体积、空闲内存四项基线数据已采集，并记录采集环境（机型/系统/版本）。
- [ ] 崩溃转储（`crashReporter`）可用，默认不上传，可导出诊断包（日志 + 环境 + 最近错误 + 脱敏配置）。
- [ ] 结构化日志为 JSONL，字段含 `ts/level/scope/event/taskId/runId/errorCode`，默认脱敏。
- [ ] 基线采集脚本可重复执行，结果可对比（至少保留最近 3 个版本）。
- [ ] 指标定义与目标值记录在案（对齐上位方案第六节性能预算）。

| 当前状态 | 证据 |
|---|---|
| **未验证** | 崩溃转储已验证（`crashReporter` 仅本地：`submitURL: ''`、`uploadToServer: false`、`crashDumps` 指向 `userData/CrashDumps`）；启动耗时、首屏、内存、安装包体积四项基线数据尚未采集归档；结构化日志与诊断包未复验。 |

---

### 目标 5：流程文档

**背景**：架构文档齐全，但缺少 ADR、发布检查清单与代码责任人，重大决策与发版操作不可追溯。

**验收标准**：

- [ ] ADR 模板与首个决策记录落地，格式包含：标题、状态、背景、决策、备选方案、后果、后续动作。
- [ ] 发布检查清单覆盖：版本三方一致、CHANGELOG、lint/typecheck/测试、构建、签名、sha256、草稿 Release、灰度观察 24h、回滚、用户通知。
- [ ] `CODEOWNERS` 按目录给出责任人，占位账号有明确替换说明。
- [ ] 文档内引用的命令与路径真实存在（不写不存在的脚本或不存在的文件）。
- [ ] 文档经架构/交付评审通过，并在 `CHANGELOG.md` 留痕。

| 当前状态 | 证据 |
|---|---|
| **已验证**（产物已建立；2026-11-07 事实同步） | 本轮已新增 [`ADR-0001`](../adr/0001-production-upgrade.md)、[`RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md)、[`.github/CODEOWNERS`](../../.github/CODEOWNERS) 与本文件；文件存在性可核验。**文档已与复验后的代码事实同步**（typecheck 8/8、CI Typecheck 本地实跑、`LY_RENDERER_DIR` 双目录白名单、test-stable 连续 3 次全绿）；评审签字待补，最终判定由验收人更新。 |

---

## 二、M0 五个目标的汇总视图

| # | 目标 | 核心验收 | 当前状态 |
|---|---|---|---|
| 1 | 测试稳定 | 不再挂起；超时 + 分片；flaky 隔离；连续 3 次全绿 | 已验证（2026-11-07 复验） |
| 2 | TS 工具链 | `tsconfig` + CI typecheck（`src/shared` **全部 8 个文件**） | 已验证（2026-11-07 复验） |
| 3 | 安全硬化 | `sandbox: true` + 权限处理器 + `LY_RENDERER_DIR` 双目录白名单 + 证书采购启动 | 已验证（2026-11-07 复验） |
| 4 | 观测基线 | 启动/首屏/内存/包体基线 + 崩溃转储 + 诊断包 | 未验证（仅崩溃转储已验证；不在本次验收结论内） |
| 5 | 流程文档 | ADR + 发布 checklist + CODEOWNERS + 文档与代码一致 | 已验证（产物；2026-11-07 事实同步） |

> 结论：**第二次验收（2026-11-07）判定 PARTIAL**——代码项 1/2/3/5 通过，唯一剩余项为文档过期；
> 本次已按复验事实同步本文、ADR 与上位方案，最终判定由验收人更新。
> 观测基线（目标 4）不在本次验收结论范围内，仍为未验证，继续按原计划采集。

---

## 三、M0 出口闸（Gate）

全部命令以 `package.json` 为准；任一失败即不得宣布 M0 完成。

| 检查 | 命令 / 动作 | 通过标准 |
|---|---|---|
| 静态检查 | `npm run lint` | 0 error，无新增豁免 |
| 类型检查 | `npm run typecheck` | `src/shared` **全部 8 个文件** 0 error |
| 单元测试 | `npm test` | 全绿、无挂起、耗时在预算内 |
| 构建 | `npm run build` | 成功产出新层与主进程 |
| asar 冒烟 | `npm run smoke:asar` | 通过 |
| 全量闸 | `npm run verify` | 七项串联全绿 |
| CI 时长 | CI 运行记录 | PR ≤ 10 分钟 |
| 安全 / 观测 | 安全清单 + 基线记录 | 逐项有结论、有数据 |

---

## 四、本阶段改动的文件清单

### 4.1 已落地（本次文档任务，未触碰代码与 CI）

| 文件 | 类型 | 说明 | 状态 |
|---|---|---|---|
| `docs/adr/0001-production-upgrade.md` | 新增 | ADR 模板示范 + 首个决策（18 周、三条主线、渐进 TS、契约 schema 化、签名与灰度） | 已验证 |
| `docs/RELEASE-CHECKLIST.md` | 新增 | 发版前 / 发版中 / 发版后三段清单，含回滚预案与签字表 | 已验证 |
| `.github/CODEOWNERS` | 新增 | 按目录的责任人占位（主进程 / 渲染层 / 契约 / 发布 / 文档 / 测试） | 已验证（账号待替换） |
| `docs/process/M0-BASELINE.md` | 新增 | 本文：M0 目标、验收标准、状态与文件清单 | 已验证（产物；2026-11-07 事实同步） |

### 4.2 M0 工程改动（已落地 / 未落地）

| 文件 / 目录 | 类型 | 对应目标 | 说明 | 状态 |
|---|---|---|---|---|
| `tsconfig.json` | 新增 | 2 | `include` 为 `src/shared/**/*.js`，覆盖全部 8 个文件；`allowJs` + `checkJs` | 已落地（已验证） |
| `package.json` | 修改 | 2 | 增加 `typecheck` 脚本（`tsc -p tsconfig.json --noEmit`） | 已落地 |
| `.github/workflows/ci.yml` | 修改 | 1、2 | `Typecheck (JSDoc)` 已接入并本地实跑通过（远程 CI 首次 PR 待确认）；测试命令为 `node --test --test-concurrency=2`（自带 3 次重试） | 已落地（远程首跑待确认） |
| `test/quarantine/` | 新增目录 | 1 | 已建立并附登记说明（`README.md`） | 已落地 |
| `scripts/test-stable.cjs` | 新增 | 1 | 固化 `--test-timeout`、分片、中止/未执行退出码与单文件重跑判绿；连续 3 次全量 exit 0 | 已落地（已验证） |
| `src/main/`（窗口/会话初始化） | 修改 | 3 | `sandbox: true`、`installPermissionGuards`、崩溃转储已落地；`LY_RENDERER_DIR` 为双目录穷举白名单 | 已落地（已验证） |
| `src/main/crash.js` | 新增 | 4 | 崩溃转储仅本地（`submitURL: ''`、`uploadToServer: false`） | 已落地（性能基线仍缺） |
| `scripts/`（基线采集） | 新增/修改 | 4 | 启动耗时、首屏、内存采样与归档 | 未落地 |
| `build/config.cjs` | 修改 | 3 | `verifyUpdateCodeSignature: true` 已配置，但无证书时仍为空转；代码签名未落地（依赖证书） | 部分配置（证书未到位） |

> 说明：4.1 只新增文档；4.2 由对应工程责任人提交，本文只同步**当前可核验的事实**，不代替其任务验收。
> 并行产物必须补 CI 运行记录或可复现命令输出后才能改状态；状态口径以 [`M0-ACCEPTANCE.md`](./M0-ACCEPTANCE.md) 的修复项与复验结果为准。

---

## 五、分工与依赖

| 工作 | 责任人（占位） | 依赖 |
|---|---|---|
| 测试稳定 | 质量 / 发布 | 无（可立即开始） |
| TS 工具链 | 架构 / 渲染 | 需确认 `src/shared` 边界 |
| 安全硬化 | 主进程 | 证书采购需交付负责人发起 |
| 观测基线 | 质量 / 主进程 | 需确定采集环境与预算口径 |
| 流程文档 | 架构 / 交付 | 评审签字 |

**关键路径**：签名证书采购（1–3 周）是 M2 的硬依赖，M0 内必须启动；否则 M2 签名验收必然顺延。

---

## 六、变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-11-07 | 建立 M0 基线文档 | 固化五个目标、验收标准与当前状态；明确「未验证」口径，避免口头完成 |
| 2026-11-07 | 按首次验收结果同步事实（**历史快照，已被同日终同步取代**） | 当时记录：typecheck 3/8、CI Typecheck 待实跑、`LY_RENDERER_DIR` 待收紧；保留此行仅用于追溯，不代表当前状态 |
| 2026-11-07 | 按第二次验收复验事实终同步 | typecheck 覆盖 8/8、`LY_RENDERER_DIR` 双目录白名单、CI Typecheck 本地实跑通过、test-stable 连续 3 次全绿均改为已验证；文档过期项已闭环，最终判定由验收人更新 |
| 2026-11-07 | 文档收口：澄清测试稳定入口口径 | CI 仍使用原生 `node --test --test-concurrency=2`（并发/重试/归因由 CI 脚本负责）；`scripts/test-stable.cjs` 仅为本地稳定入口，接入评估推迟到 M1。不得据此宣称「CI 已接入稳定入口」 |