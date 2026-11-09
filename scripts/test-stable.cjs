#!/usr/bin/env node
/**
 * scripts/test-stable.cjs — 带硬超时与逐文件统计的测试跑批入口
 *
 * 为什么需要它：
 *   `node --test "test/*.test.js"` 的 --test-timeout 只能打断**异步**等待。
 *   一旦某个用例卡在同步阻塞里（本仓库曾出现：逐条 SQLite 提交 + WAL fsync，
 *   本机 F: 盘实测 ~36ms/条，6000 条 ≈ 3.5 分钟且期间事件循环被占满），
 *   超时定时器根本没有机会执行 ⇒ 整批表现为「停在某个用例之后、日志不再增长、
 *   进程永不退出」，看起来像死锁，实际是同步空转。
 *
 * 本脚本的做法：
 *   1) 按文件分片（并发 N，默认 2，与 CI 的 --test-concurrency 对齐），
 *      每个文件独立子进程 + 独立硬超时；卡住的文件会被点名并整棵进程树杀掉。
 *   2) 每个子进程仍使用 `node --test --test-timeout=60000 --test-concurrency=N`，
 *      保留仓库既有的用例级超时语义（异步用例超过 60s 会被判失败）。
 *   3) **失败/超时的文件串行重跑一次**（单文件、无并发）。重跑通过 ⇒ 记为 flaky 并判绿
 *      （首跑结果留档，不掩盖）；重跑仍失败 ⇒ 保持红。
 *      理由：高并发下的原生崩溃（如 migu 的 exitCode 3221226505）单跑 19/19 通过，
 *      属并发生态 flake；重跑一次是「区分 flake 与真实回归」的最小成本手段。
 *   4) 全局硬上限默认 20 分钟；到点后杀掉在跑的，剩余文件记为「未执行」。
 *   5) 结束输出 pass / fail / 超时 / flaky / 未执行 的文件统计与最慢文件，退出码：
 *      0 = 全绿（含 flaky 重跑通过）；1 = 有失败/超时/未执行；2 = 脚本自身用法/环境错误。
 *
 * 用法：
 *   node scripts/test-stable.cjs
 *   node scripts/test-stable.cjs --concurrency=6
 *   node scripts/test-stable.cjs --concurrency 2 --file-timeout=300 --timeout=1200
 *   node scripts/test-stable.cjs --filter history --verbose
 *
 * 参数：
 *   --concurrency=N   并发文件数（默认 2，等于 CI 的 --test-concurrency）
 *   --file-timeout=S  单个文件的硬超时秒数（默认 180）
 *   --timeout=S       整批的硬超时秒数（默认 1200 = 20 分钟）
 *   --filter=TEXT     只跑文件名包含 TEXT 的用例（诊断用）
 *   --verbose         失败/超时文件把子进程输出直接打到控制台
 *   --help            打印帮助
 *
 * 产物：
 *   完整子进程输出写入 .preview/test-stable-<时间戳>.log（控制台只打逐文件结论，
 *   避免并发输出互相穿插）。失败文件会打印首条 not ok 的用例名与错误摘要。
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const LOG_DIR = path.join(ROOT, '.preview');

const DEFAULTS = {
  concurrency: 2,
  fileTimeoutMs: 180 * 1000,
  totalTimeoutMs: 20 * 60 * 1000,
  filter: null,
  verbose: false,
};

/** 解析正整数参数（非法值直接报错，避免「静默用了默认值」）。 */
function positiveInt(raw, name, { allowZero = false } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`${name} 需要正整数，实际收到: ${raw}`);
  }
  return n;
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    // 取参数值：支持 `--k=v` 与 `--k v` 两种写法
    const value = () => {
      if (inline !== null) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`${key} 缺少取值`);
      return argv[i];
    };

    switch (key) {
      case '--concurrency':
        opts.concurrency = positiveInt(value(), '--concurrency');
        break;
      case '--file-timeout':
        opts.fileTimeoutMs = positiveInt(value(), '--file-timeout') * 1000;
        break;
      case '--timeout':
        opts.totalTimeoutMs = positiveInt(value(), '--timeout') * 1000;
        break;
      case '--filter':
        opts.filter = value();
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
  }
  return opts;
}

function printHelp() {
  const lines = [
    '用法: node scripts/test-stable.cjs [选项]',
    '',
    '  --concurrency=N   并发文件数（默认 2，与 CI 一致）',
    '  --file-timeout=S  单个文件硬超时秒数（默认 180）',
    '  --timeout=S       整批硬超时秒数（默认 1200，即 20 分钟）',
    '  --filter=TEXT     只跑文件名包含 TEXT 的用例',
    '  --verbose         失败/超时文件打印子进程原始输出',
    '  --help            打印本帮助',
    '',
    '每个文件跑的是: node --test --test-timeout=60000 --test-concurrency=N <file>',
    '失败/超时的文件会单文件重跑一次：重跑通过记为 flaky（判绿并留档），仍失败才红。',
  ];
  console.log(lines.join('\n'));
}

/** 列出 test/*.test.js（与 package.json 的 glob 一致）。 */
function listTestFiles(filter) {
  const all = fs
    .readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.test.js'))
    .map((d) => path.join(TEST_DIR, d.name))
    .sort();
  if (!filter) return all;
  return all.filter((f) => path.basename(f).includes(filter));
}

function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // node --test 在子进程里再拉一层，单独 kill(pid) 会留下孤儿进程
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_e) {
      try { child.kill('SIGKILL'); } catch (_e2) { /* 已退出 */ }
    }
    return;
  }
  try { child.kill('SIGKILL'); } catch (_e) { /* 已退出 */ }
}

/** 当前正在进行的跑批（仅供异常路径清理；正常收场时置空）。 */
let activeRun = null;

/**
 * 异常收场：清掉整批定时器、杀掉仍在跑的子进程、关闭日志流。
 *
 * 没有这一步，main() 抛错后那条 20 分钟的整批定时器还挂着（它是 ref 状态的 timer），
 * 脚本会一直等到上限才退出 —— 异常本身只需要毫秒，却要赔上 20 分钟。
 */
function cleanupActiveRun() {
  const run = activeRun;
  if (!run) return;
  activeRun = null;
  // 先竖起中止旗：worker 下一轮不再领取新文件，否则杀掉当前子进程后
  // 它还会把队列里剩下的文件一个个跑完（异常收场却要赔上整批时长）
  run.state.aborted = true;
  clearTimeout(run.globalTimer);
  for (const child of run.state.running) killTree(child);
  try {
    if (run.logStream && !run.logStream.writableEnded) run.logStream.end();
  } catch (_e) { /* 流已关闭 */ }
}

/** 从 TAP 里抽计数与首条失败用例（node --test --test-reporter=tap）。 */
function parseTap(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  const pass = pick(/^# pass (\d+)$/m);
  const fail = pick(/^# fail (\d+)$/m);
  const cancelled = pick(/^# cancelled (\d+)$/m);
  const skipped = pick(/^# skipped (\d+)$/m);

  // not ok 之后紧跟的 --- 块里有 error/expected/actual，取前几行做摘要
  const failNames = [];
  const failDetail = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^not ok \d+ - (.*)$/);
    if (!m) continue;
    failNames.push(m[1].trim());
    const detail = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j += 1) {
      const line = lines[j];
      if (/^\s*(\.\.\.|---)\s*$/.test(line)) continue;
      if (/^\s*(duration_ms|type|location|code|failureType):/.test(line)) continue;
      if (/^\s*(error|expected|actual|operator):/.test(line)) {
        detail.push(line.trim());
      } else if (detail.length && /^\s{2,}\S/.test(line)) {
        detail.push(line.trim());
      }
      if (detail.length >= 4) break;
    }
    if (detail.length) failDetail.push(`${failNames[failNames.length - 1]}: ${detail.join(' | ')}`);
  }
  return { pass, fail, cancelled, skipped, failNames, failDetail };
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60 * 1000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 跑单个文件；返回 {file, status, ms, pass, fail, output, names, detail}。 */
function runFile(file, opts, state) {
  return new Promise((resolve) => {
    const args = [
      '--test',
      '--test-timeout=60000',
      `--test-concurrency=${opts.concurrency}`,
      '--test-reporter=tap',
      path.relative(ROOT, file),
    ];
    const startedAt = Date.now();
    let output = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state.running.add(child);

    const finish = (status, extra) => {
      if (settled) return;
      settled = true;
      state.running.delete(child);
      const res = {
        file,
        status,
        ms: Date.now() - startedAt,
        output,
        ...extra,
      };
      resolve(res);
    };

    // 单文件硬超时：同步阻塞的用例只能靠「杀进程」收场
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.fileTimeoutMs);

    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      output += `\n[test-stable] 子进程启动失败: ${err.message}\n`;
      finish('error');
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // TAP 计数只解析一次，超时/中断也要带上已跑完的用例数
      const tap = parseTap(output);
      if (timedOut) {
        finish('timeout', { signal, ...tap });
        return;
      }
      if (state.aborted) {
        finish('skipped', { signal, ...tap });
        return;
      }
      // 有 not ok / 非 0 退出都算失败（cancelled 也算，避免「静默跳过」冒充绿）
      const failed = code !== 0 || tap.fail > 0 || tap.cancelled > 0 || !tabHasPlan(output);
      finish(failed ? 'fail' : 'pass', { code, signal, ...tap });
    });
  });
}

/** TAP 是否给出了 1..N 计划；没给出说明文件被中途打断（半个文件不算绿）。 */
function tabHasPlan(text) {
  return /^\d+\.\.\d+$/m.test(text);
}

function writeLog(logStream, res) {
  const head = `\n===== ${path.relative(ROOT, res.file)} | ${res.status} | ${fmtMs(res.ms)}`
    + `${res.pass != null ? ` | pass=${res.pass} fail=${res.fail}` : ''} =====\n`;
  logStream.write(head);
  logStream.write(res.output || '(无输出)\n');
}

const ICON = { pass: '✔', fail: '✘', timeout: '⏱', flaky: '⚠', error: '✘', skipped: '·' };

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[test-stable] ${e.message}`);
    console.error('[test-stable] 退出码 2（用法错误）');
    process.exitCode = 2;
    return;
  }
  if (opts.help) { printHelp(); return; }

  const files = listTestFiles(opts.filter);
  if (!files.length) {
    console.error(`[test-stable] ${path.relative(ROOT, TEST_DIR)} 下没有匹配的 *.test.js（filter=${opts.filter}）`);
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(LOG_DIR, `test-stable-${stamp}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`# test-stable 开始 ${new Date().toISOString()}\n`
    + `# 文件数 ${files.length} · 并发 ${opts.concurrency} · 单文件上限 ${fmtMs(opts.fileTimeoutMs)}`
    + ` · 整批上限 ${fmtMs(opts.totalTimeoutMs)}\n`);

  console.log(`[test-stable] ${files.length} 个文件 · 并发 ${opts.concurrency}`
    + ` · 单文件硬超时 ${fmtMs(opts.fileTimeoutMs)} · 整批上限 ${fmtMs(opts.totalTimeoutMs)}`);
  console.log(`[test-stable] 完整日志: ${path.relative(ROOT, logPath)}`);

  const state = { running: new Set(), aborted: false };
  const results = new Map();
  const startedAt = Date.now();

  // 整批硬上限：到点后杀掉在跑的、未开始的记为 skipped，保证脚本一定收场
  const globalTimer = setTimeout(() => {
    state.aborted = true;
    console.warn(`[test-stable] 达到整批上限 ${fmtMs(opts.totalTimeoutMs)}，正在终止剩余子进程…`);
    for (const child of state.running) killTree(child);
  }, opts.totalTimeoutMs);
  // 供 main().catch 的异常路径清理（定时器 + 在跑子进程 + 日志流）
  activeRun = { state, globalTimer, logStream };

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (state.aborted) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= files.length) return;
      const file = files[idx];
      const res = await runFile(file, opts, state);
      results.set(file, res);
      writeLog(logStream, res);
      const counts = res.pass == null ? ''
        : res.status === 'skipped' ? ` 未跑完 pass=${res.pass}（不计入）`
          : ` pass=${res.pass} fail=${res.fail}`;
      console.log(`${ICON[res.status] || '?'} ${path.basename(file)} (${fmtMs(res.ms)})${counts}`);
      if ((res.status === 'fail' || res.status === 'timeout') && res.failNames && res.failNames.length) {
        console.log(`    └ 失败用例: ${res.failNames.slice(0, 3).join(' / ')}`
          + (res.failNames.length > 3 ? ` 等 ${res.failNames.length} 条` : ''));
      }
      if (opts.verbose && (res.status === 'fail' || res.status === 'timeout' || res.status === 'error')) {
        console.log(`---- ${path.relative(ROOT, file)} 原始输出 ----`);
        console.log(res.output);
        console.log('---- 原始输出结束 ----');
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, files.length) }, () => worker()),
  );

  // ── 失败/超时文件单文件重跑一次 ────────────────────────────────
  //
  // 并发生态下出现过原生崩溃（migu.test.js exitCode 3221226505 = 0xC0000409），
  // 而单跑 19/19 通过：这类 flake 若直接判红，门禁会被噪声拖成「习惯性忽略红灯」。
  // 但重跑只用于**区分 flake 与真实回归**，不是掩盖：
  //   · 重跑通过 ⇒ 状态改 flaky（判绿 + 首跑结果留档 + 汇总单独列出）
  //   · 重跑仍失败 ⇒ 保持 fail/timeout（红），并记录两次结果
  // 重跑一律串行、单文件，避免再次制造并发生态。
  const retryTargets = [...results.values()]
    .filter((r) => r.status === 'fail' || r.status === 'timeout');

  if (retryTargets.length) {
    console.log('');
    console.log(`[test-stable] 重跑 ${retryTargets.length} 个失败/超时文件（单文件、串行、仅一次）`);
    for (const r of retryTargets) {
      if (state.aborted) {
        console.log(`  ⚠ 整批已中止，跳过重跑：${path.basename(r.file)}`);
        break;
      }
      if (Date.now() - startedAt > opts.totalTimeoutMs) {
        console.log(`  ⚠ 已达整批上限，跳过重跑：${path.basename(r.file)}`);
        break;
      }
      const firstStatus = r.status;
      const firstCode = r.code;
      const again = await runFile(r.file, opts, state);
      logStream.write(`\n----- 重跑（单文件） ${path.relative(ROOT, r.file)} -----\n`);
      writeLog(logStream, again);
      if (again.status === 'pass') {
        // 重跑通过：判 flaky，保留首跑状态与退出码作为留档
        r.status = 'flaky';
        r.firstStatus = firstStatus;
        r.firstCode = firstCode;
        r.retryMs = again.ms;
        // 终判以重跑为准：用例级计数用重跑的结果，首跑只留状态与退出码
        r.pass = again.pass;
        r.fail = again.fail;
        console.log(`⚠ ${path.basename(r.file)} 首跑 ${firstStatus}`
          + `${firstCode != null ? `(exit=${firstCode})` : ''}`
          + ` → 重跑 pass（${fmtMs(again.ms)}）⇒ flaky，判绿`);
      } else {
        r.retryStatus = again.status;
        r.retryMs = again.ms;
        console.log(`${ICON[again.status] || '✘'} ${path.basename(r.file)} 首跑 ${firstStatus}`
          + ` → 重跑仍 ${again.status}（${fmtMs(again.ms)}）⇒ 保持红`);
      }
    }
  }

  clearTimeout(globalTimer);

  // 未被执行（整批超时）的文件
  for (const file of files) {
    if (!results.has(file)) {
      results.set(file, { file, status: 'skipped', ms: 0, pass: null, fail: null, output: '' });
    }
  }

  const all = [...results.values()];
  const by = (s) => all.filter((r) => r.status === s);
  const pass = by('pass');
  const fail = by('fail');
  const timeout = by('timeout');
  const error = by('error');
  const flaky = by('flaky');
  const skipped = by('skipped');
  const elapsed = Date.now() - startedAt;

  const slowest = all
    .filter((r) => r.status !== 'skipped')
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);

  console.log('');
  console.log('[test-stable] ===== 汇总 =====');
  console.log(`  文件总数 : ${all.length}`);
  console.log(`  pass     : ${pass.length}`);
  console.log(`  fail     : ${fail.length}`);
  console.log(`  超时     : ${timeout.length}`);
  console.log(`  flaky    : ${flaky.length}${flaky.length ? '（首跑失败、单文件重跑通过 ⇒ 判绿）' : ''}`);
  console.log(`  启动错误 : ${error.length}`);
  console.log(`  未执行   : ${skipped.length}${skipped.length ? '（本次未验证，不算通过）' : ''}`);
  // 用例级计数只统计「已跑完」的文件：被中止的半个文件不算数
  const verified = all.filter((r) => r.status !== 'skipped');
  console.log(`  用例级   : pass=${verified.reduce((n, r) => n + (r.pass || 0), 0)}`
    + ` fail=${verified.reduce((n, r) => n + (r.fail || 0), 0)}（仅统计已跑完的文件）`);
  console.log(`  耗时     : ${fmtMs(elapsed)}（上限 ${fmtMs(opts.totalTimeoutMs)}）`);
  if (slowest.length) {
    console.log(`  最慢文件 : ${slowest.map((r) => `${path.basename(r.file)}=${fmtMs(r.ms)}`).join(' · ')}`);
  }

  // 未执行 = 本次未验证 ⇒ 必须计入失败集合，否则「整批没跑完」会被 exit 0 伪装成绿
  const bad = [...fail, ...timeout, ...error, ...skipped];
  if (state.aborted) {
    console.log('');
    console.log(`  ⚠ 整批在中途被中止（达到 ${fmtMs(opts.totalTimeoutMs)} 上限）：`
      + `${skipped.length} 个文件本次未执行 = 未验证，不能算绿 ⇒ 退出码 1`);
  }
  if (flaky.length) {
    console.log('  ---- flaky 清单（首跑失败、重跑通过：判绿，但留档） ----');
    for (const r of flaky) {
      console.log(`  ${path.relative(ROOT, r.file)} 首跑 ${r.firstStatus}`
        + `${r.firstCode != null ? `(exit=${r.firstCode})` : ''} → 重跑 pass（${fmtMs(r.retryMs)}）`);
    }
  }
  if (bad.length) {
    console.log('  ---- 需要处理的文件（含未执行） ----');
    for (const r of bad) {
      const why = r.status === 'timeout'
        ? `超过单文件上限 ${fmtMs(opts.fileTimeoutMs)} 被强制终止`
        : r.status === 'error' ? '子进程无法启动'
          : r.status === 'skipped' ? '整批中止，本次未执行（未验证）'
            : `exit=${r.code} fail=${r.fail}`;
      console.log(`  ${path.relative(ROOT, r.file)} [${r.status}] ${why}`);
      for (const line of (r.failDetail || []).slice(0, 2)) {
        console.log(`      ${line}`);
      }
    }
  }
  console.log(`  完整日志 : ${path.relative(ROOT, logPath)}`);

  logStream.write(`\n# 汇总 pass=${pass.length} flaky=${flaky.length} fail=${fail.length}`
    + ` timeout=${timeout.length} error=${error.length} skipped=${skipped.length}`
    + ` elapsed=${fmtMs(elapsed)}\n`);
  await new Promise((resolve) => logStream.end(resolve));
  activeRun = null;

  // aborted 时即使 bad 为空也必须是红：整批没跑完就不能算过（防误报绿）
  if (bad.length || state.aborted) process.exitCode = 1;
  else process.exitCode = 0;
}

main().catch((e) => {
  // 异常收场：清掉整批定时器、杀掉在跑子进程、关闭日志流，避免挂到 20 分钟上限
  cleanupActiveRun();
  console.error('[test-stable] 未预期错误:', e && e.stack ? e.stack : e);
  process.exitCode = 2;
});