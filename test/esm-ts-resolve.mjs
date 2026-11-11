/**
 * node --test 不走 Vite，渲染层的无后缀 import（./bridge）和 .ts 都解析不到。
 * 只给播放器切歌时序这条 runner 用，不改生产模块的引用写法。
 */
export async function resolve(specifier, context, nextResolve) {
  const bare = specifier.startsWith('.') && !/\.(?:js|mjs|cjs|ts|json|node)$/.test(specifier);
  if (!bare) return nextResolve(specifier, context);
  let lastErr;
  for (const ext of ['.ts', '.js', '.mjs']) {
    try {
      return await nextResolve(specifier + ext, context);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
