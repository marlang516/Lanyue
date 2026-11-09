# 揽乐生产级升级重构方案

> 版本：2026-11-07
> 范围：Electron 主进程、Vue 渲染层、共享契约、数据层、测试与发布体系
> 目标：从「功能完整、单机可用」升级为「可维护、可观测、可回滚、可审计」的生产级桌面应用

---

## 一、结论摘要

三条主线，18 周、4 个里程碑：

1. **架构收敛**：主进程按 domain / infra / ipc 分层，下载引擎拆分；共享契约成为唯一事实源并生成类型与 preload；旧渲染层限期删除。
2. **质量工程**：引入 TypeScript（渐进 strict）+ 行为测试金字塔 + Electron E2E；把脆弱的源码 grep 断言迁出主门禁；CI 增加 typecheck / coverage / E2E。
3. **发布与信任**：代码签名、更新包签名校验、灰度与回滚、结构化日志与崩溃转储、性能预算。

不追求「一次重写」，而是**双轨演进 + 每周可发布**。

---

## 二、现状评估

| 维度 | 现状（证据） | 生产级要求 | 差距 | 优先级 |
|---|---|---|---|---|
| 进程安全 | contextIsolation、无 nodeIntegration、CSP、导航拦截、协议白名单、approvedDirs、secretStore | 全项清单 + 权限处理器 + sandbox 显式化 | 未显式 `sandbox: true`；无 `setPermissionRequestHandler` | P0 |
| IPC 契约 | `src/shared/ipcContract.js` 26KB、111 个 METHODS、启动覆盖对账 | 契约生成类型/客户端/文档/MCP | 纯 JS 手写，类型与实现可能漂移 | P0 |
| 主进程结构 | `index.js` 23KB、`downloadQueue.js` 39KB、ipc 15 模块 | 领域边界清晰、单文件可控 | 编排与业务混在入口；引擎过大 | P1 |
| 渲染层 | 新 Vue3 层已切换，旧层保留为 `renderer-legacy` | 单层、类型化、可测试 | 双轨并存；无类型；组件级测试缺失 | P1 |
| 测试 | 380+ 个 `node:test` 文件；大量静态源码断言（renderer-audit 39KB 等） | 单元/集成/E2E 金字塔 | 行为覆盖不足；重构即红的断言多；E2E=0 | P0 |
| 类型 | 全 JS；typecheck 已覆盖 `src/shared` 全部 8 个文件（已验证） | 核心域 strict TS | strict 与核心域覆盖仍缺失 | P0 |
| CI | 已有 lint/audit 豁免/死依赖/攻击面/单测重试/构建冒烟 | + typecheck + coverage + E2E + 产物签名 | 缺类型与 E2E 门禁 | P0 |
| 发布 | tag→草稿 Release，仅 Windows | 签名安装包、更新签名、灰度、回滚 | 无证书，`verifyUpdateCodeSignature` 空转 | P0 |
| 可观测 | 文件日志、diagnose、redact | 结构化日志、崩溃转储、指标、诊断包 | 无崩溃报告与启动/播放指标 | P1 |
| 数据 | history SQLite；prefs JSON | 统一迁移框架、备份/恢复演练 | prefs 大 JSON 读写；无迁移版本治理 | P1 |
| 性能 | 无预算与基线 | 启动/首屏/内存/包体预算 | 无采集脚本 | P2 |
| 文档 | architecture 齐全；ADR 已建立首个决策 | ADR、运维手册、发布清单 | 缺运维手册与事故响应 | P2 |
| 平台 | Windows 实证；mac/linux 有配置未验证 | 明确支持矩阵 | 发布面窄 | P3 |

**已有优势（不要重做）**：IPC 契约派生白名单、参数钳制、启动覆盖对账、MCP 同源、SSRF/路径沙箱、Cookie 安全存储、原子写、下载终态立即落盘、CI 归因脚本。

---

## 三、目标架构

### 3.1 主进程分层

```
src/main/
  bootstrap/        app 生命周期、窗口、托盘、快捷键、单实例
  ipc/              薄适配层：参数校验 → 调用 domain，错误 → 统一错误码
  domain/           纯业务，禁止 import electron
    download/       engine（状态机）/ queue / persistence / policy / transfer
    library/        scan / index / metadata / lyrics
    playlist/       user playlists / favorites / trash
    history/        repository（SQLite）
    subscriptions/  （已下线，保留只读/手动能力）
  infra/            可替换实现
    storage/        sqlite、prefs、atomicFile、migrations
    net/            request / gateway / urlGuard / cors
    secrets/        secretStore
    logging/        structured logger + redaction
    updater/        updater / mirror / signature
  platforms/         manifest + adapter
  mcp/              server / tools / audit
```

依赖规则（用 ESLint `no-restricted-imports` + dependency-cruiser 固化）：

- `domain` 不得 import `electron`、`main/ipc`、`main/bootstrap`
- `ipc` 只能 import `domain` 与 `infra` 的公开入口
- `infra` 不得 import `domain`
- 单文件软上限 800 行，超限必须拆分或写 ADR

### 3.2 共享契约与类型

```
src/shared/
  contract/
    channels.ts     通道枚举 + 方向 + 窗口可见性
    schema.ts       参数/返回 schema（zod）
    methods.ts      方法映射
    events.ts       事件映射
  dto/              Song / QueueItem / HistoryEntry / Playlist ...
  errors.ts         错误码（ASCII）+ 用户文案键
  generated/        preload-methods.ts / client-types.ts / mcp-tools.ts / contract.md
```

契约从「手写对象」升级为「schema 单一事实源」，通过脚本生成：

1. preload 白名单方法
2. 渲染层 `bridge` 的 TS 类型
3. MCP 工具清单
4. 契约文档
5. 契约测试（数量/方向/形状自动断言，不再手写 111 常量）

### 3.3 渲染层

```
src/renderer/app/
  core/        bridge(typed) / i18n / format / dialog / toast
  stores/      player / queue / search / library / download / playlist / settings / ui
  features/    discover / search / library / download / playlist / player / settings
  components/  shell / data / player / controls
  styles/
```

- `<script setup lang="ts">`，`strict: true`；DTO 用契约生成的类型
- 禁止直接访问 `window.musicAPI/ipcRenderer`（已有门禁，保留）
- 视图不写业务规则：规则进 store/domain
- 大列表统一虚拟滚动；封面统一 `loading="lazy"` + 尺寸约束

### 3.4 数据层

- SQLite 为唯一持久层：history、assets、playlists、favorites、trash、settings（可分批迁移）
- `PRAGMA user_version` + migrations 数组；每次迁移可回滚（备份 → 迁移 → 校验）
- 导出格式带 `formatVersion`；导入做白名单与版本校验
- 启动时一致性检查（孤儿引用、路径失联），失败只降级不阻断

---

## 四、质量工程

### 4.1 测试金字塔

| 层 | 目标占比 | 工具 | 内容 |
|---|---|---|---|
| 单元 | 70% | node:test | domain 纯函数、状态机、schema、排序/去重、错误码 |
| 集成 | 20% | node:test + 内存 SQLite + mock 平台 | IPC handler 端到端、队列落盘/恢复、导入导出 |
| E2E | 10% | Playwright + Electron | 启动、搜索、播放、下载队列、设置、更新提示 |

硬规则：

- **禁止新增源码 grep 断言**。现有静态断言冻结，重构完成后逐批替换为行为测试并删除。
- 每个 P0 缺陷必须附一条回归测试。
- flaky 用例隔离到 `test/quarantine/`，两周内修复或删除。

### 4.2 CI/CD 目标流水线

PR（≤10 分钟）：

1. `npm ci`
2. `lint` + `typecheck`
3. 单元 + 契约 + 安全静态检查（audit/dead-deps/attack-surface）
4. 构建（新层 + 主进程）与 asar 冒烟
5. 覆盖率上传（不阻断，先看趋势）

main（≤25 分钟）：

6. 集成测试 + E2E smoke（3 条）
7. Windows 打包 + 产物校验（sha256、文件清单）

release：

8. 版本三方一致 + CHANGELOG
9. 代码签名 + 时间戳 + 更新包签名
10. 草稿 Release + 产物哈希
11. 灰度：先发布 Release 但延迟 `latest.yml` 更新（或版本门控），观察 24h
12. 回滚：保留上一版安装包与 latest.yml，脚本一键回退

### 4.3 覆盖率门槛

- `src/shared` 90%
- `src/main/domain` 80%
- 整体 60%
- 新增代码 80%（diff coverage）

---

## 五、安全与发布

### 5.1 Electron 安全清单（逐项验收）

- [x] contextIsolation true / nodeIntegration false
- [x] `sandbox: true` 显式声明（preload 已按 sandbox 兼容设计）
- [x] `session.setPermissionRequestHandler` 默认拒绝，白名单为 `fullscreen` / `clipboard-sanitized-write`（`media` / `notifications` 均拒绝）
- [x] 导航/新窗口白名单
- [x] 禁用 webview（确认无 `webviewTag`）
- [x] CSP 严格，`lanyue-stream:` 放行并有测试
- [x] 自定义协议不绕过 CSP
- [x] 路径沙箱 + 批准目录
- [x] SSRF guard + 逐跳重定向校验
- [x] 凭证 DPAPI/安全存储，日志脱敏
- [ ] 安装包代码签名
- [ ] 更新包签名校验（依赖签名证书）
- [ ] SBOM（CycloneDX）+ 依赖签名
- [x] 依赖漏洞门禁（含显式豁免清单）

### 5.2 签名与信任链

1. 采购 Windows OV/EV 代码签名证书（周期 1–3 周）
2. electron-builder 配置 `CSC_LINK` / `CSC_KEY_PASSWORD`（CI secret）
3. `verifyUpdateCodeSignature` 由「空转」变为真实约束
4. mac 若发布：Developer ID + notarize；Linux 用 GPG 签名
5. 发布页展示 sha256 与签名指纹

### 5.3 威胁模型（STRIDE 摘要）

- 远端内容（歌词/封面）→ XSS：CSP + 最小 preload + 无 innerHTML
- 本地文件 → 任意读写：approvedDirs + realpath 复核
- 剪贴板/拖拽 → 注入：链接解析走白名单
- MCP/Agent → 越权工具：风险分级 + 审批 + 审计
- 更新通道 → 中间人：签名 + 镜像 fail-closed
- 依赖供应链 → 恶意包：lockfile + audit + SBOM

---

## 六、可观测性与性能

### 6.1 可观测

- 结构化日志：JSONL、滚动、字段 `ts/level/scope/event/taskId/runId/errorCode`，默认脱敏
- 崩溃：`crashReporter` 本地 dumps；默认不上传；设置页提供「导出诊断包」
- 指标（本地聚合，不上传）：
  - 启动耗时、首屏时间
  - 播放成功率、取流失败码分布、平均首帧时间
  - 下载成功率、重试率、平均速度、失败码
  - IPC 错误率、慢调用 Top 10
- 诊断包：日志 + 环境 + 最近 100 条错误 + 配置（脱敏）

### 6.2 性能预算

| 指标 | 预算 | 采集 |
|---|---|---|
| 冷启动到可交互 | ≤ 2.5s | 埋点 + CI 基线 |
| 首屏渲染 | ≤ 1.2s | 埋点 |
| 常驻内存（空闲） | ≤ 300MB | 手动基线 |
| 安装包 | ≤ 120MB | 构建产物 |
| 10k 曲库列表滚动 | ≥ 55fps | 虚拟列表 + profiler |
| 下载并发 | 全局/分平台可配，默认 3/2 | 设置项 |

原则：主进程不做同步 IO；DB 建索引；封面/歌词缓存有上限与淘汰。

---

## 七、数据迁移与双轨退出

1. 双轨期保留 `renderer-legacy` 一个版本，仅应急回退。
2. 数据兼容：prefs 键与导出格式保持向前兼容；SQLite 迁移带备份。
3. 旧层删除前置条件：
   - 新层 E2E 全绿 2 周
   - 崩溃率与关键失败率不高于旧层
   - 用户回退请求为 0
   - 旧层静态断言已迁移或删除
4. 删除动作：源码、测试、构建脚本、`LY_RENDERER_DIR` 回退分支、文档同步。

---

## 八、实施路线（18 周）

### M0 · 基线治理（第 1–2 周）

- 定位全量测试挂起（句柄泄漏/超时/并发），固化 `--test-timeout` 与分片
- 建立性能与崩溃基线采集
- 引入 TS 工具链（`tsconfig`、`allowJs`、`checkJs`；`vue-tsc` 推迟到 M1 渲染层 TS），CI 加 `typecheck`（覆盖 `src/shared` **全部 8 个文件**，已验证）
- 建立 ADR 模板、发布 checklist、CODEOWNERS
- 验收：CI ≤ 10 分钟；typecheck 覆盖 `src/shared` 8/8；测试全量在 CI 稳定

> **M0 实况（2026-11-07）**：**已验收通过（第四次验收 VERDICT: PASS）**。代码项：typecheck 覆盖 `src/shared` 全部 8 个文件（已验证）；CI Typecheck 已接入并本地实跑通过（远程 CI 首次 PR 待确认）；`LY_RENDERER_DIR` 仅允许 `dist/renderer` 与 `dist/renderer-legacy` 两个白名单目录（已验证）；test-stable 连续 3 次全量 exit 0（350/350、3549 用例；flaky 采用单文件重跑判绿）；沙箱 `sandbox: true`、权限允许列表仅 `fullscreen` + `clipboard-sanitized-write`、本地崩溃转储与 `[perf]` 日志已落地。文档口径已终同步（历史节显式标注为历史），asar 产物已按最新源码重打包并通过 18/18 冒烟。遗留项（CI 接入 test-stable、legacy 可加载性断言、行号漂移）移交 M1，均未写成已验证。
> 状态、证据与修复项见 [`docs/process/M0-ACCEPTANCE.md`](../process/M0-ACCEPTANCE.md)。

### M1 · 架构与类型（第 3–8 周）

- 契约 schema 化 + 代码生成（preload/types/mcp/docs）
- 主进程 domain/infra/ipc 分层；下载引擎拆为 engine/queue/persist/transfer
- 渲染层全量 TS（strict），DTO 使用生成类型
- 数据迁移框架与备份/恢复
- 验收：`domain` 无 electron 依赖；单文件 ≤ 800 行；typecheck 全绿

> **M1 进展（2026-11-08）**
>
> **已完成**
>
> 1. **下载域垂直分层**：`src/main/downloadQueue.js` **956 → 395** 行，拆出 `src/main/downloadQueue/` 下 **7 个子模块**（`naming` / `persist` / `ports` / `store` / `scheduler` / `events` / `songTask`）；12 个 phase 有效行均 **≤ 40**；单文件 ≤ 800 行达标；ADR-0003 状态 **Accepted**。
> 2. **渲染层全量 TS strict**：`npm run typecheck:renderer` **0 error**（`strict` 未放宽），全仓 703 → 630 → 150 → 67 → **0**；CI `Typecheck (Renderer)` 门禁**已转硬**（删除 `continue-on-error`，注入类型错误可令 CI 变红，exit 2 / TS2322）。
>
> **未完成**
>
> 1. **契约 schema 化仅 1/19**：仅 `save-download-template.template` 有 `t.shape` 字段级 schema 样板，其余 18 个 `obj` 参数（及 21 个 `any`）仍无字段级 schema；preload / renderer 类型尚未由契约生成。
> 2. **数据迁移框架与备份/恢复未启动**：仍为 prefs 大 JSON 读写，无 `PRAGMA user_version` 迁移链、无迁移前后备份与回滚演练。
> 3. **主进程 domain / infra / ipc 分层仅下载域完成**：曲库、歌单、历史、订阅等其余域仍在 `src/main/ipc/*` 直接调用，未按 3.1 目标架构分层。
>
> **结论**：**M1 未全部完成，不得标记为 M1 完成**。下一步优先级建议：**契约 schema 化 → 其余域分层 → 数据迁移**。

### M2 · 质量与发布（第 9–14 周）

- 测试金字塔：domain 单测补齐、IPC 集成、Playwright E2E 5 条
- 静态断言迁移计划执行 50%
- 代码签名 + 更新签名 + 产物校验
- 结构化日志 + 崩溃转储 + 诊断包
- 灰度与回滚脚本
- 验收：domain 覆盖率 ≥ 80%；E2E 稳定；签名安装包可升级

### M3 · 性能与验收（第 15–18 周）

- 启动/首屏/内存优化与预算门禁
- 旧层删除
- 运维手册、事故响应、SLO
- 生产验收（见第九节）
- 验收：全部指标达标；回滚演练通过

---

## 九、生产级验收标准

| 维度 | 标准 |
|---|---|
| 功能 | 核心链路（搜索→播放→下载→曲库→歌单）E2E 覆盖 |
| 稳定性 | 7 天崩溃率 < 0.5%；关键失败率 < 1% |
| 安全 | 清单全绿；安装包/更新包签名验证通过 |
| 性能 | 启动/首屏/内存/包体达预算 |
| 可维护 | 核心域 strict TS；单文件 ≤ 800 行；ADR 覆盖重大决策 |
| 发布 | 一键发版、灰度、回滚演练成功 |
| 数据 | 迁移/备份/恢复演练成功，无数据丢失 |
| 文档 | 架构、运维、发布、故障手册齐全 |

---

## 十、风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 第三方平台 API 变更/失效 | 高 | 高 | 平台适配层 + 能力位 + 快速降级 + 探针 |
| 签名证书采购周期 | 中 | 高 | M0 启动采购，M2 前到位 |
| 重构期间功能冲突 | 中 | 中 | 双轨 + 每周集成 + 特性开关 |
| 全量测试不稳定 | 高 | 中 | M0 先治理，隔离 flaky，CI 分片 |
| TS 迁移拖慢交付 | 中 | 中 | 渐进 strict，先 shared/domain |
| 旧层删除回归 | 中 | 高 | 灰度 + 回滚包 + 删除前 E2E 双周 |
| 数据迁移损坏 | 低 | 高 | 迁移前备份 + 校验 + 回滚脚本 |

---

## 十一、本周即可做的 10 件事

1. 用 `--test-timeout` + 分片定位全量测试挂起
2. CI 增加 `typecheck`（先覆盖 `src/shared`）
3. 为 IPC 契约建立 schema 与代码生成脚本（POC 3 个通道）
4. 主进程加 `sandbox: true` 与权限处理器
5. 下载引擎按 engine/queue/persist/transfer 拆第一刀
6. 加启动耗时与崩溃转储最小埋点
7. 写 3 条 Playwright E2E（启动/搜索/播放）
8. 发起代码签名证书采购
9. 建立 ADR 模板与发布 checklist
10. 制定旧层删除检查表与日期

---

## 十二、投入估算

| 角色 | 投入 | 主要职责 |
|---|---|---|
| 架构/主进程 | 1.0 FTE | 分层、契约、引擎拆分、数据迁移 |
| 渲染/类型 | 1.0 FTE | TS 迁移、组件与 store、E2E 配合 |
| 质量/发布 | 0.5–1.0 FTE | 测试金字塔、CI、签名、灰度、可观测 |

合计约 **45–55 人周**（含缓冲 20%）。