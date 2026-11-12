/**
 * 守卫：Windows 代码签名的流水线接线（2026-11-12，优化方向 #24）
 *
 * ── 背景 ──────────────────────────────────────────────────────
 *
 * 本仓库至今没有代码签名证书（事实钉见 test/update-signature-guard.test.js）。
 * 证书是采购行为，只能由仓库所有者完成；但「证书到位那天签名自动生效」的
 * 接线可以先落地。本文件钉住这套接线的形状，防三类静默失效：
 *
 *   1. **接线被改坏**：secret 名 / 环境变量名拼错、映射丢失 —— 证书到位后
 *      打包依旧不签名，而日志只有一句 debug 级的「signing is skipped」；
 *   2. **半配置状态**：只配了证书没配口令（或反之）—— electron-builder 会
 *      拿空口令去签带口令的 pfx，在打包几分钟后才炸，报错还指向 signtool；
 *      成对闸门把失败提前到打包之前，且两个 secret 都只经 env 注入；
 *   3. **措辞与事实脱节**：签名生效后 Release notes 仍无条件宣称「未做代码
 *      签名」（或反过来）—— notes 必须随 build job 的实际签名状态分支。
 *
 * 另一条关键接线在 quality job：单测步骤注入 WIN_CSC_LINK（只注入证书、
 * 不注入口令），让 update-signature-guard 的事实钉在证书到位时**变红**，
 * 逼停发版直到 RECORDED_STATE / 配置注释 / 设置页提示 / SECURITY.md 全部
 * 同步 —— 这是该守卫文件头设计的触发器，缺了它，签名会悄悄生效而所有
 * 「未启用」措辞继续说谎。
 *
 * 判据全部基于文本（与本仓其他 workflow 守卫同口径，不引入 YAML 依赖）：
 * job 块按 2 空格缩进切，step 按 6 空格 `- ` 切。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const REL = read('.github/workflows/release.yml');

/** 取 job 块（2 空格缩进的键是 job 边界；本文件顶层键都在 0 缩进） */
function jobBlock(yml, job) {
  const m = new RegExp('^  ' + job + ':[ \\t]*$', 'm').exec(yml);
  assert.ok(m, `release.yml 里找不到 job: ${job}`);
  const rest = yml.slice(m.index + m[0].length);
  const next = rest.search(/^ {2}[A-Za-z][\w-]*:[ \t]*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 把 job 块切成 step（6 空格 `- ` 开头）；返回 [{head, text}] */
function steps(jobText) {
  const out = [];
  let cur = null;
  for (const line of jobText.split('\n')) {
    if (/^ {6}- /.test(line)) {
      if (cur) out.push(cur);
      cur = { head: line, text: line + '\n' };
    } else if (cur) {
      cur.text += line + '\n';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function findStep(jobText, nameRe) {
  const s = steps(jobText).find((x) => nameRe.test(x.head));
  assert.ok(s, `找不到名字匹配 ${nameRe} 的步骤`);
  return s;
}

const BUILD = jobBlock(REL, 'build');
const QUALITY = jobBlock(REL, 'quality');
const DRAFT = jobBlock(REL, 'draft-release');

// ── 1. 打包步骤的 secret → 环境变量映射 ──────────────────────

test('Package 步骤把 WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD 映射成 electron-builder 认的环境变量', () => {
  const pkg = findStep(BUILD, /Package \(win, x64\)/);
  // electron-builder 原生读 WIN_CSC_LINK（或 CSC_LINK）与 CSC_KEY_PASSWORD：
  // app-builder-lib/out/codeSign/windowsSignToolManager.js:75 与
  // platformPackager.js:88（doGetCscPassword 只认 CSC_KEY_PASSWORD）。
  assert.match(pkg.text, /CSC_LINK:\s*\$\{\{\s*secrets\.WIN_CSC_LINK\s*\}\}/,
    'Package 步骤缺 CSC_LINK ← secrets.WIN_CSC_LINK 映射');
  assert.match(pkg.text, /CSC_KEY_PASSWORD:\s*\$\{\{\s*secrets\.WIN_CSC_KEY_PASSWORD\s*\}\}/,
    'Package 步骤缺 CSC_KEY_PASSWORD ← secrets.WIN_CSC_KEY_PASSWORD 映射');
});

test('未配置 secret 时行为不变：映射展开为空串，electron-builder 显式按无证书处理', () => {
  // 这条钉的是「接线不改变现状」的依据：windowsSignToolManager.js 对
  // 空串 cscLink 直接 return null（跳过签名）。若上游改成空串也尝试签名，
  // 无证书的发版会开始报错 —— 那时必须重做本接线。
  const src = read('node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js');
  assert.match(src, /cscLink == null \|\| cscLink === ""/,
    'electron-builder 不再把空 CSC_LINK 当「无证书」—— 接线前提已变');
  const mgr = read('node_modules/app-builder-lib/out/platformPackager.js');
  assert.match(mgr, /process\.env\.CSC_KEY_PASSWORD/,
    'electron-builder 不再读 CSC_KEY_PASSWORD 环境变量 —— 映射名要重核');
});

// ── 2. 成对闸门 ──────────────────────────────────────────────

test('成对闸门在 Package 之前：两个 secret 要么都配、要么都不配', () => {
  const list = steps(BUILD);
  const gateIdx = list.findIndex((s) => /成对/.test(s.head));
  const pkgIdx = list.findIndex((s) => /Package \(win, x64\)/.test(s.head));
  assert.ok(gateIdx > -1, 'build job 缺少签名凭据成对闸门步骤');
  assert.ok(pkgIdx > -1 && gateIdx < pkgIdx, '成对闸门必须排在 Package 之前（失败要发生在打包前）');
  const gate = list[gateIdx];
  assert.match(gate.text, /WIN_CSC_LINK:\s*\$\{\{\s*secrets\.WIN_CSC_LINK\s*\}\}/, '闸门须经 env 拿到证书');
  assert.match(gate.text, /WIN_CSC_KEY_PASSWORD:\s*\$\{\{\s*secrets\.WIN_CSC_KEY_PASSWORD\s*\}\}/, '闸门须经 env 拿到口令');
  assert.match(gate.text, /\$env:WIN_CSC_LINK/, '闸门脚本须从环境变量读值（不得把 secret 内插进脚本体）');
  assert.match(gate.text, /\$env:WIN_CSC_KEY_PASSWORD/, '闸门脚本须从环境变量读口令');
  assert.match(gate.text, /exit 1/, '不成对时必须阻断');
  assert.match(gate.text, /GITHUB_OUTPUT/, '闸门须输出本次是否签名（供草稿 notes 分支）');
  assert.match(gate.text, /signed=/, '闸门输出键名为 signed');
});

// ── 3. 事实钉触发器（quality job）────────────────────────────

test('quality 的单测步骤注入 WIN_CSC_LINK —— 证书到位时事实钉必须有机会变红', () => {
  const unit = findStep(QUALITY, /Unit tests/);
  assert.match(unit.text, /WIN_CSC_LINK:\s*\$\{\{\s*secrets\.WIN_CSC_LINK\s*\}\}/,
    '单测步骤看不见 WIN_CSC_LINK 的话，签名会悄悄生效而「未启用」措辞无人被逼更新');
});

test('口令最小暴露：quality job 全程不出现口令 secret', () => {
  assert.ok(!QUALITY.includes('WIN_CSC_KEY_PASSWORD'), 'quality job 不该接触口令（事实钉只需要证书存在性）');
  assert.ok(!QUALITY.includes('CSC_KEY_PASSWORD'), 'quality job 不该接触口令');
});

// ── 4. secret 注入卫生 ───────────────────────────────────────

test('release.yml 里 secrets 只允许经 env 映射注入，不得内插进脚本体或条件', () => {
  // 内插进 run 脚本体 = secret 值成为脚本文本的一部分：带引号/特殊字符的值
  // 能改变脚本语义，且会原样出现在脚本回显里。env 注入没有这两条路。
  const lines = REL.split('\n');
  let seen = 0;
  lines.forEach((line, i) => {
    if (!line.includes('secrets.')) return;
    seen += 1;
    assert.match(line, /^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}\s*$/,
      `release.yml:${i + 1} secret 只允许出现在 env 映射行：${line.trim()}`);
  });
  assert.ok(seen >= 4, `只扫到 ${seen} 处 secrets 引用，接线可能已被整体移除`);
});

// ── 5. 草稿 Release 的签名表述随事实分支 ─────────────────────

test('build job 输出 signed，草稿 notes 按它分支（不得无条件宣称未签名）', () => {
  assert.match(BUILD, /signed:\s*\$\{\{\s*steps\.[\w-]+\.outputs\.signed\s*\}\}/,
    'build job 须把闸门的 signed 输出暴露成 job output');
  assert.match(DRAFT, /needs\.build\.outputs\.signed/, '草稿 notes 须读取实际签名状态');
  const notes = findStep(DRAFT, /Release notes/);
  assert.ok(notes.text.includes('未做代码签名'), '未签名分支文案缺失');
  assert.ok(notes.text.includes('已做代码签名'), '已签名分支文案缺失');
});

// ── 6. 证书材料零入库 ────────────────────────────────────────

test('仓库跟踪文件里不得有证书材料（pfx/p12）', () => {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n');
  const certs = tracked.filter((f) => /\.(pfx|p12)$/i.test(f));
  assert.deepStrictEqual(certs, [],
    `证书材料进了仓库：${certs.join(', ')} —— 私钥只能放 GitHub Secrets`);
});

// ── 7. 否定对照：判据本身有效 ────────────────────────────────

test('否定对照：step 切分与 env 映射判据对坏形状确实不命中', () => {
  const fakeJob = [
    '    steps:',
    '      - name: Package (win, x64)',
    '        run: npx electron-builder --config build/config.cjs --win --x64 --publish never',
    '        env:',
    "          CSC_LINK: 'cert.pfx'",
    '      - name: 下一步',
    '        run: echo hi',
  ].join('\n');
  const list = steps(fakeJob);
  assert.equal(list.length, 2, 'step 切分口径坏了');
  const pkg = list[0];
  assert.ok(!/CSC_LINK:\s*\$\{\{\s*secrets\.WIN_CSC_LINK\s*\}\}/.test(pkg.text),
    '硬编码路径不该被当成 secret 映射');
  assert.ok(!pkg.text.includes('下一步'), 'step 文本不得越界吞掉下一步');
  assert.throws(() => jobBlock('  other:\n    steps: []\n', 'build'), /找不到 job/,
    'job 缺失必须报错而不是静默返回空');
});