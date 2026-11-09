/**
 * core/prefs.ts —— 偏好读写（get-pref / set-pref 契约）
 *
 * 所有偏好键必须与旧层一致，否则换界面等于换一套设置：
 *   theme / language / saveDir / localDirPath / discoverLayout / playQuality ...
 */
import { callSafe } from './bridge';

/** 偏好值是 IPC 能序列化的标量；复杂结构由调用方自行 JSON 编码 */
export type PrefValue = string | number | boolean | null;

/**
 * 读偏好。给了非 null 的 fallback 时返回值类型跟随 fallback，
 * 便于 JS 调用点拿到 string / number 而不是宽联合。
 */
export async function getPref<T extends Exclude<PrefValue, null>>(key: string, fallback: T): Promise<T>;
export async function getPref(key: string, fallback?: null): Promise<PrefValue>;
export async function getPref(key: string, fallback: PrefValue = null): Promise<PrefValue> {
  const v = await callSafe<PrefValue, null>('getPref', [key], null);
  return v === null || v === undefined ? fallback : v;
}

export async function setPref(key: string, value: PrefValue): Promise<boolean> {
  return callSafe<boolean, boolean>('setPref', [key, value], false);
}

export async function getPrefBool(key: string, fallback = false): Promise<boolean> {
  const v = await getPref(key, null);
  if (v === null) return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
}

export async function getPrefNumber(key: string, fallback = 0): Promise<number> {
  const v = await getPref(key, null);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}