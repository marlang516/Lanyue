# 清理 src/main/ipc/ 下的 unused vars（lint warnings）

## 目标
消除以下文件的 ESLint no-unused-vars warning。每个变量必须先验证确实未使用（包括动态引用、模板字符串、解构等 eslint 可能漏检的用法），确认是死代码后再删。

## 需要改的文件
- `src/main/ipc/ai-assistant.js` — 删除未使用的 `setAssistantPort` 函数（已确认未导出、未调用）
- `src/main/ipc/ai-music.js` — 删除未使用的 `setAiMusicPort` 函数（已确认未导出、未调用）
- `src/main/ipc/mcp.js` — 删除未使用的 `setMcpPort` 函数（已确认未导出、未调用）
- `src/main/ipc/songStory.js` — 删除未使用的 `setStoryPort` 函数（已确认未导出、未调用）
- `src/main/ipc/tasteProfile.js` — 删除未使用的 `setTastePort` 函数（已确认未导出、未调用）
- `src/main/ipc/download/exportPlaylist.js` — 删除未使用的 `setExportPlaylistPort` 函数（已确认未导出、未调用）
- `src/main/ipc/playlist.js` — 删除未使用的 `FAVORITES_NAME` 和 `songKey` 变量（验证后删除）
- `src/main/ipc/playlist/domain/index.js` — 删除未使用的 `now` 参数（验证后删除或加 `_` 前缀）
- `src/main/ipc/library/domain/dupScan.js` — 删除未使用的 `logger` 导入（验证后删除）
- `src/main/ipc/search/domain/download.js` — 删除未使用的 `logger` 参数（验证后删除或加 `_` 前缀）
- `src/main/ipc/search/domain/home.js` — 删除未使用的 `validateKeyword` 导入（验证后删除）
- `src/main/ipc/search/domain/link.js` — 删除未使用的 `validateKeyword` 导入（验证后删除）
- `src/main/ipc/search/domain/lyrics.js` — 删除未使用的 `validateKeyword` 导入（验证后删除）
- `src/main/ipc/search/domain/playlist.js` — 删除未使用的 `validateKeyword` 导入（验证后删除）

## 操作步骤
1. 逐个文件打开，阅读上下文
2. 对每个 warning 验证变量确实未使用（grep 全仓库确认无引用）
3. 删除死代码（变量声明、函数定义、导入语句）
4. 如果有函数参数未使用，加 `_` 前缀（如 `_now`）而不是删除（保持签名兼容）
5. 运行 `npm run lint` 确认这些 warning 消失
6. 运行 `npm test` 确认无回归
7. commit

## 验收检查
```bash
npm run lint && npm test
```

## 不要做
- 不要碰 `src/main/subscriptions.js`（属于另一个 bee）
- 不要碰 `src/renderer/` 和 `test/`（属于另一个 bee）
- 不要碰 `package.json`（属于另一个 bee）
- 不要删除任何可能被动态调用的函数（如 `_handle`、`_statusForTest` 等测试钩子）
- 不要修改任何逻辑，只删除死代码
