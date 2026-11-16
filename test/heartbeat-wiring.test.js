/**
 * 心动模式接线守卫
 *
 * 分两层：
 *   1. 纯逻辑（heartbeatPick.js）：去重 / 缺字段丢弃 / 瘦身白名单；
 *   2. 接线：契约 ↔ IPC 注册 ↔ 渲染层队尾钩子 ↔ 设置页开关 ↔ 语言包。
 *
 * 为什么要有第 2 层：心动模式的失败方式全是「静默不生效」——
 * 通道没注册、prefs 键没进设置表、i18n 缺键、player 队尾没接上，
 * 任一环漏了都不报错，只是永远不续播。这里让每环都有一条断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const fresh = (rel) => import(`../${rel}?ck=${Math.random()}`);

test('契约：generate-heartbeat 已声明且导出 camelCase 方法', () => {
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /'generate-heartbeat':\s*\{/, '通道必须写进 CHANNELS');
  assert.match(contract, /generateHeartbeat:\s*'generate-heartbeat'/, 'METHODS 必须导出渲染层方法');
  assert.match(contract, /currentSong:\s*t\.shape\(/, 'currentSong 用嵌套 shape 校验');
  assert.match(contract, /exclude:\s*t\.arr\(/, 'exclude 必须有数组上限');
});

test('契约：嵌套 shape 递归校验（非法嵌套必须被拒）', () => {
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /case 'shape': return coerceShape\(spec, v\) === v;/, 'shapeFieldMatches 要递归支持 shape');
});

test('主进程：IPC 模块注册通道，装配根注入红心与网关', () => {
  const ipc = read('src/main/ipc/heartbeat.js');
  assert.match(ipc, /handle\('generate-heartbeat'/, '必须走 register.handle（契约校验 + 来源闸）');
  assert.match(ipc, /heartbeatEngine\.generate\(/, 'IPC 只做装配，算法在 utils/heartbeatEngine');

  const assembly = read('src/main/ipc/index.js');
  assert.match(assembly, /ipcHeartbeat\.register\(\{/, '装配根必须调用 heartbeat.register');
  assert.match(assembly, /ensureFavorites\(playlistInfra\.prefs\.loadUserPlaylists\(\)\)/, '红心种子必须来自同一份 prefs 适配器');
  assert.match(assembly, /gateway: require\('\.\.\/\.\.\/api\/recommendations'\)/, '网关复用 recommendations 单例');

  const main = read('src/main/index.js');
  assert.match(main, /require\('\.\/ipc\/heartbeat'\)/, 'main 必须加载 heartbeat 域模块');
  assert.match(main, /ipcPlaylistAudit, ipcHeartbeat, createSubscriptions/, 'main 必须把它传进 registerAllIpcHandlers');
});

test('渲染层：队尾只在「自然播完」分支调用续播，且只追加不替换', () => {
  const player = read('src/renderer/js/player.js');
  assert.match(player, /import \{ refillPlayQueue \} from '\.\/heartbeat\.js'/, 'player 必须导入续播入口');
  assert.match(player, /added = await refillPlayQueue\(\)/, '队尾分支必须真的调用');
  const heartbeat = read('src/renderer/js/heartbeat.js');
  assert.match(heartbeat, /setState\('playQueue', \(getState\('playQueue'\) \|\| \[\]\)\.concat\(fresh\)\)/, '心跳接线只允许 concat 追加');
  const hook = player.match(/if \(playIdx >= playQueue\.length - 1\) \{[\s\S]*?refillPlayQueue\(\)[\s\S]*?\n {4}\}/);
  assert.ok(hook, '续播必须挂在「不循环且到末尾」的分支里，不能改动循环/随机模式');
});

test('设置页：开关进入 GENERAL_PREFS 表 + HTML 元素 + 双语键', () => {
  const general = read('src/renderer/js/views/settings/general.js');
  assert.match(general, /heartbeatEnabled: \{ key: 'heartbeatEnabled', default: false, el: 'settingHeartbeatEnabled' \}/);

  const html = read('src/renderer/index.html');
  assert.match(html, /id="settingHeartbeatEnabled"/);
  assert.match(html, /data-i18n="settings\.general\.heartbeat"/);

  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  for (const key of ['settings.general.heartbeat', 'heartbeat.added']) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`);
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`);
  }
});

test('heartbeatPick：按 source:id 去重、缺字段丢弃、保持候选顺序', async () => {
  const { pickHeartbeatSongs, heartbeatSongKey } = await fresh('src/renderer/js/heartbeatPick.js');
  const existing = [
    { id: 'a', source: 'netease' },
    { id: 0, source: 'qq' },
    null,
    { id: 'x' }, // 缺 source
  ];
  const incoming = [
    { id: 'a', source: 'netease' },   // 队列已有
    { id: 0, source: 'qq' },          // 队列已有（0 也要按值判等）
    { id: 'b', source: 'kugou' },
    { id: 'b', source: 'kugou' },     // 候选内重复
    { id: 'no-src' },
    { id: 'c', source: 'kuwo' },
  ];
  const out = pickHeartbeatSongs(existing, incoming, 10);
  assert.deepEqual(out.map(heartbeatSongKey), ['kugou:b', 'kuwo:c']);
  assert.deepEqual(pickHeartbeatSongs([], incoming, 1).map(heartbeatSongKey), ['netease:a']);
  assert.deepEqual(pickHeartbeatSongs([], null), []);
});

test('heartbeatPick：瘦身只保留契约声明的字段', async () => {
  const { slimHeartbeatSong } = await fresh('src/renderer/js/heartbeatPick.js');
  const slim = slimHeartbeatSong({
    id: 7, source: 'qq', title: 't', artist: 'a', album: 'b',
    cover: 'http://x', pay: 1, url: 'http://y', filePath: 'C:/z',
  });
  assert.deepEqual(Object.keys(slim).sort(), ['album', 'artist', 'id', 'source', 'title']);
  assert.equal(slim.id, 7);
  assert.equal(slim.cover, undefined);
  assert.equal(slimHeartbeatSong({ title: '缺 id' }), null);
  assert.equal(slimHeartbeatSong(null), null);
});

test('preload：事件订阅返回退订函数（窗口重建不累积监听器）', () => {
  const preload = read('src/main/preload.js');
  assert.match(preload, /return \(\) => ipcRenderer\.removeListener\(channel, handler\)/, 'musicAPI 事件订阅必须可退订');
  assert.match(preload, /SAFE_CHANNELS_RECEIVE\.has\(channel\)\) return \(\) => \{\}/, '未授权通道返回空退订函数');
  const secondary = read('src/main/preload-secondary.js');
  assert.match(secondary, /removeListener\(channel, handler\)/, '二级窗口同样要能退订');

  const dl = read('src/renderer/js/dlStatus.js');
  assert.match(dl, /export function addDlChangeListener\(fn\) \{[\s\S]*?return \(\) => \{[\s\S]*?splice\(i, 1\)/, '渲染层订阅要能移除');
});
