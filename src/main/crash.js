/**
 * 崩溃转储初始化（本地采集，不上传）
 *
 * 为什么需要：主进程 / GPU / 渲染进程崩溃后默认只在控制台留下一行，
 * 用户报障时没有任何可归档的现场。crashReporter 能把 minidump 落到
 * userData 下，便于事后分析；但**不能**把崩溃包发到服务器 —— 本项目
 * 没有自建采集服务，submitURL 必须为空且 uploadToServer 必须为 false，
 * 否则 Electron 会尝试把转储 POST 到默认地址（历史上默认地址是 Google
 * 的 crash 收集端点，等于把用户环境信息发出去）。
 *
 * 调用时机：必须在 app ready **之前** 调用（Electron 只在此之前挂上
 * 崩溃处理器）。任何异常都只记日志、不阻断启动 —— 崩溃采集是观测手段，
 * 丢失它不应该让应用起不来。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { crashReporter } = require('electron');

const PRODUCT_NAME = 'Lanyue';
const COMPANY_NAME = 'Lanyue';

/**
 * 初始化 crashReporter，并把转储目录指到 userData/CrashDumps。
 * @param {Electron.App} app
 * @param {{warn: Function}} [logger] 主进程日志器（只用到 warn）
 * @returns {string} 转储目录绝对路径；初始化失败时返回 ''（不影响启动）
 */
function initCrashReporter(app, logger) {
  const warn = logger && typeof logger.warn === 'function'
    ? logger.warn.bind(logger)
    : () => {};

  let dumpsDir = '';
  try {
    dumpsDir = path.join(app.getPath('userData'), 'CrashDumps');
    // setPath 要求目录已存在，否则抛错；recursive 幂等，已存在时无副作用
    fs.mkdirSync(dumpsDir, { recursive: true });
    // crashDumps 是 Electron 认可的路径名；必须在 crashReporter.start 之前设置
    app.setPath('crashDumps', dumpsDir);
  } catch (e) {
    // 目录不可写（只读盘、权限受限）时退回 Electron 默认转储目录
    warn('[crash] 转储目录设置失败，使用默认目录:', e && e.message ? e.message : e);
    dumpsDir = '';
  }

  try {
    crashReporter.start({
      productName: PRODUCT_NAME,
      companyName: COMPANY_NAME,
      // 不上传：空 submitURL + uploadToServer:false 只做本地转储
      submitURL: '',
      uploadToServer: false,
      compress: true,
    });
  } catch (e) {
    warn('[crash] crashReporter 启动失败（仅本地观测缺失，不影响启动）:', e && e.message ? e.message : e);
    return dumpsDir;
  }

  return dumpsDir;
}

module.exports = { initCrashReporter, PRODUCT_NAME, COMPANY_NAME };