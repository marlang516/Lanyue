# M2 现状基线（只读测绘）

> 采集时间：2026-11-09  
> 采集方式：只读命令（Get-ChildItem / Get-Content / Select-String）  
> 全部数字为实测值；无法确认的标注「待实测」。  
> 本文档只做测绘，不含任何代码改动。

---

## 一、`src/renderer/js/` 现状

### 1.1 整体体量（实测）

| 指标 | 实测值 |
|---|---|
| 文件总数（含 `.json`） | 174（其中 `.js` 172、`.json` 2） |
| `.js` 文件数 | **172** |
| `.js` 总行数 | **28949** |
| `.js` 平均行数 | **168.31 行/文件** |
| 最大文件 | `src/renderer/js/views/local.js` 1384 行 |
| 文件类型 | 全部 `.js`（语言文件 `lang/en.json`、`lang/zh.json` 除外） |

### 1.2 `.js` 文件 Top 10（按行数）

| 行数 | 文件 |
|---|---|
| 1384 | `src/renderer/js/views/local.js` |
| 1252 | `src/renderer/js/app.js` |
| 1107 | `src/renderer/js/views/ai-music.js` |
| 1077 | `src/renderer/js/views/playlist.js` |
| 1041 | `src/renderer/js/player.js` |
| 1017 | `src/renderer/js/views/home.js` |
| 894 | `src/renderer/js/views/search.js` |
| 714 | `src/renderer/js/views/download.js` |
| 713 | `src/renderer/js/views/artist.js` |
| 712 | `src/renderer/js/views/album.js` |

> 注：`lang/*.json`（各 858 行）为语言资源文件，不计入 `.js` 统计口径。

---

## 二、TypeScript 配置纳入范围（实测）

- `tsconfig.renderer.json`（L1-L25）：`include` 仅包含 `src/renderer/app/**/*.js`、`src/renderer/app/**/*.vue`、`src/renderer/app/**/*.ts`。
- **结论：`src/renderer/js/` 不在 `tsconfig.renderer.json` 的 include 范围内。**（与 M1-BASELINE.md §1.2 一致）

---

## 三、全仓对 `src/renderer/js/` 的引用清单（实测）

使用只读命令在全仓范围内搜索 `renderer/js`（含正斜杠/反斜杠）：

```powershell
Select-String -Path "F:\新建文件夹\Lanyue" -Pattern "renderer/js"
Select-String -Path "F:\新建文件夹\Lanyue" -Pattern "renderer[/\\]js" -Include "*.js","*.ts","*.vue","*.json","*.md"
```

**实测结果：全仓无任何文件引用 `src/renderer/js/`（`require` / `import` 路径均未命中）。**

| 引用文件 | 引用次数 | 引用形态 |
|---|---|---|
| （无） | 0 | （无） |

**当前耦合面：0。**

---

## 四、冻结声明（M2）

**M2 期间，`src/renderer/js/` 保持冻结：**

- **不新增任何引用**：禁止在任何源码文件中新增 `require` / `import` 指向 `src/renderer/js/` 的路径。
- **不新增文件**：禁止在 `src/renderer/js/` 目录下新增任何文件。
- **不修改现有文件**：禁止修改 `src/renderer/js/` 下的任何现有文件（`.js`、`.json` 均在冻结范围内）。

该目录仅作为遗留渲染层保留，不参与 `src/renderer/app` 的 TS 迁移范围。

---

## 五、后续删除里程碑（建议）

**建议删除里程碑编号：`M3` —— 「renderer/js 遗留层删除」**

### 删除时机
在 M3 中，逐步将所有仍需使用的能力从 `src/renderer/js/` 迁出至 `src/renderer/app`（或其他合适的模块）后，再删除整个 `src/renderer/js/` 目录。

### 删除里程碑退出条件草案（可验证）

| 序号 | 退出条件 | 验证方式 |
|---|---|---|
| 1 | **引用数归零** | 全仓搜索 `renderer/js`（`require`/`import`）无命中。 |
| 2 | **类型检查仍绿** | `npm run typecheck`、`npm run typecheck:renderer` 均 exit 0。 |
| 3 | **构建正常** | `npm run build` exit 0，`dist/renderer/index.html` 与 `dist/renderer-legacy/index.html` 均正常产出。 |
| 4 | **测试全绿** | `node scripts/test-stable.cjs` 全部通过（fail 0）。 |
| 5 | **目录可安全删除** | 删除 `src/renderer/js/` 后，上述 1-4 项仍全部通过。 |

---

## 六、与 M1-BASELINE.md 对齐

- **M1**：已明确 `src/renderer/js/` 为遗留渲染层（172 个 js，28949 行），不在 `tsconfig.renderer.json` include 范围内，属于**排除项**，声明「需在里程碑中显式声明不碰」。
- **M2**：继续冻结 `src/renderer/js/`，**不新增引用、不新增文件、不修改现有文件**，并在本文档中显式给出后续删除里程碑编号（**M3**）及退出条件草案。
- **M3**：在迁出全部引用后，删除整个 `src/renderer/js/` 目录。

---

## 附录：所用只读命令

```powershell
# 统计 renderer/js 文件数（含 json）
Get-ChildItem -Path "F:\新建文件夹\Lanyue\src\renderer\js" -Recurse -File | Measure-Object

# 统计 .js 文件数、总行数、平均行数
$jsFiles = Get-ChildItem -Path "F:\新建文件夹\Lanyue\src\renderer\js" -Recurse -File -Filter *.js
$total = 0; $jsFiles | ForEach-Object { $c = (Get-Content $_.FullName).Count; $total += $c }
Write-Output "JS文件数: $($jsFiles.Count)"; Write-Output "JS总行数: $total"; Write-Output "JS平均行数: $([math]::Round($total/$jsFiles.Count, 2))"

# Top 10（按行数）
(Get-ChildItem -Path "F:\新建文件夹\Lanyue\src\renderer\js" -Recurse -File -Filter *.js | ForEach-Object { $c = (Get-Content $_.FullName).Count; [PSCustomObject]@{File=$_.FullName; Lines=$c} }) | Sort-Object Lines -Descending | Select-Object -First 10

# 全仓引用搜索
Select-String -Path "F:\新建文件夹\Lanyue" -Pattern "renderer/js"
Select-String -Path "F:\新建文件夹\Lanyue" -Pattern "renderer[/\\]js" -Include "*.js","*.ts","*.vue","*.json","*.md"

# 确认 tsconfig.renderer.json include 范围
Get-Content "F:\新建文件夹\Lanyue\tsconfig.renderer.json"
```