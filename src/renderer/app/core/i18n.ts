/**
 * core/i18n.ts —— 新渲染层的轻量 i18n
 *
 * 语言包直接复用旧层 src/renderer/js/lang/{zh,en}.json（单一事实来源，
 * 不在新层复制第二份词条）。旧层是 document 扫描式翻译，新层改成
 * reactive lang + t()，组件按需读取。
 */
import { reactive, computed } from 'vue';
import zh from '../../js/lang/zh.json';
import en from '../../js/lang/en.json';
import { callSafe } from './bridge';

/** 语言包在编译期按 JSON 字面量推导；词条值为中文串或分组对象 */
type LangPack = Record<string, unknown>;

const ZH: LangPack = zh;
const EN: LangPack = en;

const PACKS: Record<string, LangPack | undefined> = { zh: ZH, en: EN };

export const i18n = reactive({
  lang: 'zh',
});

export const availableLangs = [
  { code: 'zh', label: '简体中文' },
  { code: 'en', label: 'English' },
];

export const currentLangLabel = computed<string>(
  () => availableLangs.find((l) => l.code === i18n.lang)?.label || i18n.lang,
);

export function loadLanguage(code: string | null | undefined): void {
  i18n.lang = code && PACKS[code] ? code : 'zh';
}

export function getLang(): string {
  return i18n.lang;
}

/**
 * 取词。缺失时回退：当前语言 → 中文 → key 本身。
 * @param key 形如 "nav.home"
 * @param params 形如 {n: 3}，占位符写 {n}
 */
export function t(key: string, params: Record<string, unknown> = {}): string {
  const pack = PACKS[i18n.lang] || ZH;
  const found: unknown = pack?.[key] ?? ZH?.[key];
  if (typeof found !== 'string') return key;
  let msg: string = found;
  for (const [k, v] of Object.entries(params)) {
    msg = msg.split(`{${k}}`).join(String(v));
  }
  return msg;
}

/** 切换语言并持久化；失败不阻断本次切换 */
export async function setLanguage(code: string): Promise<void> {
  loadLanguage(code);
  await callSafe<boolean, boolean>('setPref', ['language', i18n.lang], false);
}

/** 启动时从偏好恢复语言；无偏好则保持中文 */
export async function restoreLanguage(): Promise<void> {
  const code = await callSafe('getPref', ['language'], null);
  loadLanguage(typeof code === 'string' ? code : 'zh');
}