<script setup lang="ts">
import { onMounted } from 'vue';
import {
  settings, TABS, loadSettings, setTab,
  chooseTheme, chooseLanguage, chooseQuality, changeVolume, changeRate,
  changeLyricOffset, chooseSaveDir,
  toggleCookieEditor, saveCookie, verifyCookie, clearCookie, openLogin,
  saveTemplate, deleteTemplate, activateTemplate,
  exportData, importData, checkUpdate, downloadUpdate, restartInstall,
} from '../stores/settings';
import type { PlatformInfo } from '../stores/types';
import { ui } from '../stores/ui';
import { player } from '../stores/player';
import { lyrics } from '../stores/lyrics';
import { qualityLabel } from '../core/format';
import { promptDialog } from '../core/dialog';
import Icon from '../components/common/Icon.vue';

onMounted(loadSettings);

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

async function newTemplate() {
  const name = await promptDialog({ title: '新建命名模板', inputLabel: '模板名称', placeholder: '例如：歌手-歌名' });
  if (!name) return;
  const path = await promptDialog({
    title: '模板格式',
    inputLabel: '路径模板（可用变量 {artist} {album} {title} {source} {year} {track} {ext}）',
    placeholder: '{artist}/{album}/{title}.{ext}',
  });
  if (!path) return;
  await saveTemplate({ name: name.trim(), path: path.trim() });
}

function cookieState(p: PlatformInfo) {
  return !!(settings.cookies && settings.cookies[p.id]);
}

/** 音量滑杆：取值按 HTMLInputElement 收窄 */
function onVolumeInput(e: Event) {
  if (e.target instanceof HTMLInputElement) changeVolume(e.target.value);
}
</script>

<template>
  <div class="stv">
    <aside class="side ly-card">
      <h2>设置</h2>
      <button
        v-for="t in TABS" :key="t.id"
        class="navb" :class="{ on: settings.tab === t.id }"
        @click="setTab(t.id)"
      >
        <Icon :name="t.icon" :size="16" />
        <span>{{ t.label }}</span>
      </button>
      <div class="foot">
        <span>揽乐 {{ settings.version || ui.appVersion || 'v2' }}</span>
        <small>重构版界面</small>
      </div>
    </aside>

    <section class="body ly-card">
      <div v-if="settings.loading" class="skels">
        <div v-for="n in 5" :key="n" class="ly-skeleton" style="height: 56px"></div>
      </div>

      <!-- 外观 -->
      <template v-else-if="settings.tab === 'appearance'">
        <h3>外观</h3>
        <p class="hint">主题与界面语言会立即生效，并写入偏好。</p>

        <div class="group">
          <h4>主题</h4>
          <div class="cards two">
            <button class="opt" :class="{ on: ui.theme === 'light' }" :aria-pressed="ui.theme === 'light'" @click="chooseTheme('light')">
              <span class="swatch light"></span>
              <b>浅色</b>
              <small>极光玻璃 · 明亮</small>
            </button>
            <button class="opt" :class="{ on: ui.theme === 'dark' }" :aria-pressed="ui.theme === 'dark'" @click="chooseTheme('dark')">
              <span class="swatch dark"></span>
              <b>深色</b>
              <small>极光玻璃 · 夜间</small>
            </button>
          </div>
        </div>

        <div class="group">
          <h4>界面语言</h4>
          <div class="row">
            <button class="ly-btn" :class="{ 'ly-btn-primary': ui.lang === 'zh' }" :aria-pressed="ui.lang === 'zh'" @click="chooseLanguage('zh')">简体中文</button>
            <button class="ly-btn" :class="{ 'ly-btn-primary': ui.lang === 'en' }" :aria-pressed="ui.lang === 'en'" @click="chooseLanguage('en')">English</button>
          </div>
        </div>
      </template>

      <!-- 播放 -->
      <template v-else-if="settings.tab === 'playback'">
        <h3>播放</h3>
        <p class="hint">音质与音量直接作用于当前播放器；歌词偏移用于修正整首歌的字幕时差。</p>

        <div class="group">
          <h4>默认音质</h4>
          <div class="row">
            <button class="ly-btn" :class="{ 'ly-btn-primary': settings.playQuality === 'standard' }" :aria-pressed="settings.playQuality === 'standard'" @click="chooseQuality('standard')">标准 128k</button>
            <button class="ly-btn" :class="{ 'ly-btn-primary': settings.playQuality === 'hq' }" :aria-pressed="settings.playQuality === 'hq'" @click="chooseQuality('hq')">高品质 320k</button>
            <button class="ly-btn" :class="{ 'ly-btn-primary': settings.playQuality === 'lossless' }" :aria-pressed="settings.playQuality === 'lossless'" @click="chooseQuality('lossless')">无损 FLAC</button>
          </div>
          <p class="hint">当前：{{ qualityLabel(player.quality) }}</p>
        </div>

        <div class="group">
          <h4>音量</h4>
          <div class="row sl">
            <input type="range" min="0" max="100" :value="Math.round(player.volume * 100)" aria-label="音量" @input="onVolumeInput" />
            <span class="val">{{ Math.round(player.volume * 100) }}%</span>
          </div>
        </div>

        <div class="group">
          <h4>播放速度</h4>
          <div class="row">
            <button v-for="r in RATES" :key="r" class="ly-btn ly-btn-sm" :class="{ 'ly-btn-primary': player.rate === r }" @click="changeRate(r)">{{ r }}x</button>
          </div>
        </div>

        <div class="group">
          <h4>歌词偏移</h4>
          <div class="row">
            <button class="ly-btn ly-btn-sm" @click="changeLyricOffset(-500)">-0.5s</button>
            <span class="val">{{ (lyrics.offsetMs / 1000).toFixed(1) }}s</span>
            <button class="ly-btn ly-btn-sm" @click="changeLyricOffset(500)">+0.5s</button>
            <span class="hint">正数表示歌词提前</span>
          </div>
        </div>
      </template>

      <!-- 下载 -->
      <template v-else-if="settings.tab === 'download'">
        <h3>下载</h3>

        <div class="group">
          <h4>下载目录</h4>
          <div class="row">
            <span class="path">{{ settings.saveDir || settings.defaultDir || '未设置（使用系统音乐目录）' }}</span>
            <button class="ly-btn" @click="chooseSaveDir">选择目录</button>
          </div>
        </div>

        <div class="group">
          <h4>命名模板</h4>
          <div class="tpls">
            <div v-for="t in settings.templates" :key="t.id" class="tpl" :class="{ on: settings.activeTemplate === t.id }">
              <div class="tpltx">
                <b>{{ t.name }}</b>
                <small>{{ t.subpath || t.path }}</small>
              </div>
              <button v-if="settings.activeTemplate !== t.id" class="ly-btn ly-btn-sm" @click="activateTemplate(t.id)">设为默认</button>
              <span v-else class="ly-tag ly-tag-ok">默认</span>
              <button class="ly-btn ly-btn-sm ly-btn-danger" @click="deleteTemplate(t.id)">删除</button>
            </div>
            <div v-if="!settings.templates.length" class="hint">还没有模板，新建一个来统一文件命名。</div>
          </div>
          <div class="row">
            <button class="ly-btn ly-btn-primary" @click="newTemplate"><Icon name="plus" :size="14" /> 新建模板</button>
          </div>
        </div>

        </template>

      <!-- 账号 -->
      <template v-else-if="settings.tab === 'accounts'">
        <h3>账号与 Cookie</h3>
        <p class="hint">Cookie 经系统安全存储加密保存；这里只显示脱敏片段。</p>

        <div class="accounts">
          <div v-for="p in settings.platforms" :key="p.id" class="acc">
            <div class="acc-head">
              <div class="acc-name">
                <b>{{ p.name }}</b>
                <span class="ly-tag" :class="cookieState(p) ? 'ly-tag-ok' : ''">{{ cookieState(p) ? '已登录' : '未登录' }}</span>
              </div>
              <div class="acc-acts">
                <button class="ly-btn ly-btn-sm" :disabled="settings.busy === p.id" @click="openLogin(p.id)">登录获取</button>
                <button class="ly-btn ly-btn-sm" @click="toggleCookieEditor(p.id)">粘贴 Cookie</button>
                <button v-if="cookieState(p)" class="ly-btn ly-btn-sm ly-btn-danger" @click="clearCookie(p.id)">清除</button>
              </div>
            </div>
            <div v-if="cookieState(p)" class="acc-cookie">{{ settings.cookies[p.id] }}</div>

            <div v-if="settings.cookieOpen[p.id]" class="editor">
              <textarea v-model="settings.cookieDraft[p.id]" class="ly-input cookiebox" rows="4" placeholder="粘贴完整 Cookie 字符串"></textarea>
              <div class="row">
                <button class="ly-btn ly-btn-primary ly-btn-sm" :disabled="settings.busy === p.id" @click="saveCookie(p.id)">保存</button>
                <button class="ly-btn ly-btn-sm" :disabled="settings.busy === p.id" @click="verifyCookie(p.id)">验证</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 高级 -->
      <template v-else-if="settings.tab === 'advanced'">
        <h3>高级</h3>

        <div class="group">
          <h4>数据备份</h4>
          <div class="row">
            <button class="ly-btn" :disabled="settings.busy === 'export'" @click="exportData">
              <Icon name="download" :size="14" /> 导出全部数据
            </button>
            <button class="ly-btn" :disabled="settings.busy === 'import'" @click="importData">
              <Icon name="upload" :size="14" /> 导入数据
            </button>
          </div>
          <p class="hint">导出包含歌单、收藏、历史、订阅与偏好，不包含音频文件本身。</p>
        </div>

        <div class="group">
          <h4>软件更新</h4>
          <div class="row">
            <button class="ly-btn ly-btn-primary" :disabled="settings.checking" @click="checkUpdate">
              <Icon name="refresh" :size="14" :class="{ spin: settings.checking }" />
              {{ settings.checking ? '检查中…' : '检查更新' }}
            </button>
            <button class="ly-btn" :disabled="settings.busy === 'update'" @click="downloadUpdate">下载更新</button>
            <button class="ly-btn" @click="restartInstall">重启并安装</button>
          </div>
          <p v-if="settings.updateMsg" class="hint">{{ settings.updateMsg }}</p>
        </div>

        <div class="group">
          <h4>安全说明</h4>
          <p class="hint">
            渲染层不接触 Node 与文件系统：所有文件操作、取流与外部窗口都经主进程白名单通道。
            Cookie 与 API Key 使用系统安全存储，不会写入普通配置文件。
          </p>
        </div>
      </template>

      <!-- 关于 -->
      <template v-else>
        <h3>关于揽乐</h3>
        <div class="about">
          <div class="logo">揽</div>
          <div>
            <h2>揽乐</h2>
            <p class="hint">多平台音乐聚合下载器 · 重构版界面（Vue 3 + T3 极光玻璃）</p>
            <div class="row">
              <span class="ly-tag">版本 {{ settings.version || ui.appVersion || '—' }}</span>
              <span class="ly-tag">Electron</span>
              <span class="ly-tag">Vue 3</span>
            </div>
          </div>
        </div>
        <div class="group">
          <h4>聚合平台</h4>
          <div class="row wrap">
            <span v-for="p in settings.platforms" :key="p.id" class="ly-tag">{{ p.name }}</span>
          </div>
        </div>
        <div class="group">
          <h4>致谢</h4>
          <p class="hint">
            本项目仅用于个人学习与合法授权的音乐管理。请遵守各平台服务条款，
            不要用于分发受版权保护的内容。
          </p>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.stv { flex: 1; min-height: 0; display: grid; grid-template-columns: 190px 1fr; gap: var(--gap-app); }
.side { display: flex; flex-direction: column; gap: 3px; padding: var(--sp-4) var(--sp-3); }
.side h2 { font-size: var(--fs-lg); font-weight: var(--fw-bold); padding: 0 var(--sp-2) var(--sp-3); }
.navb {
  display: flex; align-items: center; gap: 10px;
  height: 38px; padding: 0 var(--sp-3); border: 0; border-radius: var(--r-md);
  background: transparent; color: var(--ink-2); text-align: left; cursor: pointer;
  font-size: var(--fs-sm);
  transition: background var(--dur-1), color var(--dur-1);
}
.navb:hover { background: var(--glass-3); color: var(--ink); }
.navb.on { background: var(--accent-soft); color: var(--au-1); box-shadow: inset 0 0 0 1px var(--accent-line); }
.foot { margin-top: auto; padding: var(--sp-3) var(--sp-2) 0; border-top: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-xs); color: var(--ink-2); }
.foot small { font-size: var(--fs-2xs); color: var(--ink-3); }

.body { min-height: 0; overflow-y: auto; padding: var(--sp-6); }
.body h3 { font-size: var(--fs-2xl); font-weight: var(--fw-black); }
.hint { margin-top: var(--sp-2); font-size: var(--fs-xs); color: var(--ink-3); line-height: 1.7; }

.group { margin-top: var(--sp-6); }
.group h4 { font-size: var(--fs-sm); font-weight: var(--fw-bold); margin-bottom: var(--sp-3); }
.row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.row.wrap { flex-wrap: wrap; }
.row.sl { max-width: 420px; }
.row.sl input { flex: 1; accent-color: var(--au-1); }
.val { min-width: 52px; text-align: center; font-size: var(--fs-xs); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.path { flex: 1; min-width: 240px; padding: 8px var(--sp-3); border-radius: var(--r-md); background: var(--glass-3); border: 1px solid var(--hairline); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.cards { display: grid; gap: var(--sp-3); }
.cards.two { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 620px; }
.cards.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.opt {
  display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
  padding: var(--sp-4); border-radius: var(--r-lg);
  border: 1px solid var(--hairline); background: var(--glass-3);
  color: inherit; text-align: left; cursor: pointer;
  transition: border-color var(--dur-1), box-shadow var(--dur-1), background var(--dur-1);
}
.opt:hover { background: var(--glass-2); }
.opt.on { border-color: var(--accent-line); box-shadow: inset 0 0 0 1px var(--accent-soft); background: var(--accent-soft); }
.opt b { font-size: var(--fs-sm); font-weight: var(--fw-bold); }
.opt small { font-size: var(--fs-2xs); color: var(--ink-3); line-height: 1.5; }
.swatch { width: 100%; height: 52px; border-radius: var(--r-md); margin-bottom: 6px; }
.swatch.light { background: linear-gradient(135deg, #f2f4f9, #e6ecff 55%, #ffe9f5); border: 1px solid var(--hairline); }
.swatch.dark { background: linear-gradient(135deg, #0d1020, #1a2246 55%, #2a1230); border: 1px solid rgba(255,255,255,.08); }

.tpls { display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.tpl { display: flex; align-items: center; gap: var(--sp-3); padding: 10px var(--sp-3); border-radius: var(--r-md); background: var(--glass-3); border: 1px solid var(--hairline); }
.tpl.on { border-color: var(--accent-line); }
.tpltx { flex: 1; min-width: 0; }
.tpltx b { display: block; font-size: var(--fs-sm); }
.tpltx small { display: block; margin-top: 2px; font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.check { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--ink-2); }
.check input { accent-color: var(--au-1); }

.accounts { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-5); }
.acc { padding: var(--sp-4); border-radius: var(--r-lg); border: 1px solid var(--hairline); background: var(--glass-3); }
.acc-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.acc-name { display: flex; align-items: center; gap: var(--sp-2); }
.acc-name b { font-size: var(--fs-sm); }
.acc-acts { display: flex; gap: var(--sp-2); }
.acc-cookie { margin-top: var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--ink-3); word-break: break-all; }
.editor { margin-top: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
.cookiebox { width: 100%; resize: vertical; font-family: var(--font-mono); font-size: var(--fs-xs); }

.about { display: flex; align-items: center; gap: var(--sp-5); margin-top: var(--sp-5); }
.logo {
  width: 84px; height: 84px; border-radius: 26px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--au-grad-3); color: #fff; font-size: 30px; font-weight: var(--fw-black);
  box-shadow: var(--glow-accent);
}
.about h2 { font-size: var(--fs-2xl); font-weight: var(--fw-black); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.skels { display: flex; flex-direction: column; gap: var(--sp-2); }
</style>