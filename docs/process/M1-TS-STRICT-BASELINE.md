# M1 渲染层 TS strict 基线（M1.1 工具链）

> 建立时间：2026-11-07
> 目的：把 `src/renderer/app` 纳入 `strict + checkJs` 的类型检查，**先留证据、再谈收敛**。
> 本文档只描述工具链现状与收敛计划；基线错误数的权威值以 M1.0 首次复跑结果为准。

---

## 一、工具链现状（已落地并核验）

| 项 | 值 | 位置 |
|---|---|---|
| 类型检查器 | `vue-tsc ^2.2.12`（`typescript ^5.9.3`） | `package.json:72` |
| 脚本 | `"typecheck:renderer": "vue-tsc -p tsconfig.renderer.json --noEmit"` | `package.json:22` |
| 配置 | `extends ./tsconfig.json`；`strict: true`、`allowJs: true`、`checkJs: true`、`noEmit: true`、`moduleResolution: "bundler"`、`types: ["vite/client"]` | `tsconfig.renderer.json:1-25` |
| include | `src/renderer/app/**/*.{js,vue,ts}`（共 44 个源文件 / 6324 行，见 `M1-BASELINE.md` §1.2） | `tsconfig.renderer.json:19-23` |
| CI | 新增步骤 `Typecheck (Renderer, baseline)`，`continue-on-error: true` | `.github/workflows/ci.yml:67-69` |

口径说明：

- 根 `npm run typecheck`（`tsc -p tsconfig.json`）继续只覆盖 `src/shared`（8/8），**不含**渲染层。
- 两者互不替代：shared 是 IPC 契约的边界（必须永远 0 error），renderer 是逐步收敛的迁移面。

### 1.1 为什么 CI 先设 `continue-on-error: true`

`src/renderer/app` 当前全部是 JS + Vue（无 `.ts`），在 `strict + checkJs` 下必然一次性报出数百条错误（历史实跑引用值 **703 条**，记录于 `ci.yml:60` 的注释；本轮未复跑，不作为验收数字）。

如果这一轮就设 `false`：

- CI 会从“红一次”变成“红一个月”，红灯不再指向新回归；
- 迁移期间的每次提交都会被同一条历史错误挡住，团队会习惯性忽略 CI。

因此该步骤**当下只负责留证据**：每次跑都产出同一批数字，用于验证基线没有漂移。

⚠️ 收敛到 0 之后必须删除 `continue-on-error: true`，见第五节。

---

## 二、基线复现命令

```powershell
New-Item -ItemType Directory -Force .preview | Out-Null
npm run typecheck:renderer 2>&1 | Tee-Object -FilePath .preview/typecheck-renderer.log
```

- 退出码非 0 **属预期**（存在基线错误）。
- 统计错误总数：`Select-String -Path .preview/typecheck-renderer.log -Pattern 'error TS\d+' | Measure-Object`
- 按错误码统计：
  `Select-String -Path .preview/typecheck-renderer.log -Pattern 'error TS\d+' | ForEach-Object { ($_.Line -split 'error ')[1].Split(':')[0] } | Group-Object | Sort-Object Count -Descending`
- 按文件统计：把同一行的 `TSxxxx` 换成文件路径正则（`[^\(]+`）再分组。

### 2.1 当前基线错误数

| 项 | 值 | 状态 |
|---|---|---|
| 错误总数 | **2026-11-08 已归零**；历史基线 703（引用）→ 分四批收敛（core 83 / stores 295 / components 78 / views 67） | 已实测（0 error） |
| 按文件 Top 10 | 不适用（0 error） | 已归零 |
| 按错误码 Top 5 | 不适用（0 error；收敛期以 TS7006 隐式 any、TS2339 属性不存在、TS2307 模块解析为主） | 已归零 |

> 规则：在 M1.0 首次复跑之前，**任何文档都不得把 703 写成已验证基线**。

---

## 三、分批收敛计划

按“依赖从内到外、耦合从低到高”排序：

| 批次 | 范围 | 文件数 / 行数 | 主要风险 | 退出判据 |
|---|---|---|---|---|
| **B1** | `src/renderer/app/core/**`（bridge/dialog/format/i18n/prefs/recent/song/toast） | 8 / 546 | `bridge.js` 是唯一 IPC 出口，类型一旦写死会反向约束契约 | 该批文件错误数 = 0；`bridge.call/callSafe` 的签名以 JSDoc `@template` 表达，不引入 `any` |
| **B2** | `src/renderer/app/stores/**` | 9 / 2018 | store 持有跨域状态，类型会牵出 IPC 返回值形状 | 该批错误数 = 0；store 对外暴露的 state/action 有显式返回类型；不得用 `// @ts-ignore` |
| **B3** | `src/renderer/app/components/**` | 15 / 1621 | SFC props/emits 需成对声明，易漏 | 该批错误数 = 0；每组件有 `defineProps`/`defineEmits` 且类型来自 `core/` 或 `src/shared` |
| **B4** | `src/renderer/app/views/**` + `App.vue`/`main.js`/`player.js` | 12 / 2139 | 视图改动面最大，E2E 覆盖薄 | 全量 `typecheck:renderer` = 0 error；`strict` 未放宽；构建与冒烟通过 |

每批评判标准一致：

1. 该批文件错误数归零；
2. 下一批开工后，本批不得回涨（CI 步骤保留 `continue-on-error` 期间靠人工比对日志）；
3. 不允许以 `any` / `@ts-ignore` / 放宽 `tsconfig` 换绿——出现即视为未完成。

### 3.1 `.js` → `.ts` 的迁移策略

- `core`/`stores`：直接改扩展名，保留 JSDoc 作为过渡，逐步替换为 TS 类型注解。
- `components`/`views`：`<script setup>` → `<script setup lang="ts">`，props 用 `defineProps<T>()`。
- 每次只改一个批次，**禁止一次提交跨两批**。
- `src/renderer/js/`（旧层，172 文件 / 28949 行）**不在 include 内，不碰**，其删除属 M3。

---

## 四、风险与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| 隐式 any 洪水（TS7006） | 函数参数逐个报错，看似无底洞 | 优先给 `core/` 的导出函数补参数类型，stores/views 多数错误会随之消失 |
| IPC 返回值无类型 | `bridge.call()` 返回 `any`，转成 `unknown` 后全链路报错 | 依赖 M1 契约 schema 化（L1）产出 `src/shared/generated/*.d.ts`，`bridge` 按通道名映射返回类型 |
| Vue SFC 类型能力有限 | 模板内表达式错误定位模糊 | 先保证 `<script>` 部分 0 error，模板错误留到 B4 统一处理 |
| 基线与主分支漂移 | 两人并行改同一批文件导致数字忽高忽低 | 每批开工前复跑一次并记录到 `.preview/typecheck-renderer.log`，作为该批基线 |

---

## 五、`continue-on-error` 的退出条件（强制）

满足以下**全部**条件后，必须在同一 PR 内删除 `.github/workflows/ci.yml:68` 的 `continue-on-error: true`：

1. `npm run typecheck:renderer` 全量 **0 error**，且 `tsconfig.renderer.json` 的 `strict` 仍为 `true`；
2. 仓库内 `src/renderer/app` 下不存在 `@ts-ignore` / `@ts-expect-error`（除带原因的临时豁免，且需在本文档登记）；
3. 反向验证：在任一 `core/*.ts` 故意注入一个类型错误，CI 的 `Typecheck (Renderer)` 步骤必须变红；删掉注入后恢复绿；
4. `package.json` 的 `verify`（若有）包含 `typecheck:renderer`。

未满足第 1 条之前删除 `continue-on-error`，等同于恢复“红灯一个月”，禁止。

> **状态（2026-11-08）**：已删除 `ci.yml` 的 `continue-on-error`，并通过注入类型错误验证 CI 会变红（exit 2 / TS2322），随后恢复 exit 0。

---

## 六、与其他 M1 子线的关系

- **L1 契约 schema 化**：为 `bridge` 提供返回值类型，是 B2 的硬前置（B1 可先行）。
- **L2 下载域迁出**：`stores/download.js` 的 API 形状会变，B2 中该文件应排在 L2 之后或与之协同。
- **L4 单例治理**：不影响渲染层类型，但会改 `bridge` 暴露的方法集合，需同步更新 B1 的类型表。

---

## 附录：变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 新建：vue-tsc 2.2.12 接入、`tsconfig.renderer.json`、CI baseline 步骤、四批收敛计划 |
| 2026-11-08 | 渲染层 TS strict 归零：703 → 630 → 150 → 67 → **0**（core 83 / stores 295 / components 78 / views 67）；删除 CI `continue-on-error`，反向验证 exit 2 / TS2322 → 恢复 exit 0；§2.1 与 §5 同步更新 |
