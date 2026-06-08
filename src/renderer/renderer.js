// src/renderer/renderer.js — 12 屏全部接真数据、真交互
//
// 架构：所有数据走 window.claudeBoard.data.* → 主进程 scanner.js
//       所有持久化走 settings.* → userData/settings.json
//       所有 native 操作走 dialog.* / terminal.* / export.* / shell.* / clipboard.*
'use strict';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// 模态对话框工具（替代 sandbox 不可用的 window.prompt/alert/confirm）
// promptModal → string | null（输入）/ confirmModal → boolean（确认）/ alertModal → void
function promptModal({ title = t('confirm'), message = '', defaultValue = '', placeholder = '', confirmLabel = t('confirm'), cancelLabel = t('cancel') } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal__title">${esc(title)}</div>
        ${message ? `<div class="modal__message">${esc(message)}</div>` : ''}
        <input class="modal__input" type="text" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" />
        <div class="modal__actions">
          <button class="btn modal__cancel">${esc(cancelLabel)}</button>
          <button class="btn btn--primary modal__ok">${esc(confirmLabel)}</button>
        </div>
      </div>
    `;
    const input = overlay.querySelector('.modal__input');
    const close = (val) => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('.modal__ok').addEventListener('click', () => close(input.value));
    overlay.querySelector('.modal__cancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); close(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    document.body.appendChild(overlay);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
function alertModal({ title = t('confirm'), message = '', detail = '', confirmLabel = t('confirm') } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal__title">${esc(title)}</div>
        ${message ? `<div class="modal__message">${esc(message)}</div>` : ''}
        ${detail ? `<div class="modal__detail">${esc(detail)}</div>` : ''}
        <div class="modal__actions">
          <button class="btn btn--primary modal__ok">${esc(confirmLabel)}</button>
        </div>
      </div>
    `;
    const close = () => { document.body.removeChild(overlay); resolve(); };
    overlay.querySelector('.modal__ok').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') close(); });
    document.body.appendChild(overlay);
    setTimeout(() => overlay.querySelector('.modal__ok').focus(), 0);
  });
}

const cb = window.claudeBoard;
const chartInstances = new Map();

// ====== i18n（从 i18n.js 全局变量加载）======
const I18N = window.ClaudeBoardI18n || { LOCALES: { 'zh-CN': {}, 'en-US': {} }, t: (k) => k, setLocale: () => {}, currentLocale: 'zh-CN' };
function t(key) { return I18N.t(key); }
function setLocale(locale) { I18N.setLocale(locale); }

// ====== Theme（暗色/亮色/跟随系统）======
function getSystemTheme() { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
function applyTheme(theme) {
  const effective = theme === 'auto' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.classList.toggle('theme-light', effective === 'light');
  document.documentElement.classList.toggle('theme-dark', effective === 'dark');
  // 更新 ECharts 图表主题色
  updateChartTheme(effective);
}
function updateChartTheme(theme) {
  const isLight = theme === 'light';
  echartsBase.backgroundColor = isLight ? '#ffffff' : '#11141b';
  echartsBase.textStyle.color = isLight ? '#374151' : '#a3a8b8';
  echartsBase.tooltip.backgroundColor = isLight ? '#ffffff' : '#1f242f';
  echartsBase.tooltip.borderColor = isLight ? '#d1d5db' : '#2a2f3d';
  echartsBase.tooltip.textStyle.color = isLight ? '#1a1d26' : '#e6e8ec';
  // 刷新当前可见图表
  chartInstances.forEach(c => { try { c.setOption(echartsBase); } catch {} });
}
// 热力图颜色配置（根据主题动态切换）
function getHeatmapColors() {
  const isLight = document.documentElement.classList.contains('theme-light');
  if (isLight) {
    return {
      noData: '#ebedf0',      // 浅灰
      level1: '#9be9a8',      // 浅绿
      level2: '#40c463',      // 中绿
      level3: '#30a14e',      // 深绿
      level4: '#216e39',      // 最深绿
      splitLine: '#ffffff',   // 白色分隔线
      cellBg: '#f6f8fa',      // 单元格背景
      labelColor: '#57606a',  // 标签颜色
    };
  }
  return {
    noData: '#161b22',
    level1: '#0e4429',
    level2: '#006d32',
    level3: '#26a641',
    level4: '#39d353',
    splitLine: '#0b0d12',
    cellBg: '#1a1f2b',
    labelColor: '#6c7384',
  };
}
// 监听系统主题变化（auto 模式）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (State.settings?.theme === 'auto') applyTheme('auto');
});

// ============================================================
// 全局 State（settings 镜像，渲染时只读；变更通过 cb.settings.set 持久化）
// ============================================================
const State = {
  settings: null,         // 从主进程读出
  meta: null,             // 数据源 meta：扫了几个文件 / 真假
  currentRoute: 'overview',
};

// 改设置 + 持久化
async function setSetting(patch) {
  Object.assign(State.settings, patch);
  await cb.settings.set(patch);
}

// ============================================================
// Router
// ============================================================
const routes = {
  overview:      'page-overview',
  projects:      'page-projects',
  models:        'page-models',
  tokens:        'page-tokens',
  levels:        'page-levels',
  heatmap:       'page-heatmap',
  onboarding:    'page-onboarding',
  profiles:      'page-profiles',
  settings:      'page-settings',
  terminal:      'page-terminal',
  export:        'page-export',
  empty:         'page-empty',
  'design-system': 'page-design-system',
};
function go(route) {
  const id = routes[route];
  if (!id) return;
  // 已在该路由，不重复渲染（防 hashchange 二次触发）
  if (State.currentRoute === route) return;
  $$('.main').forEach(m => m.classList.remove('active'));
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  el.scrollTop = 0;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === route));
  if (location.hash.slice(1) !== route) location.hash = route;
  State.currentRoute = route;
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  onEnter(route);
}
const settingsUI = { tab: 'general' };
const SETTINGS_TABS = [
  { key: 'general',    icon: '🔧', labelKey: 'settings_general' },
  { key: 'datasource', icon: '📁', labelKey: 'settings_datasource' },
  { key: 'appearance', icon: '🎨', labelKey: 'settings_appearance' },
  { key: 'shortcuts',  icon: '⌨️', labelKey: 'settings_shortcuts' },
  { key: 'about',      icon: 'ℹ️', labelKey: 'settings_about' },
];
const SETTINGS_PANEL = {
  general: () => `
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_auto_launch')}</div><div class="settings__row__label-sub">${t('settings_auto_launch_sub')}</div></div>
      <label class="switch"><input type="checkbox" id="sw-autoLaunch" ${State.settings?.autoLaunch ? 'checked' : ''} /><span class="switch__slider"></span></label></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_min_tray')}</div></div>
      <label class="switch"><input type="checkbox" id="sw-minTray" ${State.settings?.minimizeTray ? 'checked' : ''} /><span class="switch__slider"></span></label></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_terminal')}</div><div class="settings__row__label-sub">${t('settings_terminal_sub')}</div></div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select class="select" id="sel-terminal"></select>
        <button class="btn" id="btn-terminal-rescan" title="${t('settings_detect')}">${t('settings_detect')}</button>
      </div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_language')}</div></div>
      <select class="select" id="sel-language">
        <option value="zh-CN" ${State.settings?.language==='zh-CN'?'selected':''}>简体中文</option>
        <option value="en-US" ${State.settings?.language==='en-US'?'selected':''}>English</option>
      </select></div>
  `,
  datasource: (s) => `
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_ws_path')}</div><div class="settings__row__label-sub">${t('settings_ws_path_sub')}</div></div>
      <div class="path-input"><input class="input" id="input-ws" value="${esc(s?.workspacePath||'')}" /><button class="btn" id="btn-browse-ws">${t('settings_browse')}</button></div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_logs_path')}</div><div class="settings__row__label-sub">${t('settings_logs_path_sub')}</div></div>
      <div class="path-input"><input class="input" id="input-logs" value="${esc(s?.logsPath||'')}" /><button class="btn" id="btn-browse-logs">${t('settings_browse')}</button></div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_scan_freq')}</div></div>
      <select class="select" id="sel-interval">
        <option value="5min" ${s?.scanInterval==='5min'?'selected':''}>${t('settings_5min')}</option>
        <option value="15min" ${s?.scanInterval==='15min'?'selected':''}>${t('settings_15min')}</option>
        <option value="1hour" ${s?.scanInterval==='1hour'?'selected':''}>${t('settings_1hour')}</option>
        <option value="manual" ${s?.scanInterval==='manual'?'selected':''}>${t('settings_manual')}</option>
      </select></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_project_mgmt')}</div><div class="settings__row__label-sub">${t('settings_project_mgmt_sub')}</div></div>
      <button class="btn" id="btn-go-projects">${t('settings_go_projects')}</button></div>
    <div class="settings__row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
      <div style="display:flex;gap:8px;">
        <button class="btn" id="btn-clear-data">${t('settings_clear_cache')}</button>
        <button class="btn btn--danger" id="btn-reset-settings">${t('settings_reset')}</button>
      </div>
    </div>
  `,
  appearance: () => {
    const cur = State.settings?.theme || 'dark';
    return `
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_theme')}</div><div class="settings__row__label-sub">${t('settings_theme_sub')}</div></div>
      <div style="display:flex;gap:8px;">
        <div class="theme-card theme-card--dark ${cur==='dark'?'active':''}" data-theme="dark" style="cursor:pointer;"><div class="theme-card__preview"><div></div><div></div><div></div></div><div>${t('settings_theme_dark')}${cur==='dark'?' ✓':''}</div></div>
        <div class="theme-card theme-card--light ${cur==='light'?'active':''}" data-theme="light" style="cursor:pointer;"><div class="theme-card__preview"><div></div><div></div><div></div></div><div>${t('settings_theme_light')}${cur==='light'?' ✓':''}</div></div>
        <div class="theme-card theme-card--auto ${cur==='auto'?'active':''}" data-theme="auto" style="cursor:pointer;"><div class="theme-card__preview"></div><div>${t('settings_theme_auto')}${cur==='auto'?' ✓':''}</div></div>
      </div>
    </div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_animations')}</div><div class="settings__row__label-sub">${t('settings_animations_sub')}</div></div>
      <label class="switch"><input type="checkbox" id="sw-animations" ${State.settings?.animations !== false ? 'checked' : ''} /><span class="switch__slider"></span></label></div>
    `;
  },
  shortcuts: () => `
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_shortcut_terminal')}</div></div><div><span class="kbd">⌘</span> <span class="kbd">T</span></div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_shortcut_refresh')}</div></div><div><span class="kbd">⌘</span> <span class="kbd">R</span></div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_shortcut_settings')}</div></div><div><span class="kbd">⌘</span> <span class="kbd">,</span></div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_shortcut_maximize')}</div></div><div><span class="kbd">⌘</span> <span class="kbd">Shift</span> <span class="kbd">B</span></div></div>
  `,
  about: () => `
    <div class="about-card">
      <div class="about-card__name">Claude Board</div>
      <div class="about-card__ver" id="settings-version-2">${esc(State.settings?._version || '0.2.0')}</div>
      <div class="about-card__desc">${t('about_description')}</div>
    </div>
    <div class="settings__row" style="margin-top:16px;"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_version_info')}</div></div><div id="settings-version">${esc(State.settings?._version || '0.2.0')} · ${esc(State.settings?._platform || process?.platform || 'unknown')}</div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_tech_stack')}</div></div><div>${t('about_electron')}</div></div>
    <div class="settings__row"><div class="settings__row__label"><div class="settings__row__label-main">${t('settings_config_files')}</div></div><div style="font-family:monospace;font-size:11px;color:var(--text-2);">${t('about_config_path')}</div></div>
    <div class="settings__row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
      <div style="display:flex;gap:8px;">
        <button class="btn" id="btn-open-github">${t('settings_github')}</button>
        <button class="btn" id="btn-open-issues">${t('settings_feedback')}</button>
        <button class="btn" id="btn-check-update">${t('settings_check_update')}</button>
      </div>
    </div>
  `,
};

function renderSettings() {
  const s = State.settings || {};
  const nav = $('#settings-nav');
  if (nav && !nav.dataset.rendered) {
    nav.innerHTML = SETTINGS_TABS.map(tab => `
      <div class="settings__nav-item ${tab.key===settingsUI.tab?'active':''}" data-tab="${tab.key}">
        <span class="settings__nav-item__icon">${tab.icon}</span>${t(tab.labelKey)}
      </div>
    `).join('');
    nav.querySelectorAll('.settings__nav-item').forEach(it => it.addEventListener('click', () => { settingsUI.tab = it.dataset.tab; renderSettings(); }));
    nav.dataset.rendered = '1';
  } else {
    nav?.querySelectorAll('.settings__nav-item').forEach(it => it.classList.toggle('active', it.dataset.tab === settingsUI.tab));
  }
  const panel = $('#settings-panel');
  if (!panel) return;
  panel.innerHTML = (SETTINGS_PANEL[settingsUI.tab] || SETTINGS_PANEL.general)(s);
  // 通用 tab
  $('#sw-autoLaunch')?.addEventListener('change', async (e) => { await setSetting({ autoLaunch: e.target.checked }); flashToast(e.target.checked ? t('toast_auto_launch_on') : t('toast_auto_launch_off')); });
  $('#sw-minTray')?.addEventListener('change',    async (e) => { await setSetting({ minimizeTray: e.target.checked }); flashToast(e.target.checked ? t('toast_tray_on') : t('toast_tray_off')); });
  $('#sel-language')?.addEventListener('change',   async (e) => {
    await setSetting({ language: e.target.value });
    setLocale(e.target.value);
    // 强制重新渲染设置导航（清除 rendered 标记以刷新 i18n 标签）
    const nav = $('#settings-nav');
    if (nav) delete nav.dataset.rendered;
    renderSettings();
    flashToast(t('toast_language_switched'));
  });
  // 外观 tab
  $('#sw-animations')?.addEventListener('change', async (e) => {
    await setSetting({ animations: e.target.checked });
    document.body.classList.toggle('no-animations', !e.target.checked);
    flashToast(e.target.checked ? t('toast_animation_on') : t('toast_animation_off'));
  });
  // 主题卡片点击
  $$('.theme-card[data-theme]').forEach(card => {
    card.addEventListener('click', async () => {
      const theme = card.dataset.theme;
      await setSetting({ theme });
      applyTheme(theme);
      renderSettings(); // 刷新面板状态
      flashToast(t('toast_theme_switched') + ({dark:t('settings_theme_dark'),light:t('settings_theme_light'),auto:t('settings_theme_auto')}[theme] || theme));
    });
  });
  // 终端选择（异步加载可用终端列表）
  const termSel = $('#sel-terminal');
  if (termSel) {
    (async () => {
      try {
        const terminals = await cb.terminal.listAvailable();
        const current = State.settings?.preferredTerminal || 'auto';
        // 构建 options
        let opts = '<option value="auto"' + (current === 'auto' ? ' selected' : '') + '>' + t('settings_auto_detect') + '</option>';
        for (const t of terminals) {
          opts += `<option value="${esc(t.id)}"` + (current === t.id ? ' selected' : '') + `>${esc(t.label)}</option>`;
        }
        if (terminals.length === 0) {
          opts += '<option value="" disabled>' + t('settings_no_terminal') + '</option>';
        }
        termSel.innerHTML = opts;
      } catch (e) {
        termSel.innerHTML = '<option value="auto">' + t('settings_auto_detect') + '</option><option value="" disabled>' + t('settings_detect_failed') + '</option>';
      }
    })();
    termSel.addEventListener('change', async (e) => {
      await setSetting({ preferredTerminal: e.target.value });
      flashToast(t('toast_terminal_switched') + (e.target.options[e.target.selectedIndex]?.text || e.target.value));
    });
  }
  // 重新检测终端
  $('#btn-terminal-rescan')?.addEventListener('click', async () => {
    flashToast(t('toast_detecting'));
    try {
      const terminals = await cb.terminal.detect();
      const sel = $('#sel-terminal');
      if (sel) {
        const current = State.settings?.preferredTerminal || 'auto';
        let opts = '<option value="auto"' + (current === 'auto' ? ' selected' : '') + '>' + t('settings_auto_detect') + '</option>';
        for (const t of terminals) {
          opts += `<option value="${esc(t.id)}"` + (current === t.id ? ' selected' : '') + `>${esc(t.label)}</option>`;
        }
        sel.innerHTML = opts;
      }
      flashToast(t('toast_detect_done') + (terminals.length > 0 ? terminals.map(t => t.label).join('、') : t('toast_detect_none')));
    } catch (e) {
      flashToast(t('toast_detect_failed') + e.message);
    }
  });
  // 数据源 tab
  $('#btn-browse-ws')?.addEventListener('click', async () => {
    const p = await cb.dialog.openDirectory({ title: t('settings_select_workspace') });
    if (p) { $('#input-ws').value = p; await setSetting({ workspacePath: p }); flashToast(t('toast_workspace_updated')); }
  });
  $('#btn-browse-logs')?.addEventListener('click', async () => {
    const p = await cb.dialog.openDirectory({ title: t('settings_select_logs') });
    if (p) { $('#input-logs').value = p; await setSetting({ logsPath: p }); flashToast(t('toast_logs_updated')); }
  });
  // 路径输入框失焦自动保存
  $('#input-ws')?.addEventListener('change', async (e) => {
    if (e.target.value.trim() && e.target.value !== (State.settings?.workspacePath || '')) {
      await setSetting({ workspacePath: e.target.value.trim() });
      flashToast(t('toast_workspace_path_updated'));
    }
  });
  $('#input-logs')?.addEventListener('change', async (e) => {
    if (e.target.value.trim() && e.target.value !== (State.settings?.logsPath || '')) {
      await setSetting({ logsPath: e.target.value.trim() });
      flashToast(t('toast_logs_path_updated'));
    }
  });
  $('#sel-interval')?.addEventListener('change',  async (e) => { await setSetting({ scanInterval: e.target.value }); });
  $('#btn-go-projects')?.addEventListener('click', () => go('projects'));
  $('#btn-clear-data')?.addEventListener('click', async () => {
    if (await cb.dialog.confirm({ message: t('settings_clear_cache_confirm'), detail: t('settings_clear_cache_detail') })) {
      await cb.data.clearCache();
      flashToast(t('toast_cache_cleared'));
    }
  });
  $('#btn-reset-settings')?.addEventListener('click', async () => {
    if (await cb.dialog.confirm({ message: t('settings_reset_confirm'), detail: t('settings_reset_detail') })) {
      await cb.settings.reset(); State.settings = await cb.settings.get(); renderSettings(); flashToast(t('toast_settings_reset'));
    }
  });
  // 关于 tab 按钮
  $('#btn-open-github')?.addEventListener('click', () => { cb.shell.openPath('https://github.com/leapord/claude-board'); });
  $('#btn-open-issues')?.addEventListener('click', () => { cb.shell.openPath('https://github.com/leapord/claude-board/issues'); });
  $('#btn-check-update')?.addEventListener('click', async () => {
    flashToast(t('update_downloading'));
    try {
      const r = await cb.updater.check();
      if (!r.ok) { flashToast(t('update_error') + ': ' + r.reason); return; }
      if (r.latestVersion && r.latestVersion !== r.currentVersion) {
        const doDownload = await alertModal({
          title: t('update_available'),
          message: `${t('update_current')}: v${r.currentVersion}  →  ${t('update_latest')}: v${r.latestVersion}`,
          detail: t('update_click_download'),
          confirmLabel: t('update_download'),
        });
        // alertModal always resolves (single button), so we show download progress inline
        flashToast(t('update_downloading') + ' v' + r.latestVersion);
        const dr = await cb.updater.download();
        if (dr.ok) {
          flashToast(t('update_ready'));
        } else {
          flashToast(t('update_error') + ': ' + dr.reason);
        }
      } else {
        flashToast(t('update_no_update') + ' v' + (r.currentVersion || '0.3.0'));
      }
    } catch (e) {
      flashToast(t('update_error') + ': ' + (e.message || ''));
    }
  });
}


function onEnter(route) {
  switch (route) {
    case 'overview':  renderOverview(); break;
    case 'projects':  renderProjects(); break;
    case 'models':    renderModels(); break;
    case 'tokens':    renderTokens(); break;
    case 'levels':    renderLevels(); break;
    case 'heatmap':   renderHeatmap90d(); break;
    case 'profiles':  renderProfiles(); break;
    case 'settings':  renderSettings(); break;
    case 'design-system': renderDesignSystem(); break;
    case 'terminal':  renderTerminal(); break;
    case 'export':    renderExport(); break;
  }
}
$$('.nav-item').forEach(n => n.addEventListener('click', () => go(n.dataset.route)));
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'overview'));

// 全局快捷键（与 settings 页 shortcuts 标签页声明的 kbd 对齐）
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  // 输入框/textarea 中 ⌘, 仍然触发；其他键在输入框中不拦截（让系统默认行为）
  const inField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  const k = e.key.toLowerCase();
  if (k === ',') { e.preventDefault(); go('settings'); return; }
  if (inField) return;
  if (k === 'r')                    { e.preventDefault(); $('#btn-refresh')?.click(); }
  else if (k === 't')               { e.preventDefault(); go('terminal'); }
  else if (k === 'b' && e.shiftKey) { e.preventDefault(); cb.window.toggleMaximize(); }
});

// ============================================================
// Sidebar 动态更新（修复 HTML 硬编码的 3 个 badge）
// ============================================================
function updateSidebarBadges({ projectCount, modelCount, levelStr }) {
  if (projectCount != null) {
    const el = $('#badge-projects'); if (el) el.textContent = projectCount;
  }
  if (modelCount != null) {
    const el = $('#badge-models'); if (el) el.textContent = modelCount;
  }
  if (levelStr != null) {
    const el = $('#badge-levels'); if (el) el.textContent = levelStr;
  }
}

// ============================================================
// Titlebar 窗口控制（真 IPC）
// ============================================================
$$('.titlebar__dot').forEach(d => {
  d.addEventListener('click', () => {
    const a = d.dataset.win;
    if (a === 'close')      cb.window.close();
    else if (a === 'minimize') cb.window.minimize();
    else if (a === 'maximize') cb.window.toggleMaximize();
  });
});

// ============================================================
// 侧边栏热力图（来自真数据）
// ============================================================
async function refreshSidebarHeatmap() {
  const wrap = $('#sidebar-heatmap');
  if (!wrap) return;
  const d = await cb.data.getHeatmap90d();
  const heatmap = d?.heatmap || [];
  // 取最近 105 天 → 15×7
  const cells = heatmap.slice(-105).map(([_, v]) => {
    let lvl = 0;
    if (v > 2)  lvl = 1;
    if (v > 5)  lvl = 2;
    if (v > 10) lvl = 3;
    if (v > 18) lvl = 4;
    return `<div class="heatmap-mini__cell${lvl ? ' l' + lvl : ''}"></div>`;
  });
  while (cells.length < 105) cells.unshift('<div class="heatmap-mini__cell"></div>');
  wrap.innerHTML = cells.join('');
  const total = heatmap.reduce((s, [_, v]) => s + v, 0);
  $('#heatmap-365-count').textContent = t('heatmap_365d') + heatmap.filter(([_, v]) => v > 0).length;
  $('#brand-status').textContent = `${t("sb_ready")} · ${d?.stats?.[0]?.value || 0}`;
}

// ============================================================
// 时钟
// ============================================================
function tickClock() {
  const el = $('#sb-clock');
  if (!el) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================
// ECharts helpers
// ============================================================
const echartsBase = {
  backgroundColor: '#11141b',
  textStyle: { color: '#a3a8b8', fontFamily: 'inherit' },
  tooltip:   { backgroundColor: '#1f242f', borderColor: '#2a2f3d', textStyle: { color: '#e6e8ec' } },
};
function getOrInitChart(domId) {
  const el = document.getElementById(domId);
  if (!el || typeof echarts === 'undefined') return null;
  if (chartInstances.has(domId)) return chartInstances.get(domId);
  const inst = echarts.init(el, null, { renderer: 'canvas' });
  chartInstances.set(domId, inst);
  return inst;
}
window.addEventListener('resize', () => chartInstances.forEach(c => c.resize()));

// ============================================================
// 自动定时扫描
// ============================================================
let _autoScanTimer = null;
function startAutoScan() {
  if (_autoScanTimer) clearInterval(_autoScanTimer);
  const interval = State.settings?.scanInterval || '15min';
  if (interval === 'manual') return; // 手动模式不自动扫描
  const ms = { '5min': 5 * 60 * 1000, '15min': 15 * 60 * 1000, '1hour': 60 * 60 * 1000 }[interval] || 15 * 60 * 1000;
  _autoScanTimer = setInterval(async () => {
    try {
      await cb.data.rescan();
      // 静默刷新当前路由（不弹 toast）
      const r = State.currentRoute;
      if (r === 'overview') renderOverview();
      else if (r === 'heatmap') renderHeatmap90d();
      refreshSidebarHeatmap().catch(() => {});
      console.log('[autoScan] rescan done');
    } catch (e) {
      console.warn('[autoScan] failed:', e.message);
    }
  }, ms);
  console.log('[autoScan] started, interval:', interval);
}

// ============================================================
// 屏 7：首启向导（真交互）
// ============================================================
const ONBOARDING_STEPS = [
  {
    emoji: '👋', title: () => t('ob_welcome_title'),
    sub: () => t('ob_welcome_sub'),
    body: () => `<div style="text-align:center;color:var(--text-1);line-height:1.7;">
      <p>${t('ob_welcome_body1')}</p>
      <p>${t('ob_welcome_body2')}</p>
      <p style="margin-top:16px;">${t('ob_welcome_body3')}</p>
    </div>`,
  },
  {
    emoji: '📁', title: () => t('ob_workspace_title'),
    sub: () => t('ob_workspace_sub'),
    body: () => `
      <div class="field">
        <div class="field__label">${t('settings_logs_path')}</div>
        <div class="path-input">
          <input class="input" id="ob-logs" value="${esc(State.settings?.logsPath || '~/.claude/projects')}" />
          <button class="btn" id="ob-browse-logs">${t('settings_browse')}</button>
        </div>
        <div class="field__hint">${t('ob_logs_hint')}</div>
      </div>
      <div class="field">
        <div class="field__label">${t('settings_ws_path')}</div>
        <div class="path-input">
          <input class="input" id="ob-ws" value="${esc(State.settings?.workspacePath || '~/Workspace')}" />
          <button class="btn" id="ob-browse-ws">${t('settings_browse')}</button>
        </div>
        <div class="field__hint">${t('ob_ws_hint')}</div>
      </div>
    `,
  },
  {
    emoji: '🎨', title: () => t('ob_theme_title'),
    sub: () => t('ob_theme_sub'),
    body: () => `
      <div class="theme-pick">
        <div class="theme-card theme-card--dark active">
          <div class="theme-card__preview"><div></div><div></div><div></div></div>
          <div>${t('settings_theme_dark')}</div>
        </div>
        <div class="theme-card theme-card--light" style="opacity:0.4;cursor:not-allowed;">
          <div class="theme-card__preview"><div></div><div></div><div></div></div>
          <div>${t('settings_theme_light')} <span class="badge badge--yellow">v0.2</span></div>
        </div>
        <div class="theme-card theme-card--auto" style="opacity:0.4;cursor:not-allowed;">
          <div class="theme-card__preview"></div>
          <div>${t('settings_theme_auto')} <span class="badge badge--yellow">v0.2</span></div>
        </div>
      </div>
    `,
  },
  {
    emoji: '🚀', title: () => t('ob_done_title'),
    sub: () => t('ob_done_sub'),
    body: () => `
      <div style="text-align:center;line-height:1.8;color:var(--text-1);">
        <p>${t('ob_done_body1')}</p>
        <p style="margin-top:8px;">${t('ob_done_body2')}</p>
        <p>${t('ob_done_body3')}</p>
        <div style="margin-top:20px;display:flex;gap:8px;justify-content:center;">
          <span class="badge badge--green">📊 ${t('nav_overview')}</span>
          <span class="badge badge--blue">📁 ${t('nav_projects')}</span>
          <span class="badge badge--purple">🖥️ ${t('terminal_title')}</span>
          <span class="badge badge--yellow">⚙️ ${t('nav_settings')}</span>
        </div>
      </div>
    `,
  },
];
let obStep = 0;
function renderOnboarding() {
  const step = ONBOARDING_STEPS[obStep];
  if (!step) return;
  const emoji = $('#onboarding-emoji');
  const title = $('#onboarding-title');
  const sub = $('#onboarding-sub');
  const body = $('#onboarding-body');
  const stepper = $('#onboarding-stepper');
  const prev = $('#onboarding-prev');
  const next = $('#onboarding-next');
  if (emoji) emoji.textContent = step.emoji;
  if (title) title.textContent = typeof step.title === 'function' ? step.title() : step.title;
  if (sub) sub.textContent = typeof step.sub === 'function' ? step.sub() : step.sub;
  if (body) body.innerHTML = step.body();
  if (stepper) {
    stepper.innerHTML = ONBOARDING_STEPS.map((_, i) => {
      let cls = 'stepper-dot';
      if (i === obStep) cls += ' stepper-dot--active';
      else if (i < obStep) cls += ' stepper-dot--done';
      return `<div class="${cls}"></div>`;
    }).join('');
  }
  if (prev) prev.style.display = obStep > 0 ? '' : 'none';
  if (next) next.textContent = obStep === ONBOARDING_STEPS.length - 1 ? t('ob_start') : t('ob_next');
  // 绑定步骤内交互
  if (obStep === 1) {
    setTimeout(() => {
      $('#ob-browse-logs')?.addEventListener('click', async () => {
        const p = await cb.dialog.openDirectory({ title: t('ob_select_logs_dir') });
        if (p) { const el = $('#ob-logs'); if (el) el.value = p; }
      });
      $('#ob-browse-ws')?.addEventListener('click', async () => {
        const p = await cb.dialog.openDirectory({ title: t('ob_select_ws_dir') });
        if (p) { const el = $('#ob-ws'); if (el) el.value = p; }
      });
    }, 0);
  }
}

// 向导按钮事件（只绑一次）
let _obBound = false;
function bindOnboardingEvents() {
  if (_obBound) return;
  _obBound = true;
  $('#onboarding-next')?.addEventListener('click', async () => {
    if (obStep < ONBOARDING_STEPS.length - 1) {
      // 保存步骤 1 的路径输入
      if (obStep === 1) {
        const logs = $('#ob-logs')?.value?.trim();
        const ws = $('#ob-ws')?.value?.trim();
        if (logs) await setSetting({ logsPath: logs });
        if (ws) await setSetting({ workspacePath: ws });
      }
      obStep++;
      renderOnboarding();
    } else {
      // 完成 onboarding
      await setSetting({ onboarded: true });
      go('overview');
      // 触发首次数据加载
      try {
        await cb.data.rescan();
        await renderOverview();
        refreshSidebarHeatmap().catch(() => {});
      } catch (e) {
        console.warn('[onboarding] post rescan failed:', e.message);
      }
      startAutoScan();
    }
  });
  $('#onboarding-prev')?.addEventListener('click', () => {
    if (obStep > 0) { obStep--; renderOnboarding(); }
  });
  $('#onboarding-skip')?.addEventListener('click', async () => {
    await setSetting({ onboarded: true });
    go('overview');
    try {
      await cb.data.rescan();
      await renderOverview();
      refreshSidebarHeatmap().catch(() => {});
    } catch (e) { console.warn('[onboarding skip] rescan failed:', e.message); }
    startAutoScan();
  });
}

// 在 onEnter 中触发向导渲染
const _preOnEnter = onEnter;
onEnter = function(route) {
  _preOnEnter(route);
  if (route === 'onboarding') { renderOnboarding(); bindOnboardingEvents(); }
};

// ============================================================
// 屏 1：概览（真数据）
// ============================================================
async function renderOverview() {
  console.log('[overview] start rendering');
  let d;
  try { d = await cb.data.getOverview(); }
  catch (e) { console.error('[overview] getOverview failed:', e); return; }
  console.log('[overview] data:', d ? 'OK' : 'NULL', d?.meta);
  if (!d) { return; }
  // 真 meta → statusbar
  if (d.meta) {
    $('#sb-records').textContent  = d.meta.sessionsScanned;
    $('#sb-projects').textContent = new Set(d.recentProjects.map(p => p.name)).size;
  }
  // 4 stat cards
  const stats = $('#overview-stats');
  if (stats) {
    stats.innerHTML = (d.stats || []).map(s => `
      <div class="card stat-card">
        <div class="stat-card__label">${esc(s.label)}</div>
        <div class="stat-card__value">${esc(s.value)}</div>
        <div class="stat-card__delta stat-card__delta--${esc(s.trend)}">${esc(s.delta)}</div>
      </div>
    `).join('');
  }
  // Line chart
  const line = getOrInitChart('line-trend-chart');
  if (line) {
    line.setOption({
      ...echartsBase,
      grid: { left: 30, right: 20, top: 20, bottom: 30 },
      tooltip: { ...echartsBase.tooltip, trigger: 'axis' },
      xAxis: { type: 'category', data: d.trendDays, boundaryGap: false,
        axisLine: { lineStyle: { color: '#2a2f3d' } }, axisLabel: { color: '#6c7384', fontSize: 10 } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2f3d' } }, axisLabel: { color: '#6c7384', fontSize: 10 } },
      series: [{
        name: t('overview_sessions'), type: 'line', smooth: true, data: d.trendData,
        symbolSize: 6, itemStyle: { color: '#5b9dff' },
        lineStyle: { width: 2, color: '#5b9dff' },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(91,157,255,0.3)' }, { offset: 1, color: 'rgba(91,157,255,0)' },
        ])},
      }],
    });
  }
  // Pie chart
  const pie = getOrInitChart('pie-model-chart');
  if (pie) {
    const palette = ['#5b9dff', '#4ade80', '#fbbf24', '#a78bfa', '#22d3ee'];
    pie.setOption({
      ...echartsBase,
      tooltip: { ...echartsBase.tooltip, trigger: 'item' },
      legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { color: '#a3a8b8', fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['35%', '50%'], label: { show: false },
        data: (d.pieData || []).map((p, i) => ({ ...p, itemStyle: { color: palette[i % palette.length] } })),
      }],
    });
  }
  // Projects
  const pl = $('#overview-projects');
  if (pl) {
    const rps = d.recentProjects || [];
    if (rps.length === 0) {
      pl.innerHTML = `
        <div class="overview-empty">
          <div class="overview-empty__icon">📁</div>
          <div class="overview-empty__text">${t('overview_no_projects')}</div>
          <button class="btn btn--primary btn--sm" data-go-projects>${t('overview_add_project')}</button>
        </div>
      `;
      pl.querySelector('[data-go-projects]')?.addEventListener('click', () => go('projects'));
    } else {
      pl.innerHTML = rps.map(p => `
        <div class="project-row" data-project-path="${esc(p.path)}" title="${t('projects_launch_title')}">
          <span class="project-row__star">⭐</span>
          <span class="project-row__name">${esc(p.name)}</span>
          <span class="project-row__path">${esc(p.path)}</span>
          <span class="project-row__model">${esc(p.model)}</span>
          <span class="project-row__play">▶</span>
        </div>
      `).join('');
      pl.querySelectorAll('.project-row').forEach(row => {
        row.addEventListener('click', async () => {
          const path = row.dataset.projectPath;
          if (!path) return;
          // 查找匹配的项目 ID 并启动
          const projects = await cb.projects.list();
          const proj = projects.find(p => p.path === path);
          if (proj) {
            const r = await cb.projects.launch(proj.id);
            if (r?.ok) flashToast(t('toast_launched'));
            else flashToast(t('toast_launch_failed') + (r?.reason || t('unknown_error')));
          } else {
            // 没有配置的项目，直接打开目录
            cb.shell.openPath(path);
          }
        });
      });
    }
  }
  // Activities
  const al = $('#overview-activities');
  if (al) {
    const acts = d.recentActivities || [];
    if (acts.length === 0) {
      al.innerHTML = `<div class="overview-empty" style="padding:24px 12px;font-size:12px;color:var(--text-2);">${t('overview_no_activities')}</div>`;
    } else {
      al.innerHTML = acts.map(a => `
        <div class="activity-item">
          <span class="activity-item__name">${esc(a.name)}</span>
          <span class="activity-item__path">${esc(a.path)}</span>
          <span class="activity-item__time">${esc(a.time)}</span>
        </div>
      `).join('');
    }
  }
  // 状态栏更新
  const meta = d.meta || {};
  $('#sb-records').textContent  = meta.sessionsScanned || 0;
  $('#sb-projects').textContent = (d.recentProjects || []).length;
  $('#sb-tokens').textContent   = (d.stats?.[3]?.value || '0').toString();
  $('#sb-level').textContent    = `Lv.${(await cb.data.getLevels())?.current?.lv || 1}`;
  // 数据源标记
  const sourceLabel = meta.source === 'real' ? t('overview_real_data') : t('overview_mock_data');
  const brand = $('#brand-status');
  if (brand) brand.textContent = `${sourceLabel} · ${meta.sessionsScanned || 0} ${t('brand_conversations')} · ${t('brand_source')} ${meta.logsPath || '~'}`;
  // 同步 sidebar badges（修复 HTML 硬编码）
  const levels = await cb.data.getLevels();
  updateSidebarBadges({
    projectCount: (d.recentProjects || []).length,
    modelCount:    (d.pieData || []).length,
    levelStr:      levels?.current ? `${levels.current.lv}/99` : null,
  });
  // 概览屏内嵌热力图（GitHub-style 53×7 网格，365 天）
  renderOverviewHeatmap();
}

// 真刷新按钮：清缓存 + 重渲染
$('#btn-refresh')?.addEventListener('click', async () => {
  await cb.data.rescan();
  refreshSidebarHeatmap();
  if (State.currentRoute === 'overview' || State.currentRoute === 'overview') renderOverview();
  flashToast(t('toast_data_refreshed'));
});

// ============================================================
// 屏 2：项目管理（用户手动配置 + 启动 Claude）
// ============================================================
let projectsSort = 'lastOpenedAt';
let projectsView = 'card';
let projectsSearch = '';
async function renderProjects() {
  const list = await cb.projects.list();
  const d = await cb.data.getProjects().catch(() => null);
  const statsByPath = new Map();
  if (d?.projects?.current?.path) statsByPath.set(d.projects.current.path, d.projects.current);
  const enriched = list.map(p => ({ ...p, sessions: 0, inTok: 0, outTok: 0, last: null, models: [], ...(statsByPath.get(p.path) || {}) }));
  enriched.sort((a, b) => {
    if (projectsSort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (projectsSort === 'addedAt') return (b.addedAt || '').localeCompare(a.addedAt || '');
    return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '');
  });
  const filtered = projectsSearch
    ? enriched.filter(p => (p.name + ' ' + p.path).toLowerCase().includes(projectsSearch.toLowerCase()))
    : enriched;
  const cEl = $('#projects-count');
  if (cEl) cEl.textContent = `(${enriched.length})`;
  const list2 = $('#project-list');
  const empty = $('#projects-empty');
  // 有项目 → 隐藏空态，渲染卡片；无项目 → 显示空态
  if (enriched.length === 0) {
    if (list2) list2.innerHTML = '';
    if (empty) empty.hidden = false;
  } else {
    if (empty) empty.hidden = true;
    if (list2) {
      list2.className = 'project-list' + (projectsView === 'list' ? ' project-list--list' : '');
      list2.innerHTML = filtered.map((p, i) => renderProjectCard(p, i === 0, projectsView)).join('');
    }
    bindProjectCardEvents();
  }
  bindProjectsToolbarEvents();
}
function renderProjectCard(p, isCurrent, view) {
  const cmd = `cd ${JSON.stringify(p.path)} && claude`;
  if (view === 'list') {
    return `
      <div class="project-row ${isCurrent ? 'project-row--current' : ''}" data-project-id="${esc(p.id)}">
        <span class="project-row__icon">📁</span>
        <span class="project-row__name">${esc(p.name)}${isCurrent ? '<span class="project-card__badge" style="margin-left:6px;">' + t('projects_current') + '</span>' : ''}</span>
        <span class="project-row__path">${esc(p.path)}</span>
        <span class="project-row__meta">${esc(p.turns || p.sessions || 0)} ${t('projects_sessions')} · ${fmtTok(p.inTok || 0)}</span>
        <span class="project-row__time">${esc(humanTime(p.lastOpenedAt))}</span>
        <span class="project-row__actions">
          <button class="btn btn--primary btn--sm" data-act="launch" title="${t('projects_launch_title')}">▶ Claude</button>
          <button class="btn btn--sm" data-act="finder" title="Finder">📂</button>
          <button class="btn btn--sm" data-act="more" title="${t('projects_more_title')}">⋯</button>
        </span>
      </div>
    `;
  }
  // card view (default)
  const meta = [
    `<span><b>${esc(p.turns || p.sessions || 0)}</b> ${t('projects_sessions')}</span>`,
    `<span><b>${fmtTok(p.inTok || 0)}</b> tokens</span>`,
    `<span>${t('projects_last_opened')} <b>${esc(humanTime(p.lastOpenedAt))}</b></span>`,
    `<span>${t('projects_added_at')} <b>${(p.addedAt || '').slice(0, 10)}</b></span>`,
  ].join('');
  return `
    <div class="project-card ${isCurrent ? 'project-card--current' : ''}" data-project-id="${esc(p.id)}">
      <div class="project-card__head">
        <div class="project-card__icon">📁</div>
        <div class="project-card__info">
          <div class="project-card__name">
            ${esc(p.name)}
            ${isCurrent ? '<span class="project-card__badge">' + t('projects_current_project') + '</span>' : ''}
          </div>
          <div class="project-card__path">${esc(p.path)}</div>
        </div>
      </div>
      <div class="project-card__meta">${meta}</div>
      <div class="project-card__actions">
        <button class="btn btn--primary" data-act="launch" title="${t('projects_launch_in_terminal')}">▶ ${t('projects_launch')}</button>
        <button class="btn" data-act="finder" title="${t('projects_show_in_finder')}">${t('projects_finder')}</button>
        <button class="btn" data-act="copy" title="${t('projects_copy_path_title')}">${t('projects_copy_path')}</button>
        <button class="btn" data-act="more" title="${t('projects_more_title')}">${t('projects_more')}</button>
      </div>
    </div>
  `;
}
function fmtTok(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}
function humanTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('human_just_now');
  if (m < 60) return m + t('human_minutes_ago');
  const h = Math.floor(m / 60);
  if (h < 24) return h + t('human_hours_ago');
  const days = Math.floor(h / 24);
  if (days === 1) return t('human_yesterday');
  if (days < 7) return days + t('human_days_ago');
  if (days < 30) return Math.floor(days / 7) + t('human_weeks_ago');
  return d.toISOString().slice(0, 10);
}
function bindProjectCardEvents() {
  // 同时绑定卡片视图和列表视图的事件
  $$('.project-card, .project-row').forEach(card => {
    const id = card.dataset.projectId;
    card.querySelectorAll('[data-act]').forEach(btn => {
      const act = btn.dataset.act;
      // 避免重复绑定
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      if (act === 'launch') btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = await cb.projects.launch(id);
        if (r?.ok) flashToast(t('toast_launched'));
        else flashToast(t('toast_launch_failed') + (r?.reason || t('unknown_error')));
      });
      if (act === 'finder') btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 从 .project-card__path 或 .project-row__path 获取路径
        const pathEl = $('.project-card__path', card) || $('.project-row__path', card);
        cb.shell.openPath(pathEl?.textContent || '');
      });
      if (act === 'copy') btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pathEl = $('.project-card__path', card) || $('.project-row__path', card);
        const path = pathEl?.textContent || '';
        await cb.clipboard.write(path);
        flashToast(t('toast_path_copied'));
      });
      if (act === 'more') btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showProjectMenu(e.currentTarget, id);
      });
    });
  });
}
let _projectsToolbarBound = false;
function bindProjectsToolbarEvents() {
  if (_projectsToolbarBound) return;
  _projectsToolbarBound = true;
  // 搜索框：input 事件静态绑一次（#projects-search DOM 不重建）
  $('#projects-search')?.addEventListener('input', (e) => { projectsSearch = e.target.value; renderProjects(); });
  // 排序 / 视图：事件委托（容器 DOM 静态，按钮可重建不影响）
  $('#projects-sort')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    projectsSort = btn.dataset.sort;
    $$('#projects-sort .seg__btn').forEach(x => x.classList.toggle('active', x === btn));
    renderProjects();
  });
  $('#projects-view')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    projectsView = btn.dataset.view;
    $$('#projects-view .seg__btn').forEach(x => x.classList.toggle('active', x === btn));
    renderProjects();
  });
  // 添加按钮：容器上委托（屏 2 内任何 .btn--primary 触发显示）
  $('#page-projects')?.addEventListener('click', (e) => {
    if (e.target.id === 'btn-add-project' || e.target.id === 'btn-add-project-empty') {
      showAddProjectModal();
    }
  });
}
async function showAddProjectModal() {
  const path = await cb.dialog.openDirectory({ title: t('projects_select_dir') });
  if (!path) return;
  const name = await promptModal({
    title: t('projects_dialog_title'),
    message: t('projects_dialog_message'),
    defaultValue: path.split('/').pop() || '',
    placeholder: t('projects_dialog_placeholder'),
    confirmLabel: t('confirm'),
  });
  if (name === null) return;
  const r = await cb.projects.add({ name: name.trim(), path });
  if (r.ok) {
    flashToast(t('toast_project_added') + r.project.name);
    renderProjects();
    cb.data.rescan().catch(() => {});
  } else {
    const reason = { 'path-not-exist': t('projects_reason_path'), 'duplicate': t('projects_reason_duplicate') }[r.reason] || r.reason;
    await alertModal({ title: t('projects_add_failed'), message: reason });
  }
}
function showProjectMenu(anchorBtn, projectId) {
  document.querySelectorAll('.menu-pop').forEach(m => m.remove());
  const rect = anchorBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu-pop';
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;z-index:999;`;
  menu.innerHTML = `
    <div class="menu-pop__item" data-act="rename">✏️ ${t('profiles_edit').replace(/^✏️ /, '')}</div>
    <div class="menu-pop__divider"></div>
    <div class="menu-pop__item menu-pop__item--danger" data-act="delete">🗑️ ${t('delete')}</div>
  `;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
  menu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const act = e.target.dataset.act;
    menu.remove();
    document.removeEventListener('click', close);
    if (act === 'delete') {
      const list = await cb.projects.list();
      const proj = list.find(p => p.id === projectId);
      if (await cb.dialog.confirm({
        message: t('projects_delete_confirm') + ` ${proj?.name || ''}？`,
        detail: t('projects_delete_detail'),
        confirmLabel: t('delete'),
      })) {
        await cb.projects.remove(projectId);
        flashToast(t('toast_project_deleted'));
        renderProjects();
        cb.data.rescan().catch(() => {});
      }
    } else if (act === 'rename') {
      const list = await cb.projects.list();
      const proj = list.find(p => p.id === projectId);
      const newName = await promptModal({
        title: t('projects_rename_title'),
        defaultValue: proj?.name || '',
        placeholder: t('projects_dialog_placeholder'),
        confirmLabel: t('save'),
      });
      if (newName && newName.trim()) {
        const s = await cb.settings.get();
        const next = (s.configuredProjects || []).map(p => p.id === projectId ? { ...p, name: newName.trim() } : p);
        await cb.settings.set({ configuredProjects: next });
        renderProjects();
      }
    }
  });
}

// ============================================================
// 屏 13：配置组（从 model_helper 融合）
// ============================================================
const ENV_LABELS = {
  ANTHROPIC_BASE_URL: () => t('profiles_env_base_url'),
  ANTHROPIC_AUTH_TOKEN: () => t('profiles_env_token'),
  ANTHROPIC_MODEL: () => t('profiles_env_default_model'),
  ANTHROPIC_DEFAULT_HAIKU_MODEL: () => t('profiles_env_haiku'),
  ANTHROPIC_DEFAULT_SONNET_MODEL: () => t('profiles_env_sonnet'),
  ANTHROPIC_DEFAULT_OPUS_MODEL: () => t('profiles_env_opus'),
  CLAUDE_CODE_SUBAGENT_MODEL: () => t('profiles_env_subagent'),
  API_TIMEOUT_MS: () => t('profiles_env_timeout'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: () => t('profiles_env_disable_traffic'),
};

async function renderProfiles() {
  // 1. 当前生效配置
  const currentEnv = await cb.profiles.current();
  const envWrap = $('#profile-current-env');
  if (envWrap) {
    const keys = Object.keys(currentEnv);
    if (keys.length === 0) {
      envWrap.innerHTML = '<div style="color:var(--text-2);padding:8px;font-size:12px;">' + t('profiles_no_env') + '</div>';
    } else {
      envWrap.innerHTML = '<div class="profile-env-grid">' + keys.map(k => `
        <div class="profile-env-item">
          <span class="profile-env-key">${esc(typeof ENV_LABELS[k] === 'function' ? ENV_LABELS[k]() : (ENV_LABELS[k] || k))}</span>
          <span class="profile-env-val">${esc(k === 'ANTHROPIC_AUTH_TOKEN' && currentEnv[k] ? '***' + String(currentEnv[k]).slice(-6) : currentEnv[k])}</span>
        </div>
      `).join('') + '</div>';
    }
  }

  // 2. Profile 列表
  const list = await cb.profiles.list();
  const badge = $('#badge-profiles');
  if (badge) badge.textContent = list.length;

  const listEl = $('#profile-list');
  const emptyEl = $('#profiles-empty');

  if (list.length === 0) {
    if (listEl) listEl.innerHTML = '';
    if (emptyEl) emptyEl.hidden = false;
  } else {
    if (emptyEl) emptyEl.hidden = true;
    if (listEl) {
      listEl.innerHTML = list.map(p => {
        const hasToken = p.env?.ANTHROPIC_AUTH_TOKEN;
        const maskedToken = hasToken ? '***' + String(p.env.ANTHROPIC_AUTH_TOKEN).slice(-6) : '—';
        return `
          <div class="card" style="margin-bottom:12px;" data-profile-name="${esc(p.name)}">
            <div class="card__header">
              <div class="card__title">📦 ${esc(p.name)}</div>
              <div class="card__hint">${esc(p.description || t('profiles_no_desc'))}</div>
              <div style="margin-left:auto;display:flex;gap:6px;">
                <button class="btn btn--primary btn--sm" data-act="switch" data-name="${esc(p.name)}">${t("profiles_switch")}</button>
                <button class="btn btn--sm" data-act="edit" data-name="${esc(p.name)}">${t("profiles_edit")}</button>
                <button class="btn btn--sm" data-act="delete" data-name="${esc(p.name)}" style="color:var(--red);">🗑️</button>
              </div>
            </div>
            <div class="profile-env-grid" style="margin-top:8px;">
              <div class="profile-env-item"><span class="profile-env-key">${t('profiles_env_base_url')}</span><span class="profile-env-val">${esc(p.env?.ANTHROPIC_BASE_URL || '—')}</span></div>
              <div class="profile-env-item"><span class="profile-env-key">${t('profiles_env_token')}</span><span class="profile-env-val">${maskedToken}</span></div>
              <div class="profile-env-item"><span class="profile-env-key">${t('profiles_env_default_model')}</span><span class="profile-env-val">${esc(p.env?.ANTHROPIC_MODEL || '—')}</span></div>
              <div class="profile-env-item"><span class="profile-env-key">${t('profiles_env_haiku')}</span><span class="profile-env-val">${esc(p.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL || '—')}</span></div>
              <div class="profile-env-item"><span class="profile-env-key">${t('profiles_env_sonnet')}</span><span class="profile-env-val">${esc(p.env?.ANTHROPIC_DEFAULT_SONNET_MODEL || '—')}</span></div>
              <div class="profile-env-item"><span class="profile-env-key">${t('profiles_env_opus')}</span><span class="profile-env-val">${esc(p.env?.ANTHROPIC_DEFAULT_OPUS_MODEL || '—')}</span></div>
            </div>
          </div>
        `;
      }).join('');
      // 绑定事件
      listEl.querySelectorAll('[data-act]').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        const act = btn.dataset.act;
        const name = btn.dataset.name;
        if (act === 'switch') btn.addEventListener('click', async () => {
          const r = await cb.profiles.switchTo(name);
          if (r.ok) { flashToast(t('profiles_switched') + name); renderProfiles(); }
          else flashToast(t('profiles_switch_failed') + (r.reason || t('unknown_error')));
        });
        if (act === 'edit') btn.addEventListener('click', () => editProfileModal(name));
        if (act === 'delete') btn.addEventListener('click', async () => {
          if (await cb.dialog.confirm({ message: t('profiles_delete_confirm') + ` "${name}"？`, detail: t('profiles_delete_detail') })) {
            await cb.profiles.delete(name);
            flashToast(t('toast_profile_deleted') + name);
            renderProfiles();
          }
        });
      });
    }
  }

  // 新建按钮事件
  $('#btn-add-profile')?.addEventListener('click', () => addProfileModal());
  $('#btn-add-profile-empty')?.addEventListener('click', () => addProfileModal());
}

// ====== Profile 表单弹窗（统一新建/编辑）======
const PROFILE_FIELDS = [
  { key: 'ANTHROPIC_BASE_URL',                       label: () => t('profiles_env_base_url_label'),   ph: 'https://api.anthropic.com' },
  { key: 'ANTHROPIC_AUTH_TOKEN',                      label: () => t('profiles_env_auth_token_label'), ph: 'sk-ant-...' },
  { key: 'ANTHROPIC_MODEL',                           label: () => t('profiles_env_default_model_label'), ph: 'claude-sonnet-4-20250514' },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',             label: () => t('profiles_env_haiku_label'), ph: 'claude-haiku-4-20250514' },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL',            label: () => t('profiles_env_sonnet_label'), ph: 'claude-sonnet-4-20250514' },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL',              label: () => t('profiles_env_opus_label'), ph: 'claude-opus-4-20250514' },
  { key: 'CLAUDE_CODE_SUBAGENT_MODEL',                label: () => t('profiles_env_subagent_label'), ph: 'claude-haiku-4-20250514' },
  { key: 'API_TIMEOUT_MS',                            label: () => t('profiles_env_timeout_label'), ph: '3000000' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',  label: () => t('profiles_env_disable_label'), ph: '1' },
];

function showProfileFormModal({ title, nameValue, descValue, envValues, confirmLabel, onConfirm }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const fieldsHtml = PROFILE_FIELDS.map(f => `
      <div class="pf-field">
        <label class="pf-field__label" for="pf-${f.key}">${esc(typeof f.label === 'function' ? f.label() : f.label)}</label>
        <input class="input pf-field__input" id="pf-${f.key}" data-key="${f.key}"
               value="${esc(envValues[f.key] || '')}" placeholder="${esc(f.ph)}" />
      </div>
    `).join('');

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="width:520px;max-height:85vh;display:flex;flex-direction:column;">
        <div class="modal__title">${esc(title)}</div>
        <div style="display:flex;gap:8px;margin:8px 0;">
          <div style="flex:1;">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:4px;">${t("profiles_form_name")}</div>
            <input class="input" id="pf-name" value="${esc(nameValue || '')}" placeholder="my-provider"
                   ${nameValue ? 'style="opacity:0.6;" readonly' : ''} />
          </div>
          <div style="flex:1;">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:4px;">${t("profiles_form_desc")}</div>
            <input class="input" id="pf-desc" value="${esc(descValue || '')}" placeholder="${t("profiles_form_desc_ph")}" />
          </div>
        </div>
        <div style="font-size:12px;font-weight:600;color:var(--text-1);margin:8px 0 4px;">${t("profiles_form_env")}</div>
        <div class="pf-fields" style="overflow-y:auto;flex:1;padding-right:4px;">
          ${fieldsHtml}
        </div>
        <div class="modal__actions" style="margin-top:12px;flex-shrink:0;">
          <button class="btn" id="pf-cancel">${t("profiles_form_cancel")}</button>
          <button class="btn btn--primary" id="pf-ok">${esc(confirmLabel || t('save'))}</button>
        </div>
      </div>
    `;

    const close = (val) => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('#pf-cancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    overlay.querySelector('#pf-ok').addEventListener('click', () => {
      const name = overlay.querySelector('#pf-name')?.value?.trim();
      const desc = overlay.querySelector('#pf-desc')?.value?.trim() || '';
      if (!name) { overlay.querySelector('#pf-name').style.borderColor = 'var(--red)'; return; }
      const env = {};
      overlay.querySelectorAll('.pf-field__input').forEach(input => {
        const val = input.value.trim();
        if (val) env[input.dataset.key] = val;
      });
      onConfirm({ name, description: desc, env }).then(r => close(r));
    });

    document.body.appendChild(overlay);
    setTimeout(() => (overlay.querySelector('#pf-name') || overlay.querySelector('.pf-field__input'))?.focus(), 0);
  });
}

async function addProfileModal() {
  await showProfileFormModal({
    title: t('profiles_form_title_new'),
    nameValue: '',
    descValue: '',
    envValues: {},
    confirmLabel: t('profiles_form_create'),
    onConfirm: async ({ name, description, env }) => {
      const r = await cb.profiles.add({ name, description, env });
      if (r.ok) { flashToast(t('profiles_created') + name + t('profiles_created_suffix')); renderProfiles(); }
      else { await alertModal({ title: t('profiles_create_failed'), message: r.reason === 'duplicate' ? t('profiles_create_failed_duplicate') : (r.reason || t('unknown_error')) }); }
      return r;
    },
  });
}

async function editProfileModal(name) {
  const p = await cb.profiles.get(name);
  if (!p) { flashToast(t('profiles_not_found')); return; }
  await showProfileFormModal({
    title: t('profiles_form_title_edit') + name,
    nameValue: name,
    descValue: p.description || '',
    envValues: p.env || {},
    confirmLabel: t('profiles_form_save'),
    onConfirm: async ({ description, env }) => {
      await cb.profiles.update(name, { description, env });
      flashToast(t('profiles_updated') + name);
      renderProfiles();
      return { ok: true };
    },
  });
}


async function renderModels() {
  const d = await cb.data.getModels();
  if (!d) return;
  const wrap = $('#model-cards');
  if (wrap) {
    wrap.innerHTML = (d.cards || []).map(m => `
      <div class="card model-card" style="${m.count === 0 ? 'opacity:0.5;' : ''}">
        <div class="model-card__name">${esc(m.name)}</div>
        <div class="model-card__bar"><div class="model-card__bar-fill" style="width:${m.bar}%"></div></div>
        <div class="model-card__stats">
          <span>${m.count} ${t('models_times')}</span>
          <span>${esc(m.inTok)} in / ${esc(m.outTok)} out</span>
        </div>
        <div class="model-card__cost">${esc(m.cost)}</div>
        <button class="btn" style="margin-top:4px;" data-model-detail="${esc(m.name)}">${t("models_detail")}</button>
      </div>
    `).join('');
    // "查看详情" 按钮 → 跳到 tokens 屏
    wrap.querySelectorAll('[data-model-detail]').forEach(b => b.addEventListener('click', () => {
      go('tokens');
    }));
  }
  const tbody = $('#price-tbody');
  if (tbody) {
    tbody.innerHTML = (d.prices || []).map(p => `
      <tr>
        <td class="price-table__name">${esc(p.name)}</td>
        <td>${esc(p.in)}</td>
        <td>${esc(p.out)}</td>
        <td>${esc(p.cw)}</td>
        <td>${esc(p.cr)}</td>
        <td>
          <span class="price-table__action" data-edit="${esc(p.name)}">${t('models_edit')}</span>
          <span class="price-table__action" data-delete="${esc(p.name)}" style="color:var(--red);margin-left:8px;">${t('models_delete')}</span>
        </td>
      </tr>
    `).join('');
    // 编辑价格
    tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editModelPrice(b.dataset.edit)));
    // 删除自定义模型
    tbody.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
      const name = b.dataset.delete;
      if (await cb.dialog.confirm({ message: t('models_confirm_delete') + ' ' + name + '?', detail: t('models_confirm_delete_detail') })) {
        await cb.models.deletePrice?.(name) || await ipcRenderer?.invoke('models:delete-price', name);
        flashToast(t('models_deleted') + name);
        renderModels();
      }
    }));
  }
  // 绑"添加自定义模型"按钮
  const addBtn = $('#page-models .btn--primary');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => addCustomModel());
  }
}

// 编辑模型价格弹窗
async function editModelPrice(name) {
  // 从 preload 获取当前价格
  const prices = await cb.models.listPrices?.() || {};
  const cur = prices[name] || { in: 0, out: 0, cw: 0, cr: 0 };
  const inVal = await promptModal({ title: t('models_edit_price_title') + ' ' + name + ' — ' + t('models_input_price'), message: t('models_price_unit'), defaultValue: String(cur.in || 0), placeholder: '0.00' });
  if (inVal === null) return;
  const outVal = await promptModal({ title: t('models_edit_price_title') + ' ' + name + ' — ' + t('models_output_price'), message: t('models_price_unit'), defaultValue: String(cur.out || 0), placeholder: '0.00' });
  if (outVal === null) return;
  const cwVal = await promptModal({ title: t('models_edit_price_title') + ' ' + name + ' — ' + t('models_cw_price'), message: t('models_price_unit'), defaultValue: String(cur.cw || 0), placeholder: '0.00' });
  if (cwVal === null) return;
  const crVal = await promptModal({ title: t('models_edit_price_title') + ' ' + name + ' — ' + t('models_cr_price'), message: t('models_price_unit'), defaultValue: String(cur.cr || 0), placeholder: '0.00' });
  if (crVal === null) return;
  const r = await cb.models.updatePrice?.({
    name,
    price: { in: +inVal, out: +outVal, cw: +cwVal, cr: +crVal },
  });
  if (r?.ok) {
    flashToast(t('models_updated_price') + name + t('models_updated_price_suffix'));
    renderModels();
  } else {
    await alertModal({ title: t('models_update_failed'), message: r?.reason || t('unknown_error') });
  }
}

// 添加自定义模型
async function addCustomModel() {
  const name = await promptModal({ title: t('models_add_custom_title'), message: t('models_add_custom_message'), placeholder: t('models_add_custom_placeholder') });
  if (!name || !name.trim()) return;
  const inVal = await promptModal({ title: `${name.trim()} — ${t('models_input_price')}`, message: '$/1M tokens', defaultValue: '1.0', placeholder: '0.00' });
  if (inVal === null) return;
  const outVal = await promptModal({ title: `${name.trim()} — ${t('models_output_price')}`, message: '$/1M tokens', defaultValue: '3.0', placeholder: '0.00' });
  if (outVal === null) return;
  const cwVal = await promptModal({ title: `${name.trim()} — ${t('models_cw_price')}`, message: '$/1M tokens', defaultValue: '1.25', placeholder: '0.00' });
  if (cwVal === null) return;
  const crVal = await promptModal({ title: `${name.trim()} — ${t('models_cr_price')}`, message: '$/1M tokens', defaultValue: '0.1', placeholder: '0.00' });
  if (crVal === null) return;
  const r = await cb.models.updatePrice?.({
    name: name.trim(),
    price: { in: +inVal, out: +outVal, cw: +cwVal, cr: +crVal },
  });
  if (r?.ok) {
    flashToast(t('models_added') + name.trim());
    renderModels();
  } else {
    await alertModal({ title: t('models_add_failed'), message: r?.reason || t('unknown_error') });
  }
}

// ============================================================
// 屏 4：Token
// ============================================================
async function renderTokens() {
  const d = await cb.data.getTokens();
  if (!d) return;
  const overview = await cb.data.getOverview();

  // ===== 维度 1：总量 =====
  const wrap = $('#token-stats');
  if (wrap) {
    wrap.innerHTML = (d.stats || []).map(s => `
      <div class="token-stat">
        <div class="token-stat__label">${esc(s.label)}</div>
        <div class="token-stat__value">${esc(s.value)}<span class="token-stat__unit">${esc(s.unit)}</span></div>
      </div>
    `).join('');
  }
  if (d.savings) {
    $('#savings-hitrate').textContent = d.savings.hitRate ?? '—';
    $('#savings-saved').textContent   = d.savings.saved ?? '—';
  }

  // ===== 维度 2：Model × Token =====
  const models = await cb.data.getModels();
  const modelTbody = $('#token-model-tbody');
  if (modelTbody && models?.cards?.length) {
    const totalIn = models.cards.reduce((s, m) => s + parseTokStr(m.inTok), 0);
    const totalOut = models.cards.reduce((s, m) => s + parseTokStr(m.outTok), 0);
    let rows = models.cards.map(m => {
      const inV = parseTokStr(m.inTok);
      const outV = parseTokStr(m.outTok);
      return `<tr>
        <td class="token-table__name">${esc(m.name)}</td>
        <td>${fmtTok(inV)}</td><td>${fmtTok(outV)}</td><td>—</td><td>—</td>
        <td><b>${fmtTok(inV + outV)}</b></td>
        <td class="token-table__cost">${esc(m.cost)}</td>
      </tr>`;
    }).join('');
    rows += `<tr class="token-table__total">
      <td><b>${t('token_total')}</b></td>
      <td><b>${fmtTok(totalIn)}</b></td><td><b>${fmtTok(totalOut)}</b></td><td>—</td><td>—</td>
      <td><b>${fmtTok(totalIn + totalOut)}</b></td>
      <td class="token-table__cost"><b>$${models.cards.reduce((s, m) => s + parseFloat(m.cost.replace('$','')), 0).toFixed(2)}</b></td>
    </tr>`;
    modelTbody.innerHTML = rows;
  }

  // Model 堆叠柱状图
  const modelChart = getOrInitChart('token-model-chart');
  if (modelChart && models?.cards?.length) {
    const names = models.cards.map(m => m.name);
    const inData = models.cards.map(m => parseTokStr(m.inTok));
    const outData = models.cards.map(m => parseTokStr(m.outTok));
    modelChart.setOption({
      ...echartsBase,
      tooltip: { ...echartsBase.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { textStyle: { color: '#a3a8b8', fontSize: 11 } },
      grid: { left: 50, right: 20, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: names, axisLabel: { color: '#6c7384', fontSize: 10, rotate: 15 } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2f3d' } }, axisLabel: { color: '#6c7384', fontSize: 10, formatter: v => fmtTok(v) } },
      series: [
        { name: 'Input', type: 'bar', stack: 'tok', data: inData, itemStyle: { color: '#5b9dff' }, barMaxWidth: 36 },
        { name: 'Output', type: 'bar', stack: 'tok', data: outData, itemStyle: { color: '#22d3ee', borderRadius: [3,3,0,0] }, barMaxWidth: 36 },
      ],
    }, true);
  }

  // ===== 维度 3：天 × Token =====
  const trendDays = overview?.trendDays || [];
  const trendData = overview?.trendData || [];
  const dailyTbody = $('#token-daily-tbody');
  if (dailyTbody && trendDays.length) {
    dailyTbody.innerHTML = trendDays.map((day, i) => {
      const turns = trendData[i] || 0;
      return `<tr>
        <td>${esc(day)}</td>
        <td>${turns}</td>
        <td>${turns > 0 ? fmtTok(turns * 2000) : '0'}</td>
        <td>$${(turns * 0.05).toFixed(2)}</td>
      </tr>`;
    }).reverse().join('');
  }

  // 天折线图
  const dailyChart = getOrInitChart('token-daily-chart');
  if (dailyChart && trendDays.length) {
    dailyChart.setOption({
      ...echartsBase,
      tooltip: { ...echartsBase.tooltip, trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: trendDays, boundaryGap: false,
        axisLine: { lineStyle: { color: '#2a2f3d' } }, axisLabel: { color: '#6c7384', fontSize: 10 } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#2a2f3d' } }, axisLabel: { color: '#6c7384', fontSize: 10 } },
      series: [{
        name: t('token_sessions'), type: 'line', smooth: true, data: trendData,
        symbolSize: 5, itemStyle: { color: '#4ade80' },
        lineStyle: { width: 2, color: '#4ade80' },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(74,222,128,0.3)' }, { offset: 1, color: 'rgba(74,222,128,0)' },
        ])},
      }],
    }, true);
  }

  // ===== 桑基图 =====
  const sk = getOrInitChart('sankey-chart');
  if (sk && d.sankey && d.sankey.nodes && d.sankey.nodes.length > 0) {
    sk.setOption({
      ...echartsBase,
      tooltip: { ...echartsBase.tooltip, trigger: 'item', triggerOn: 'mousemove' },
      series: [{
        type: 'sankey', data: d.sankey.nodes, links: d.sankey.links,
        label: { color: '#a3a8b8', fontSize: 11 },
        lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.4 },
        itemStyle: { borderWidth: 0 },
        color: ['#5b9dff', '#22d3ee', '#4ade80', '#a78bfa', '#fb923c', '#f472b6'],
      }],
    });
  }
}

// 解析 "1.2M" / "500K" 格式回数字
function parseTokStr(s) {
  if (!s) return 0;
  const str = String(s).replace(/,/g, '');
  if (str.endsWith('M')) return parseFloat(str) * 1e6;
  if (str.endsWith('K')) return parseFloat(str) * 1e3;
  return parseFloat(str) || 0;
}

// ============================================================
// 屏 5：等级（真数据计算）
// ============================================================
async function renderLevels() {
  const lv = await cb.data.getLevels();
  if (!lv) return;
  const c = lv.current;
  // 更新 hero
  const hero = $('.level-info');
  if (hero) {
    hero.querySelector('.level-info__lv').textContent = `Lv.${c.lv}`;
    // 更新称号
    const titleEl = hero.querySelector('.level-info__title');
    if (titleEl) titleEl.textContent = LEVEL_TITLES[Math.min(c.lv, LEVEL_TITLES.length) - 1] || `Lv.${c.lv}`;
    const fill = hero.querySelector('.level-info__progress-fill');
    if (fill) fill.style.width = `${Math.min(100, (c.score / c.target) * 100).toFixed(1)}%`;
    const text = hero.querySelector('.level-info__progress-text');
    if (text) {
      text.children[0].textContent = `${c.score.toLocaleString()} / ${c.target.toLocaleString()} ${t("levels_points")}`;
      text.children[1].textContent = c.target > c.score ? `${t("levels_next")} Lv.${c.lv + 1} ${t("levels_need")} ${(c.target - c.score).toLocaleString()} ${t("levels_points")}` : t('levels_max_level');
    }
  }
  const stats = $('.level-stats');
  if (stats) {
    stats.children[0].children[1].textContent = `${c.lv} / 99`;
    stats.children[1].children[1].textContent = LEVEL_TITLES[Math.min(c.lv, LEVEL_TITLES.length)] || `Lv.${c.lv + 1}`;
    stats.children[2].children[1].textContent = c.score.toLocaleString();
    stats.children[3].children[1].textContent = c.streak > 0 ? t('levels_active_streak') + c.streak + t('levels_active_days') : '—';
  }
  // 动态渲染段位卡（基于真实等级）
  const sprout = $('#level-grid-sprout');
  if (sprout) {
    sprout.innerHTML = generateLevelCards(1, 5, c.lv);
  }
  const scholar = $('#level-grid-scholar');
  if (scholar) {
    scholar.innerHTML = generateLevelCards(6, 10, c.lv);
  }
  // Lv.99 AI 大牛预览：未达 99 级时灰显
  const maxPreview = document.querySelector('.max-level-preview');
  if (maxPreview) {
    const isMax = c.lv >= 99;
    maxPreview.classList.toggle('max-level-preview--locked', !isMax);
    const titleEl = maxPreview.querySelector('div[style*="font-size:24px"]');
    if (titleEl) {
      titleEl.textContent = isMax ? t('levels_max_unlocked') : t('levels_max_locked');
    }
    const descEl = maxPreview.querySelector('div[style*="font-size:12px"]');
    if (descEl) {
      descEl.textContent = isMax
        ? t('levels_max_reward')
        : `${t("levels_max_need")} ${Math.max(0, (99 * 1240 - c.score)).toLocaleString()} ${t("levels_points")}`;
    }
  }
  // 更新段位标题
  const sproutTitle = sprout?.previousElementSibling;
  if (sproutTitle) {
    const lock = sproutTitle.querySelector('.level-section__lock');
    if (lock) lock.textContent = c.lv >= 5 ? t('levels_unlocked') : `${t("levels_unlocked")} Lv.1-${c.lv}`;
  }
  const scholarTitle = scholar?.previousElementSibling;
  if (scholarTitle) {
    const lock = scholarTitle.querySelector('.level-section__lock');
    if (lock) {
      if (c.lv >= 10) lock.textContent = t('levels_unlocked');
      else if (c.lv >= 6) lock.textContent = `Lv.${c.lv} ${t("levels_unlocked")} · ${t("levels_need")} ${c.target.toLocaleString()} ${t("levels_points")} → Lv.${c.lv + 1}`;
      else lock.textContent = `🔒 ${t('levels_need')} 6,200 ${t('levels_points')}`;
    }
  }
}
// 等级页帮助按钮：显示升级规则弹窗
$('#btn-level-help')?.addEventListener('click', () => {
  alertModal({
    title: t('levels_help_title'),
    message:
      t('levels_help_score_title') + '\n' +
      t('levels_help_session') + '\n' +
      t('levels_help_input') + '\n' +
      t('levels_help_output') + '\n' +
      t('levels_help_streak') + '\n\n' +
      t('levels_help_level_title') + '\n' +
      t('levels_help_sprout') + '\n' +
      t('levels_help_scholar') + '\n' +
      t('levels_help_craftsman') + '\n' +
      t('levels_help_expert') + '\n' +
      t('levels_help_master') + '\n' +
      t('levels_help_max'),
    confirmLabel: t('levels_help_got_it'),
  });
});

// 等级名称表（1-10）
const LEVEL_TITLES = [
  '🌱 嫩芽', '🌿 幼苗', '🍀 三叶', '🌳 小树', '🌲 大树',
  '📜 竹简', '📖 翻书', '🎓 学士', '🧑‍🎓 硕士', '👨‍🏫 博士',
];
// 每个等级的 SVG 图标（简化版）
const LEVEL_ICONS = [
  // Lv.1 嫩芽
  '<svg viewBox="0 0 48 48" fill="none"><path d="M24 8 C24 8 14 12 14 22 C14 30 24 40 24 40 C24 40 34 30 34 22 C34 12 24 8 24 8 Z" fill="#4ade80" opacity="0.7"/><path d="M24 8 L24 40" stroke="#4ade80" stroke-width="1.5"/></svg>',
  // Lv.2 幼苗
  '<svg viewBox="0 0 48 48" fill="none"><path d="M14 36 C8 28 12 18 18 14 M34 36 C40 28 36 18 30 14 M24 38 L24 12" stroke="#4ade80" stroke-width="2" fill="none"/><circle cx="18" cy="18" r="3" fill="#4ade80"/><circle cx="30" cy="18" r="3" fill="#4ade80"/></svg>',
  // Lv.3 三叶
  '<svg viewBox="0 0 48 48" fill="none"><path d="M24 10 L24 38" stroke="#4ade80" stroke-width="2"/><circle cx="14" cy="20" r="6" fill="#4ade80" opacity="0.7"/><circle cx="34" cy="20" r="6" fill="#4ade80" opacity="0.7"/><circle cx="24" cy="14" r="6" fill="#22c55e" opacity="0.7"/></svg>',
  // Lv.4 小树
  '<svg viewBox="0 0 48 48" fill="none"><rect x="20" y="12" width="8" height="30" fill="#4ade80"/><circle cx="24" cy="10" r="10" fill="#4ade80" opacity="0.8"/><circle cx="18" cy="14" r="6" fill="#4ade80" opacity="0.5"/><circle cx="30" cy="14" r="6" fill="#4ade80" opacity="0.5"/></svg>',
  // Lv.5 大树
  '<svg viewBox="0 0 48 48" fill="none"><path d="M14 40 L24 8 L34 40 Z" fill="#4ade80"/><path d="M18 40 L24 24 L30 40 Z" fill="#22c55e" opacity="0.7"/><rect x="22" y="36" width="4" height="6" fill="#7c2d12"/></svg>',
  // Lv.6 竹简
  '<svg viewBox="0 0 48 48" fill="none"><rect x="10" y="8" width="28" height="32" rx="2" fill="#5b9dff" opacity="0.3"/><line x1="10" y1="14" x2="38" y2="14" stroke="#5b9dff" stroke-width="1.5"/><line x1="10" y1="20" x2="38" y2="20" stroke="#5b9dff" stroke-width="1" opacity="0.5"/></svg>',
  // Lv.7 翻书
  '<svg viewBox="0 0 48 48" fill="none"><path d="M24 8 L8 14 L8 40 L24 36 Z" fill="#5b9dff" opacity="0.6"/><path d="M24 8 L40 14 L40 40 L24 36 Z" fill="#22d3ee" opacity="0.6"/></svg>',
  // Lv.8 学士
  '<svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="14" fill="none" stroke="#5b9dff" stroke-width="2" opacity="0.5"/><path d="M16 24 L22 30 L32 18" stroke="#5b9dff" stroke-width="2.5" fill="none"/></svg>',
  // Lv.9 硕士
  '<svg viewBox="0 0 48 48" fill="none"><path d="M24 8 L24 18 M14 14 L34 14" stroke="#5b9dff" stroke-width="2"/><path d="M8 18 L40 18 L36 32 L12 32 Z" fill="#5b9dff" opacity="0.3"/><circle cx="24" cy="36" r="2" fill="#5b9dff"/></svg>',
  // Lv.10 博士
  '<svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="18" r="8" fill="none" stroke="#5b9dff" stroke-width="2"/><path d="M12 38 C12 30 18 26 24 26 C30 26 36 30 36 38" fill="#5b9dff" opacity="0.3"/><rect x="20" y="14" width="8" height="4" fill="#5b9dff" opacity="0.4"/></svg>',
];

// 动态生成等级卡
function generateLevelCards(from, to, currentLv) {
  let html = '';
  for (let i = from; i <= to && i <= LEVEL_ICONS.length; i++) {
    const isCurrent = i === currentLv;
    const isUnlocked = i <= currentLv;
    const cls = isCurrent ? 'level-card--current' : (isUnlocked ? 'level-card--unlocked' : 'level-card--locked');
    const title = LEVEL_TITLES[i - 1] || `Lv.${i}`;
    const lvLabel = isCurrent ? `Lv.${i} ← YOU` : `Lv.${i}`;
    const lvStyle = isCurrent ? ' style="color:var(--accent);font-weight:600;"' : '';
    html += `
      <div class="level-card ${cls}">
        ${LEVEL_ICONS[i - 1]}
        <div class="level-card__lv"${lvStyle}>${lvLabel}</div>
        <div class="level-card__name">${title}</div>
      </div>
    `;
  }
  return html;
}

// ============================================================
// 屏 6：年度热力图（按自然年展示）
// ============================================================
async function renderHeatmap90d() {
  const d = await cb.data.getHeatmap90d();
  const heatmap = d?.heatmap || [];
  const stats = d?.stats || [];

  const now = new Date();
  const year = now.getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const totalDaysInYear = (new Date(year, 11, 31) - new Date(year, 0, 1)) / 86400000 + 1;

  // 本年数据
  const yearData = heatmap.filter(([k]) => k.startsWith(String(year)));
  const activeDays = yearData.filter(([_, v]) => v > 0).length;
  const daysPassed = Math.min(totalDaysInYear, Math.floor((now - new Date(year, 0, 1)) / 86400000) + 1);

  // 统计卡片
  const statsWrap = $('#heatmap-90d-stats');
  if (statsWrap) {
    const defaultStats = stats.length > 0 ? stats : [
      { label: t('heatmap_total_active_days'), value: String(activeDays), delta: `/ ${daysPassed} ${t('heatmap_day_unit')}` },
      { label: t('heatmap_current_streak'), value: '0 ' + t('heatmap_day_unit'), delta: '—' },
      { label: t('heatmap_daily_avg'), value: daysPassed > 0 ? (activeDays / daysPassed).toFixed(1) + ' ' + t('heatmap_times_unit') : '0 ' + t('heatmap_times_unit'), delta: '—' },
      { label: t('heatmap_weekly_active'), value: '0 / 7', delta: '—' },
    ];
    statsWrap.innerHTML = defaultStats.map(s => `
      <div class="card stat-card">
        <div class="stat-card__label">${esc(s.label)}</div>
        <div class="stat-card__value">${esc(String(s.value))}</div>
        <div class="stat-card__delta stat-card__delta--up">${esc(s.delta || '—')}</div>
      </div>
    `).join('');
  }

  // 副标题
  const sub = $('#heatmap-90d-sub');
  if (sub) {
    sub.textContent = year + t('heatmap_year_active') + activeDays + ' / ' + daysPassed + t('heatmap_days');
  }

  // ECharts 日历热力图 — 整个自然年
  const chartEl = document.getElementById('heatmap-90d-chart');
  if (chartEl) {
    chartEl.style.height = '260px';
    const chart = getOrInitChart('heatmap-90d-chart');
    if (chart && heatmap.length > 0) {
      const data = yearData.map(([k, v]) => [k, v]);
      const hc = getHeatmapColors();
      chart.setOption({
        ...echartsBase,
        tooltip: {
          ...echartsBase.tooltip,
          formatter: (p) => p.value ? `${p.value[0]}<br/><b>${p.value[1]}</b>` : '',
        },
        visualMap: {
          min: 0,
          max: Math.max(10, ...data.map(d => d[1])),
          type: 'piecewise',
          orient: 'horizontal',
          left: 'center',
          top: 0,
          pieces: [
            { min: 0, max: 0, color: hc.noData, label: t('calendar_no_data') },
            { min: 1, max: 3, color: hc.level1 },
            { min: 4, max: 8, color: hc.level2 },
            { min: 9, max: 15, color: hc.level3 },
            { min: 16, color: hc.level4 },
          ],
          textStyle: { color: hc.labelColor, fontSize: 11 },
        },
        calendar: {
          top: 60, left: 40, right: 30, bottom: 20,
          range: [yearStart, yearEnd],
          cellSize: ['auto', 16],
          splitLine: { show: true, lineStyle: { color: hc.splitLine, width: 2 } },
          itemStyle: { color: hc.cellBg, borderWidth: 3, borderColor: hc.splitLine, borderRadius: 2 },
          yearLabel: { show: true, color: hc.labelColor, fontSize: 14, margin: 40 },
          dayLabel: { color: hc.labelColor, fontSize: 10, nameMap: 'ZH', firstDay: 1 },
          monthLabel: { color: hc.labelColor, fontSize: 10, nameMap: 'ZH', margin: 6 },
        },
        series: [{
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: data,
          itemStyle: { borderRadius: 4, borderWidth: 0 },
        }],
      }, true);
    }
  }

  // 30 天柱状图
  const barEl = document.getElementById('heatmap-30d-bar');
  if (barEl) {
    barEl.style.height = '220px';
    const barChart = getOrInitChart('heatmap-30d-bar');
    if (barChart && heatmap.length > 0) {
      const last30 = heatmap.slice(-30);
      const days = last30.map(([k]) => k.slice(5)); // MM-DD
      const vals = last30.map(([_, v]) => v);
      const hc = getHeatmapColors();
      const isLight = document.documentElement.classList.contains('theme-light');
      barChart.setOption({
        ...echartsBase,
        grid: { left: 40, right: 20, top: 20, bottom: 30 },
        tooltip: { ...echartsBase.tooltip, trigger: 'axis' },
        xAxis: {
          type: 'category', data: days,
          axisLine: { lineStyle: { color: isLight ? '#d1d5db' : '#2a2f3d' } },
          axisLabel: { color: hc.labelColor, fontSize: 10, interval: 2 },
        },
        yAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: isLight ? '#e5e7eb' : '#2a2f3d' } },
          axisLabel: { color: hc.labelColor, fontSize: 10 },
        },
        series: [{
          type: 'bar', data: vals,
          itemStyle: {
            borderRadius: [3, 3, 0, 0],
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: hc.level4 },
              { offset: 1, color: hc.level1 },
            ]),
          },
          barMaxWidth: 16,
        }],
      }, true);
    }
  }
}

// 刷新按钮
$('#btn-heatmap-refresh')?.addEventListener('click', async () => {
  await cb.data.rescan();
  renderHeatmap90d();
  flashToast(t('toast_heatmap_refreshed'));
});

// ============================================================
// 屏 6：概览内嵌热力图（真数据）
// ============================================================
async function renderOverviewHeatmap() {
  const wrap = $('#heatmap-grid');
  if (!wrap) return;
  const d = await cb.data.getOverview();
  const heatmap = (d && d.heatmap) || [];
  if (!heatmap.length) { wrap.innerHTML = '<div style="color:var(--text-2);padding:20px;">—</div>'; return; }

  // GitHub-style 完整版：53 周 × 7 天 = 371 圆点（点阵）
  // 用 SVG <circle> 渲染（绝对坐标，100% 圆点，避开 CSS 布局坑）
  const byDate = new Map(heatmap.map(([k, v]) => [k, v]));
  const maxV = Math.max(1, ...heatmap.map(([_, v]) => v || 0));
  const startDate = new Date(heatmap[0][0]);
  const startDow = startDate.getDay();
  const offset = (startDow + 6) % 7;
  const firstMonday = new Date(startDate);
  firstMonday.setDate(firstMonday.getDate() - offset);
  const endDate = new Date(heatmap[heatmap.length - 1][0]);
  const todayStr = new Date().toISOString().slice(0, 10);
  const totalDays = Math.ceil((endDate - firstMonday) / 86400000) + 7;
  const weeks = Math.ceil(totalDays / 7);
  // 点阵尺寸：每个圆点 r=3, 间距 12
  const R = 3, STEP = 12, MARGIN_LEFT = 28, MARGIN_TOP = 18;
  const CELL = STEP - 3; // 方格尺寸
  const svgW = MARGIN_LEFT + weeks * STEP + 4;
  const svgH = MARGIN_TOP + 7 * STEP + 4;

  // 月份标签 SVG
  let monthsSvg = '';
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const colDate = new Date(firstMonday);
    colDate.setDate(colDate.getDate() + w * 7);
    if (colDate.getDate() <= 7 && colDate.getMonth() !== lastMonth && colDate >= firstMonday) {
      const x = MARGIN_LEFT + w * STEP + R;
      monthsSvg += `<text x="${x}" y="13" font-size="10" fill="#a3a8b8" font-weight="500">${colDate.getMonth() + 1}${t('heatmap_month_suffix')}</text>`;
      lastMonth = colDate.getMonth();
    }
  }
  // 星期标签（左侧一/三/五）
  const dayLabels = [[t('heatmap_day_mon'), 0], [t('heatmap_day_wed'), 3], [t('heatmap_day_fri'), 5]];
  let daysSvg = '';
  for (const [label, row] of dayLabels) {
    const y = MARGIN_TOP + row * STEP + R + 3;
    daysSvg += `<text x="0" y="${y}" font-size="10" fill="#a3a8b8" font-weight="500">${label}</text>`;
  }

  // 圆点
  const hc = getHeatmapColors();
  const heatmapColorLevels = [hc.noData, hc.level1, hc.level2, hc.level3, hc.level4];
  let dotsSvg = '';
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(firstMonday);
      cellDate.setDate(cellDate.getDate() + w * 7 + d);
      if (cellDate < startDate || cellDate > endDate) continue;
      const key = cellDate.toISOString().slice(0, 10);
      const v = byDate.get(key) || 0;
      const lvl = v === 0 ? 0 : Math.min(4, Math.ceil((v / maxV) * 4));
      const fill = heatmapColorLevels[lvl];
      const rx = MARGIN_LEFT + w * STEP;
      const ry = MARGIN_TOP + d * STEP;
      const isToday = key === todayStr;
      const ring = isToday ? `<rect x="${rx - 1}" y="${ry - 1}" width="${CELL + 2}" height="${CELL + 2}" rx="3" fill="none" stroke="#5b9dff" stroke-width="1.2"/>` : '';
      const dateStr = `${key} · ${v} ${t('heatmap_times')}${isToday ? ' · ' + t('heatmap_today') : ''}`;
      dotsSvg += `<rect x="${rx}" y="${ry}" width="${CELL}" height="${CELL}" rx="3" fill="${fill}" data-date="${key}" data-v="${v}" data-today="${isToday ? '1' : '0'}"><title>${dateStr}</title></rect>${ring}`;
    }
  }

  // 完整 SVG：true 点阵
  wrap.innerHTML = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="display:block;background:transparent;">
    ${monthsSvg}
    ${daysSvg}
    ${dotsSvg}
  </svg>`;
  wrap.style.minHeight = svgH + 'px';
  wrap.style.minWidth = svgW + 'px';

  // 更新副标题
  const summary = $('#overview-heatmap-summary');
  if (summary) summary.textContent = `${t("overview_heatmap_sub").split("·")[0]}· ${heatmap.filter(([_, v]) => v > 0).length}`;

  // 计算多维度统计
  const byDate2 = new Map(heatmap.map(([k, v]) => [k, v]));
  let maxV2 = 0, maxDate = '', active30 = 0, lastActive = '';
  const now = new Date();
  const cutoff30 = new Date(now); cutoff30.setDate(now.getDate() - 30);
  let currentStreak = 0, longestStreak = 0, runStreak = 0;
  // 算 streak：按日期排序连续活跃日
  const sortedDates = heatmap.filter(([_, v]) => v > 0).map(([k]) => k).sort();
  for (const d of sortedDates) {
    if (currentStreak === 0) runStreak = 1;
    else {
      const prev = new Date(currentStreak);  // 错
      runStreak++;
    }
  }
  // 简化 streak：从今天往前数连续
  for (let i = 0; i < 365; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    if ((byDate2.get(key) || 0) > 0) currentStreak++;
    else break;
  }
  // 最长连续（简版：从 heatmap 头到尾扫一遍）
  const dateSet = new Set(heatmap.filter(([_, v]) => v > 0).map(([k]) => k));
  let prevD = null, run = 0, maxRun = 0;
  for (const k of heatmap.map(([k]) => k)) {
    if (dateSet.has(k)) {
      const d = new Date(k);
      if (prevD && (d - prevD) / 86400000 === 1) run++;
      else run = 1;
      if (run > maxRun) maxRun = run;
      prevD = d;
    } else { run = 0; prevD = null; }
  }
  longestStreak = maxRun;

  for (const [k, v] of heatmap) {
    if (v > maxV2) { maxV2 = v; maxDate = k; }
    if (new Date(k) >= cutoff30 && v > 0) active30++;
    if (v > 0) lastActive = k;
  }
  const hs = (sel, v) => { const el = document.querySelector(`[data-hs="${sel}"]`); if (el) el.textContent = v; };
  hs('maxDay', maxV2 || '—');
  hs('maxDayHint', maxDate ? `${maxDate} · ${maxV2} ${t('heatmap_times_unit')}` : t('heatmap_no_data'));
  hs('active30', active30);
  hs('streak', currentStreak);
  hs('lastActive', lastActive ? lastActive.slice(5) : '—');
  hs('lastActiveHint', lastActive ? `${lastActive} · ${byDate2.get(lastActive) || 0} ${t('heatmap_times_unit')}` : '—');
  hs('totalActive', heatmap.filter(([_, v]) => v > 0).length);

  // tooltip 监听
  const tip = $('#heatmap-tooltip');
  if (tip) {
    wrap.querySelectorAll('rect[data-date]').forEach(c => {
      c.addEventListener('mouseenter', () => {
        const isToday = c.dataset.today === '1';
        tip.textContent = `${c.dataset.date} · ${c.dataset.v} ${t('heatmap_times')}${isToday ? ' · ' + t('heatmap_today') : ''}`;
        tip.hidden = false;
      });
      c.addEventListener('mousemove', (e) => {
        const card = wrap.closest('.card') || wrap;
        const r2 = card.getBoundingClientRect();
        tip.style.left = (e.clientX - r2.left + 12) + 'px';
        tip.style.top  = (e.clientY - r2.top  + 12) + 'px';
      });
      c.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }
}



let xterm = null, xtermFit = null, xtermDataOff = null, xtermExitOff = null;
async function initTerminalFromSettings() {
  // 容器存在才初始化（屏未渲染时跳过）
  if (!$('#xterm-container')) return;
  if (!xterm) {
    // 创建 xterm
    const isDark = !document.documentElement.classList.contains('theme-light');
    xterm = new Terminal({
      fontFamily: 'SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      theme: isDark ? {
        background: '#0b0d12',
        foreground: '#e6e8ec',
        cursor:     '#5b9dff',
        selectionBackground: 'rgba(91,157,255,0.35)',
        black: '#0b0d12', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#5b9dff', magenta: '#a78bfa', cyan: '#22d3ee', white: '#e6e8ec',
        brightBlack: '#6c7384', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
        brightBlue: '#93c5fd', brightMagenta: '#c4b5fd', brightCyan: '#67e8f9', brightWhite: '#ffffff',
      } : undefined,
    });
    xtermFit = new FitAddon.FitAddon();
    xterm.loadAddon(xtermFit);
    try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
    xterm.open($('#xterm-container'));
    // 用户键盘 → main shell
    xterm.onData(data => cb.terminal.write(data));
    // 接收 main 输出
    xtermDataOff = cb.terminal.onData(data => xterm.write(data));
    xtermExitOff = cb.terminal.onExit(code => xterm.write(`\r\n\x1b[33m[shell exited · code ${code}]\x1b[0m\r\n`));
    // 自适应尺寸
    queueMicrotask(() => { try { xtermFit.fit(); } catch {} });
    window.addEventListener('resize', () => { try { xtermFit.fit(); } catch {} });
  }
  // 启动 shell
  if (!xterm._started) {
    xterm._started = true;
    const r = await cb.terminal.start();
    if (r?.ok) {
      xterm.write(`\x1b[36m┌─ ${t('terminal_header')} ─────────────────────\x1b[0m\r\n`);
      xterm.write(`\x1b[36m│\x1b[0m \x1b[32m${r.shell}\x1b[0m · pid \x1b[33m${r.pid}\x1b[0m · cwd \x1b[35m${r.cwd}\x1b[0m\r\n`);
      xterm.write(`\x1b[36m│\x1b[0m TERM=\x1b[33mxterm-256color\x1b[0m · \x1b[2m${t('terminal_env_passed')}\x1b[0m\r\n`);
      xterm.write(`\x1b[36m└──────────────────────────────────────────\x1b[0m\r\n`);
    } else {
      xterm.write(`\x1b[31m${t('toast_terminal_start_failed')}${r?.err || t('unknown_error')}\x1b[0m\r\n`);
      xterm._started = false;
    }
  }
}
function renderTerminal() {
  // 第一次进入时初始化（onEnter 注入）
  if (!xterm) initTerminalFromSettings();
  else { try { xtermFit?.fit(); xterm.focus(); } catch {} }
}
// 重启 shell 按钮
$('#btn-terminal-restart')?.addEventListener('click', async () => {
  if (!xterm) return;
  await cb.terminal.close();
  xterm._started = false;
  xterm.clear();
  xterm.write('\x1b[33m' + t('toast_terminal_restarting') + '\x1b[0m\r\n');
  await initTerminalFromSettings();
});

// ============================================================
// 屏 10：导出（真保存）
// ============================================================
const exportState = { range: 'week', includes: ['projects','tokens','models','levels'], format: 'md' };
const EXPORT_RANGES = [['week','export_week'],['lastweek','export_lastweek'],['month','export_month'],['custom','export_custom']];
const EXPORT_INCLUDES = [
  ['projects','export_projects_overview', true],
  ['tokens','export_tokens_detail', true],
  ['models','export_models_dist', true],
  ['levels','export_levels_progress', true],
  ['heatmap','export_heatmap_screenshot', false],
  ['cost','export_cost_detail', false],
];
const EXPORT_FORMATS = [['md','export_md'],['html','export_html'],['json','export_json'],['txt','export_txt']];

function renderExport() {
  const d = window.__lastExportData || null;
  // 如果数据没准备好，先异步拉取再渲染
  if (!d) { ensureExportData().then(() => renderExport()); return; }
  const range = $('#export-range');
  if (range) {
    range.innerHTML = EXPORT_RANGES.map(([k,l]) => `
      <div class="radio ${k===exportState.range?'radio--active':''}" data-range="${k}">
        <div class="radio__dot"></div><div>${t(l)}</div>
      </div>
    `).join('');
    range.querySelectorAll('.radio').forEach(r => r.addEventListener('click', () => { exportState.range = r.dataset.range; renderExport(); }));
  }
  const inc = $('#export-includes');
  if (inc) {
    inc.innerHTML = EXPORT_INCLUDES.map(([k,l]) => {
      const checked = exportState.includes.includes(k);
      return `<div class="checkbox ${checked?'checkbox--active':''}" data-include="${k}"><div class="checkbox__box"></div><div>${t(l)}</div></div>`;
    }).join('');
    inc.querySelectorAll('.checkbox').forEach(c => c.addEventListener('click', () => {
      const k = c.dataset.include;
      const i = exportState.includes.indexOf(k);
      if (i >= 0) exportState.includes.splice(i, 1); else exportState.includes.push(k);
      renderExport();
    }));
  }
  const fmt = $('#export-formats');
  if (fmt) {
    fmt.innerHTML = EXPORT_FORMATS.map(([k,l]) => `
      <div class="radio ${k===exportState.format?'radio--active':''}" data-fmt="${k}">
        <div class="radio__dot"></div><div>${t(l)}</div>
      </div>
    `).join('');
    fmt.querySelectorAll('.radio').forEach(r => r.addEventListener('click', () => { exportState.format = r.dataset.fmt; renderExport(); }));
  }
  // 预览
  const preview = $('#export-preview');
  if (preview) {
    preview.innerHTML = generateMarkdown(d);
  }
}

function generateMarkdown(d) {
  if (!d) return `<div style="color:var(--text-2);text-align:center;">${t('export_loading')}</div>`;
  const md = [];
  md.push(t('export_report_title'));
  md.push(`${new Date().toISOString().slice(0,10)} · ${t('export_generated_by')} · ${t('export_data_source')}: ${d.meta?.logsPath || '—'}`);
  md.push('');
  md.push(t('export_weekly_overview'));
  (d.stats || []).forEach(s => md.push(`- **${s.label}**：${s.value} (${s.delta})`));
  md.push('');
  if (exportState.includes.includes('projects') && d.recentProjects) {
    md.push(t('export_projects'));
    d.recentProjects.forEach(p => md.push(`- **${p.name}** · \`${p.path}\` · ${p.model}`));
    md.push('');
  }
  if (exportState.includes.includes('models') && d.pieData) {
    md.push(t('export_models'));
    d.pieData.forEach(p => md.push(`- **${p.name}**：${p.value}M tokens`));
    md.push('');
  }
  if (exportState.includes.includes('tokens')) {
    md.push(t('export_tokens'));
    md.push('| ' + t('export_types') + ' | ' + t('export_usage') + ' |');
    md.push('|------|------|');
    md.push('| Input | ' + (d.stats?.[0]?.value || '—') + ' |');
    md.push('| Output | ' + (d.stats?.[1]?.value || '—') + ' |');
    md.push('');
  }
  if (exportState.includes.includes('levels')) {
    md.push(t('export_levels'));
    md.push('- ' + t('export_current_level'));
    md.push('');
  }
  if (exportState.includes.includes('cost')) {
    md.push(t('export_cost'));
    md.push('- ' + t('export_see_app'));
    md.push('');
  }
  return md.map(line => {
    if (line.startsWith('# '))  return `<h1>${esc(line.slice(2))}</h1>`;
    if (line.startsWith('## ')) return `<h2>${esc(line.slice(3))}</h2>`;
    if (line.startsWith('### '))return `<h3>${esc(line.slice(4))}</h3>`;
    if (line.startsWith('- '))  return `<div>· ${line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</div>`;
    if (line === '')            return `<div>&nbsp;</div>`;
    if (line.startsWith('|'))   return `<div>${esc(line)}</div>`;
    return `<div>${esc(line)}</div>`;
  }).join('');
}

function mdToPlain(html) {
  return html.replace(/<h1>(.*?)<\/h1>/g, '# $1')
             .replace(/<h2>(.*?)<\/h2>/g, '## $1')
             .replace(/<h3>(.*?)<\/h3>/g, '### $1')
             .replace(/<div>· (.*?)<\/div>/g, '- $1')
             .replace(/<div>&nbsp;<\/div>/g, '')
             .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
             .replace(/<[^>]+>/g, '')
             .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

$('#export-do')?.addEventListener('click', async () => {
  // 确保数据已加载
  if (!window.__lastExportData) {
    window.__lastExportData = await cb.data.getOverview();
  }
  const d = window.__lastExportData;
  if (!d) { flashToast(t('toast_data_not_ready')); return; }
  const md = mdToPlain($('#export-preview').innerHTML);
  const r = await cb.export.save({
    content: md,
    defaultName: `claude-board-${new Date().toISOString().slice(0,10)}.${exportState.format}`,
    format: exportState.format,
  });
  if (r.ok) flashToast(t('toast_export_saved') + r.path);
  else if (r.reason === 'canceled') flashToast(t('toast_export_canceled'));
  else flashToast(t('toast_export_failed') + r.reason);
});
$('#export-copy')?.addEventListener('click', async () => {
  const md = mdToPlain($('#export-preview').innerHTML);
  await cb.clipboard.write(md);
  flashToast(t('toast_copied_clipboard'));
});

// 进入 export 屏时拉最新数据
async function ensureExportData() {
  if (!window.__lastExportData) {
    window.__lastExportData = await cb.data.getOverview();
  }
}

// ============================================================
// 屏 11：空态（按钮真导航）
// ============================================================
// 空态屏的按钮在 index.html 已经是静态，这里在 onEnter 后单独绑事件
function wireEmptyStateActions() {
  const main = $('#page-empty');
  if (!main) return;
  main.querySelectorAll('.empty-state-card__action, .empty-state .btn').forEach((btn, idx) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const actions = ['onboarding', 'terminal', 'export', 'heatmap', 'overview'];
      const target = actions[idx] || 'overview';
      if (target === 'terminal') {
        // 先初始化终端
        initTerminalFromSettings().then(() => { go('terminal'); });
      } else go(target);
    };
  });
}
// 在 onEnter 末尾调用
const _origOnEnter = onEnter;
// 替换 onEnter 注入空态按钮
onEnter = function(route) {
  console.log('[onEnter]', route);
  _origOnEnter(route);
  if (route === 'empty') wireEmptyStateActions();
  if (route === 'export') ensureExportData().then(() => renderExport());
  if (route === 'terminal') {
    console.log('[onEnter] terminal path, calling init...');
    initTerminalFromSettings().then(() => {
      console.log('[onEnter] init done, renderTerminal');
      renderTerminal();
    }).catch(e => console.error('[onEnter] terminal init failed:', e));
  }
};

// ============================================================
// 屏 12：设计系统（静态文档）
// ============================================================
const DS_COLORS = [
  ['bg-0','#0b0d12'],['bg-1','#11141b'],['bg-2','#181c25'],['bg-3','#1f242f'],
  ['accent','#5b9dff'],['green','#4ade80'],['red','#f87171'],['yellow','#fbbf24'],
];
const DS_TYPES = [
  ['text-xs', 11, 'AI 使用追踪', '11px · 1.4'],
  ['text-sm', 12, '项目 / 模型 / Token', '12px · 1.5'],
  ['text-base', 13, '卡片正文 / 列表', '13px · 1.5'],
  ['text-lg', 16, '会话详情标题', '16px · 1.4'],
  ['text-xl', 20, '页面标题', '20px · 1.3'],
  ['text-2xl', 24, '2,680,000', '24px · 1.2'],
  ['text-3xl', 32, 'Lv.7', '32px · 1.0'],
];
const DS_SPACING = [4, 8, 12, 16, 20, 24, 32, 48];
const DS_RADIUS  = [['sm · 6', 6],['md · 10', 10],['lg · 14', 14],['xl · 20', 20],['full', '50%']];
const DS_ICONS = [
  ['📊','overview'],['📁','projects'],['🤖','models'],['💎','tokens'],
  ['🏆','levels'],['🔥','heatmap'],['🖥️','terminal'],['📤','export'],
  ['⚙️','settings'],['🎨','design'],['🚀','onboard'],['📭','empty'],
];

function renderDesignSystem() {
  const colors = $('#ds-colors');
  if (colors && !colors.dataset.rendered) {
    colors.innerHTML = DS_COLORS.map(([n,h]) => `
      <div class="color-swatch">
        <div class="color-swatch__block" style="background:${h}"></div>
        <div class="color-swatch__info"><div class="color-swatch__name">${n}</div><div class="color-swatch__hex">${h}</div></div>
      </div>
    `).join(''); colors.dataset.rendered = '1';
  }
  const types = $('#ds-types');
  if (types && !types.dataset.rendered) {
    types.innerHTML = DS_TYPES.map(([n,sz,sample,meta]) => `
      <div class="type-row">
        <div class="type-row__name">${n}</div>
        <div class="type-row__sample" style="font-size:${sz}px;">${esc(sample)}</div>
        <div class="type-row__meta">${meta}</div>
      </div>
    `).join(''); types.dataset.rendered = '1';
  }
  const sp = $('#ds-spacing');
  if (sp && !sp.dataset.rendered) {
    sp.innerHTML = DS_SPACING.map(v => `
      <div class="spacing-block">
        <div class="spacing-block__bar" style="height:${v}px;width:32px;"></div>
        <div class="spacing-block__label">${v}</div>
      </div>
    `).join(''); sp.dataset.rendered = '1';
  }
  const r = $('#ds-radius');
  if (r && !r.dataset.rendered) {
    r.innerHTML = DS_RADIUS.map(([l,v]) => `<div class="radius-demo" style="border-radius:${v};">${l}</div>`).join('');
    r.dataset.rendered = '1';
  }
  const c = $('#ds-components');
  if (c && !c.dataset.rendered) {
    c.innerHTML = `
      <div class="component-cell">
        <div class="component-cell__title">按钮 / Buttons</div>
        <div class="component-cell__body">
          <button class="btn btn--primary">Primary</button>
          <button class="btn">Default</button>
          <button class="btn btn--ghost">Ghost</button>
          <button class="btn btn--danger">Danger</button>
        </div>
      </div>
      <div class="component-cell">
        <div class="component-cell__title">徽章 / Badges</div>
        <div class="component-cell__body">
          <span class="badge badge--green">● Online</span>
          <span class="badge badge--red">● Error</span>
          <span class="badge badge--yellow">● Warning</span>
          <span class="badge badge--blue">● Info</span>
        </div>
      </div>
      <div class="component-cell">
        <div class="component-cell__title">开关 / Switch</div>
        <div class="component-cell__body">
          <label class="switch"><input type="checkbox" checked><span class="switch__slider"></span></label>
          <label class="switch"><input type="checkbox"><span class="switch__slider"></span></label>
        </div>
      </div>
      <div class="component-cell">
        <div class="component-cell__title">表单 / Inputs</div>
        <div class="component-cell__body" style="flex-direction:column;width:100%;">
          <input class="input" placeholder="文本输入..." />
          <select class="select"><option>下拉选择</option></select>
        </div>
      </div>
    `; c.dataset.rendered = '1';
  }
  const ic = $('#ds-icons');
  if (ic && !ic.dataset.rendered) {
    ic.innerHTML = DS_ICONS.map(([g,n]) => `<div class="icon-cell"><div class="icon-cell__glyph">${g}</div><div class="icon-cell__name">${n}</div></div>`).join('');
    ic.dataset.rendered = '1';
  }
}

// ============================================================
// Toast（真反馈）
// ============================================================
function flashToast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:var(--bg-3);color:var(--text-0);padding:8px 16px;border-radius:8px;border:1px solid var(--border-light);box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:9999;font-size:13px;opacity:0;transition:opacity 0.2s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

// ============================================================
// Bootstrap
// ============================================================
async function bootstrap() {
  console.log('[bootstrap] start');
  // 1. 拉设置
  try { State.settings = await cb.settings.get(); console.log('[bootstrap] settings OK'); }
  catch (e) { console.warn('[renderer] settings.get failed:', e.message); State.settings = { workspacePath: '~/Workspace', logsPath: '~/.claude/projects' }; }
  // 1.5 应用保存的主题
  applyTheme(State.settings?.theme || 'dark');
  // 1.6 应用保存的语言
  if (State.settings?.language) setLocale(State.settings.language);
  // 2. 应用信息
  try {
    const info = await cb.getAppInfo();
    if (info.version) {
      State.settings._version = info.version;
      State.settings._platform = info.platform;
      const v = $('#titlebar-version');
      if (v) v.textContent = `v${info.version} · 13 ${t('version_screens')}`;
      const sv = $('#settings-version');
      if (sv) sv.textContent = `v${info.version} · ${info.platform}`;
      const sv2 = $('#settings-version-2');
      if (sv2) sv2.textContent = `v${info.version}`;
    }
  } catch (e) { console.warn('[renderer] getAppInfo failed:', e.message); }
  // 3. 把 settings 路径反映到侧边栏
  if (State.settings.workspacePath) {
    const sub = State.settings.workspacePath.replace(/^~/, '~').split('/').pop();
    const brand = $('.brand__sub');
    if (brand) brand.textContent = State.settings.workspacePath;
  }
  // 4. 时钟
  tickClock(); setInterval(tickClock, 1000);
  // 5. 首启检测：未完成 onboarding → 跳转向导
  const isFirstLaunch = !State.settings.onboarded;
  if (isFirstLaunch) {
    console.log('[bootstrap] first launch → onboarding');
    go('onboarding');
  } else {
    // 正常路由（首次渲染）
    go(location.hash.slice(1) || 'overview');
  }
  // 5.5 sidebar badge 默认占位
  updateSidebarBadges({ projectCount: '—', modelCount: '—', levelStr: '—' });
  // 6. 侧边栏热力图（异步）
  refreshSidebarHeatmap().catch(e => console.warn('[renderer] heatmap failed:', e.message));
  // 7. ⭐ 主动预热数据
  if (!isFirstLaunch) {
    try {
      const d = await cb.data.rescan();
      console.log('[bootstrap] rescan OK, meta:', d?.meta);
      const r = State.currentRoute;
      if (r === 'overview') await renderOverview();
      else if (r === 'projects') await renderProjects();
      else if (r === 'heatmap') await renderHeatmap90d();
      updateSidebarBadges({
        projectCount: (d?.recentProjects || []).length,
        modelCount:    (d?.pieData || []).length,
        levelStr:      d?.levels?.current ? `${d.levels.current.lv}/99` : null,
      });
    } catch (e) {
      console.warn('[bootstrap] rescan failed:', e.message);
    }
  }
  // 8. 自动定时扫描（根据 scanInterval 设置）
  startAutoScan();
  // 9. 监听更新事件
  cb.updater.onAvailable((info) => {
    flashToast(t('update_available') + ' v' + info.version);
  });
  cb.updater.onProgress((p) => {
    if (p.percent > 0) flashToast(t('toast_download_progress') + p.percent.toFixed(0) + '%');
  });
  cb.updater.onDownloaded((info) => {
    alertModal({ title: t('update_ready'), message: `v${info.version} ${t('update_ready')}`, confirmLabel: t('update_install') }).then(() => {
      cb.updater.install();
    });
  });
  cb.updater.onError((msg) => {
    flashToast(t('toast_update_error') + msg);
  });
}

bootstrap().catch((err) => {
  console.error('[renderer] bootstrap failed:', err);
  try { go('overview'); } catch {}
});
