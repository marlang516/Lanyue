# 清理 src/renderer/、test/ 和 src/main/subscriptions.js 下的 unused vars

## 目标
消除以下文件的 ESLint no-unused-vars warning。每个变量必须先验证确实未使用（包括动态引用、模板字符串、解构等 eslint 可能漏检的用法），确认是死代码后再删。

## 需要改的文件
- `src/main/subscriptions.js` — 删除未使用的 `PREFS_KEY`、`TYPES`、`domainIsDue`（3 个 warning）
- `src/renderer/js/playback/engine.js` — 删除/加前缀 `song` 参数（line 369，验证后处理）
- `test/app-renderer-contract.test.js` — 删除未使用的 `vm` 导入（验证后删除）
- `test/hostApi.test.js` — 删除未使用的 `identityRedact` 导入（验证后删除）
- `test/playback-crossfade.test.js` — 删除未使用的 `EQ_SRC` 变量（验证后删除）
- `test/resolveTrackOptions.test.js` — 删除未使用的 `getUrl` 变量（验证后删除）
- `test/userSourceValidator.test.js` — 删除未使用的 `deriveCapabilities` 导入（验证后删除）

## 操作步骤
1. 逐个文件打开，阅读上下文
2. 对每个 warning 验证变量确实未使用（grep 全仓库确认无引用）
3. 删除死代码（变量声明、函数定义、导入语句）
4. 如果有函数参数未使用，加 `_` 前缀（如 `_song`）而不是删除（保持签名兼容）
5. 运行 `npm run lint` 确认这些 warning 消失
6. 运行 `npm test` 确认无回归
7. commit

## 验收检查
```bash
npm run lint && npm test
```

## 不要做
- 不要碰 `src/main/ipc/`（属于另一个 bee）
- 不要碰 `package.json`（属于另一个 bee）
- 不要删除任何可能被动态调用的函数或测试钩子
- 不要修改任何逻辑，只删除死代码
