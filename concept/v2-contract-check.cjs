/**
 * 新渲染层 IPC 接线契约校验（无头可跑，node 直接执行）
 * 断言三件事：
 *  1. 新 app 用到的每个 musicAPI 方法都在 METHODS 白名单；
 *  2. 该通道在 CHANNELS 里声明了 invoke:main；
 *  3. 声明的参数个数 ≥ 实际调用点数（契约 normalizeArgs 按声明钳制，多传会被拒）。
 */
const { CHANNELS, METHODS } = require('../src/shared/ipcContract.js');

// 新 app 实际调用清单：方法 → 渲染层实参个数（不含 event）
const USED = {
  getVersion: 0,
  getPref: 1,
  setPref: 2,
  searchMusic: 3,
  getDownloadUrlSmart: 2,   // (song, quality)
  proxyPlay: 3,             // (url, referer, refresh)
};

let fail = 0;
for (const [m, argc] of Object.entries(USED)) {
  const ch = METHODS[m];
  if (!ch) { console.error(`FAIL ${m}: 不在 METHODS 白名单`); fail++; continue; }
  const spec = CHANNELS[ch];
  if (!spec || !(spec.invoke || []).includes('main')) {
    console.error(`FAIL ${m} → ${ch}: 通道未声明 invoke:main`); fail++; continue;
  }
  const declared = (spec.args || []).length;
  if (declared < argc) {
    console.error(`FAIL ${m} → ${ch}: 声明参数 ${declared} 个 < 调用 ${argc} 个`); fail++; continue;
  }
  console.log(`OK   ${m} → ${ch}  (declared=${declared}, used=${argc})`);
}
console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部接线符合 IPC 契约');
process.exit(fail ? 1 : 0);
