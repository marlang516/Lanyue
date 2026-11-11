#!/usr/bin/env node
'use strict';
/**
 * scripts/gen-bridge-contract.js
 *
 * 从 src/shared/ipcContract.js 的 METHODS / EVENTS 自动派生
 * src/renderer/app/core/bridge-contract.d.ts 中的 MusicApi 接口。
 *
 * 参数类型映射（由契约规格 k 决定）：
 *   t.str    → string
 *   t.int    → number
 *   t.bool   → boolean
 *   t.enum   → 字面量联合
 *   t.obj    → Record<string, any>
 *   t.shape  → 精确对象字段类型（required 字段必填，其余可选）
 *   t.arr    → any[]
 *   t.any    → any
 *
 * 生成的 .d.ts 保留索引签名 [method: string]: MusicApiMethod，以兼容
 * bridge.call / bridge.on 的 method: string 动态调用；运行时不受任何影响。
 */

const fs = require('fs');
const path = require('path');

const { METHODS, EVENTS, CHANNELS } = require(path.resolve('src/shared/ipcContract.js'));

function specToTS(spec, depth = 0) {
  const ind = '  '.repeat(depth);
  switch (spec.k) {
    case 'str': return 'string';
    case 'int': return 'number';
    case 'bool': return 'boolean';
    case 'enum': {
      return spec.values
        .map((v) => `'${String(v).replace(/'/g, "\\'")}'`)
        .join(' | ');
    }
    case 'obj': return 'Record<string, any>';
    case 'arr': return 'any[]';
    case 'any': return 'any';
    case 'shape': {
      const fields = spec.fields || {};
      const required = new Set(spec.required || []);
      const entries = Object.entries(fields);
      if (entries.length === 0) return 'Record<string, any>';
      const lines = entries.map(([name, fspec]) => {
        const opt = required.has(name) ? '' : '?';
        return `${ind}  ${name}${opt}: ${specToTS(fspec, depth + 1)};`;
      });
      return '{\n' + lines.join('\n') + '\n' + ind + '}';
    }
    default: return 'any';
  }
}

function tsIdent(name) {
  /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
    ? name
    : `'${String(name).replace(/'/g, "\\'")}'`;
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : `'${String(name).replace(/'/g, "\\'")}'`;
}

const lines = [];
lines.push('/**');
lines.push(' * core/bridge-contract.d.ts —— 由 src/shared/ipcContract.js 的 METHODS / EVENTS 自动派生');
lines.push(' *');
lines.push(' * 本文件由 scripts/gen-bridge-contract.js 生成，请勿手工编辑。');
lines.push(' * 契约变更后重新运行生成脚本，再执行 npm run typecheck:renderer。');
lines.push(' *');
lines.push(' * 参数类型映射：');
lines.push(' *   t.str    → string');
lines.push(' *   t.int    → number');
lines.push(' *   t.bool   → boolean');
lines.push(' *   t.enum   → 字面量联合');
lines.push(' *   t.obj    → Record<string, any>');
lines.push(' *   t.shape  → 精确对象字段类型');
lines.push(' *   t.arr    → any[]');
lines.push(' *   t.any    → any');
lines.push(' *');
lines.push(' * 保留索引签名 [method: string]: MusicApiMethod，以兼容');
lines.push(' * bridge.call / bridge.on 的 method: string 动态调用。');
lines.push(' * 运行时行为不受任何影响。');
lines.push(' */');
lines.push('');
lines.push("/** IPC 方法：参数 / 返回值按 IPC 边界保守声明 */");
lines.push('export type MusicApiMethod = (...args: unknown[]) => unknown;');
lines.push('');
lines.push('type Listener = (...args: any[]) => void;');
lines.push('');
lines.push('/**');
lines.push(' * preload 暴露的契约对象：方法名 → 实现。');
lines.push(' * 每个 METHODS 条目对应一个精确方法签名，参数类型由 CHANNELS[channel].args 派生。');
lines.push(' * EVENTS 条目对应订阅方法签名。');
lines.push(' */');
lines.push('export interface MusicApi {');

for (const [method, channel] of Object.entries(METHODS)) {
  const entry = CHANNELS[channel];
  const args = (entry && entry.args) || [];
  const params = args
    .map(([name, spec]) => `${tsIdent(name)}: ${specToTS(spec)}`)
    .join(', ');
  lines.push(`  ${method}(${params}): unknown;`);
}

lines.push('');
lines.push('  // 主进程 → 渲染层订阅事件（EVENTS 派生）');
for (const [event] of Object.entries(EVENTS)) {
  lines.push(`  ${event}(cb: Listener): () => void;`);
}

lines.push('');
lines.push('  /** 索引签名：兼容按字符串方法名动态调用（bridge.call / bridge.on） */');
lines.push('  [method: string]: MusicApiMethod;');
lines.push('}');
lines.push('');

const out = path.resolve('src/renderer/app/core/bridge-contract.d.ts');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`generated ${out} (${lines.length} lines, ${Object.keys(METHODS).length} methods, ${Object.keys(EVENTS).length} events)`);
