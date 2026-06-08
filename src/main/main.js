// src/main/main.js — Electron 主进程入口
// v0.1 真实化：scanner + settings 持久化 + native dialogs + 终端执行 + 导出保存
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');
const { spawn } = require('node:child_process');
const { scan, expandHome } = require('./scanner');
const profiles = require('./profile-manager');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;
let mainWindow = null;
let tray = null; // 系统托盘
const scannerCache = { ts: 0, data: null }; // 30s 缓存避免每次都扫盘

// ====== 单实例锁（禁止多开）======
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ====== Settings 持久化 ======
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const MODEL_PRICES_FILE = path.join(app.getPath('userData'), 'model-prices.json');
// 用户用过的所有模型 + 各自价格（动态自学习，scanner 扫到新 model 自动追加）
let modelPrices = {};
function loadModelPrices() {
  try { modelPrices = JSON.parse(fs.readFileSync(MODEL_PRICES_FILE, 'utf-8')); }
  catch { modelPrices = {}; }
}
loadModelPrices();  // 必须在 let modelPrices 声明之后调用（避免 TDZ）
function saveModelPrices() {
  try {
    fs.mkdirSync(path.dirname(MODEL_PRICES_FILE), { recursive: true });
    fs.writeFileSync(MODEL_PRICES_FILE, JSON.stringify(modelPrices, null, 2), 'utf-8');
  } catch (e) { console.error('[main] saveModelPrices failed:', e); }
}
// 合并新扫描到的模型（增量追加）
function mergeDiscoveredModels(discovered) {
  let changed = false;
  for (const name of discovered) {
    if (!modelPrices[name]) {
      modelPrices[name] = { in: 0, out: 0, cw: 0, cr: 0, addedAt: new Date().toISOString(), auto: true };
      changed = true;
    }
  }
  if (changed) saveModelPrices();
}
// ====== 终端检测 ======
// macOS: iTerm2 → Terminal.app
// Windows: Windows Terminal → PowerShell → CMD
// Linux: gnome-terminal → konsole → x-terminal-emulator
const TERMINAL_DEFINITIONS = {
  darwin: [
    { id: 'iterm2',     label: 'iTerm2',         appPaths: ['/Applications/iTerm.app'],       osascriptApp: 'iTerm' },
    { id: 'terminal',   label: 'Terminal.app',    appPaths: ['/Applications/Utilities/Terminal.app', '/System/Applications/Utilities/Terminal.app'], osascriptApp: 'Terminal' },
  ],
  win32: [
    { id: 'wt',         label: 'Windows Terminal',  testCmd: 'wt.exe',  testArgs: ['--version'] },
    { id: 'powershell', label: 'PowerShell',         testCmd: 'powershell.exe', testArgs: ['-Command', 'echo ok'] },
    { id: 'cmd',        label: 'CMD',                testCmd: 'cmd.exe',  testArgs: ['/c', 'echo ok'] },
  ],
  linux: [
    { id: 'gnome-terminal', label: 'GNOME Terminal' },
    { id: 'konsole',        label: 'Konsole' },
    { id: 'x-terminal-emulator', label: 'X Terminal' },
  ],
};
let _detectedTerminals = null; // 内存缓存

async function detectAvailableTerminals() {
  if (_detectedTerminals) return _detectedTerminals;
  const platform = process.platform;
  const defs = TERMINAL_DEFINITIONS[platform] || [];
  const found = [];

  for (const def of defs) {
    let available = false;
    if (platform === 'darwin') {
      // macOS: 检查多个可能路径（/Applications 和 /System/Applications）
      const paths = def.appPaths || [def.appPath];
      available = paths.some(p => fs.existsSync(p));
    } else if (platform === 'win32') {
      // Windows: 尝试 spawn --version（shell: true 让 spawn 使用 PATH 查找 exe）
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(def.testCmd, def.testArgs, { timeout: 5000, stdio: 'ignore', shell: true });
          child.on('error', reject);
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error('non-zero')));
        });
        available = true;
      } catch {}
    } else {
      // Linux: which 命令检测
      try {
        await new Promise((resolve, reject) => {
          const child = spawn('which', [def.id], { timeout: 3000, stdio: 'ignore' });
          child.on('error', reject);
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error('not found')));
        });
        available = true;
      } catch {}
    }
    if (available) {
      found.push({ id: def.id, label: def.label, osascriptApp: def.osascriptApp });
    }
  }

  _detectedTerminals = found;
  console.log('[main] terminal detection:', found.map(t => t.label).join(', ') || 'none');
  return found;
}

// 根据配置的 preferredTerminal 和检测到的终端列表，获取实际使用的终端信息
async function resolveTerminal() {
  const s = readSettings();
  const detected = await detectAvailableTerminals();
  const pref = s.preferredTerminal || 'auto';

  if (pref === 'auto' || pref === '') {
    // auto 模式：取检测到的第一个（已按优先级排序）
    return detected[0] || null;
  }
  // 用户指定了具体终端，从检测列表里找
  return detected.find(t => t.id === pref) || detected[0] || null;
}

// 用指定终端启动命令
function launchInTerminal(termInfo, cmd, projPath) {
  const platform = process.platform;
  const termId = termInfo?.id || 'unknown';

  if (platform === 'darwin') {
    const appName = termInfo?.osascriptApp || 'Terminal';
    if (termId === 'iterm2') {
      // iTerm2: 用 osascript 打开新窗口并执行命令
      const script = `
        tell application "iTerm"
          activate
          create window with default profile
          tell current session of current window
            write text "${cmd.replace(/"/g, '\\"')}"
          end tell
        end tell`;
      const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      // Terminal.app（默认）
      const script = `tell application "${appName}" to do script ${JSON.stringify(cmd)}`;
      const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } else if (platform === 'win32') {
    // Windows: 用 npm global bin 路径确保 claude 可找到
    const npmGlobalBin = path.join(app.getPath('appData'), 'npm');
    const winEnv = { ...process.env, PATH: `${npmGlobalBin};${process.env.PATH || ''}` };

    if (termId === 'wt') {
      // Windows Terminal: 打开新 tab 并执行命令
      const child = spawn('wt.exe', ['new-tab', 'cmd', '/k', `${cmd}`], { detached: true, stdio: 'ignore', shell: true, env: winEnv });
      child.unref();
    } else if (termId === 'powershell') {
      // PowerShell: -NoExit 保持窗口
      const psCmd = `Set-Location -Path '${projPath || ''}'; claude`;
      const child = spawn('powershell.exe', ['-NoExit', '-Command', psCmd], { detached: true, stdio: 'ignore', shell: true, env: winEnv });
      child.unref();
    } else {
      // CMD（默认）：start "" 打开新窗口，cmd /k 保持窗口打开执行命令
      // 整个命令用引号包裹，防止 && 被外层 cmd 解析
      const child = spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', `${cmd}`], { detached: true, stdio: 'ignore', shell: true, env: winEnv });
      child.unref();
    }
  } else {
    // Linux
    const termBin = termId || 'gnome-terminal';
    const argsMap = {
      'gnome-terminal': ['--', 'sh', '-c', cmd],
      'konsole': ['-e', 'sh', '-c', cmd],
      'x-terminal-emulator': ['-e', 'sh', '-c', cmd],
    };
    const args = argsMap[termBin] || ['-e', 'sh', '-c', cmd];
    const child = spawn(termBin, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

const DEFAULT_SETTINGS = {
  workspacePath: '~/Workspace',
  logsPath:      '~/.claude/projects',
  autoLaunch:    true,
  minimizeTray:  false,
  scanInterval:  '15min',
  language:      'zh-CN',
  onboarded:     false,
  windowBounds:  null,
  configuredProjects: [],   // 用户手动配置的项目（scanner 只读这份列表）
  preferredTerminal: 'auto', // 启动终端偏好：'auto' | 具体终端 id（如 iterm2 / terminal / wt / powershell / cmd）
  theme: 'dark',              // 'dark' | 'light' | 'auto'
  detectedTerminals: [],    // 首次启动检测到的可用终端列表（缓存，避免重复检测）
};
function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), ...s }, null, 2));
    return true;
  } catch (e) { console.error('[main] writeSettings failed:', e); return false; }
}

// ====== 数据扫描（带缓存）======
async function getScan(force = false) {
  const now = Date.now();
  if (!force && scannerCache.data && (now - scannerCache.ts) < 30_000) return scannerCache.data;
  const s = readSettings();
  const data = await scan({
    logsPath: s.logsPath,
    workspacePath: s.workspacePath,
    configuredProjects: s.configuredProjects || [],
    modelPrices,
  });
  // 扫到新 model → 增量持久化
  if (data?.models?.prices) {
    const names = data.models.prices.map(p => p.name);
    mergeDiscoveredModels(names);
  }
  scannerCache.ts = now;
  scannerCache.data = data;
  return data;
}

// ====== 窗口 ======
function createMainWindow() {
  const settings = readSettings();
  const bounds = settings.windowBounds || { width: 1280, height: 800 };
  mainWindow = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    minWidth: 1280, minHeight: 800,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Claude Board',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      devTools: isDev,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
    console.log('[main] window ready');
    if (process.env.SMOKE_TEST === '1') runSmokeTest();
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer:${level}] ${source}:${line} ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] RENDERER CRASHED:', details);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[main] did-fail-load:', code, desc, url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // 记忆窗口位置
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    writeSettings({ windowBounds: b });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move',   saveBounds);
  // 关闭窗口时：如果 minimizeTray 开启，隐藏到托盘而非退出
  mainWindow.on('close', (e) => {
    const s = readSettings();
    if (s.minimizeTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ====== 系统托盘 ======
function createTray() {
  try {
    // 托盘图标路径（src/renderer/ 在打包文件列表内）
    const iconPath = path.join(__dirname, '../renderer/tray-icon.png');
    let trayIcon = nativeImage.createFromPath(iconPath);

    if (trayIcon.isEmpty()) {
      console.error('[tray] icon is empty, path:', iconPath);
      // 回退：用 app 的 icon
      trayIcon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'));
    }

    if (process.platform === 'darwin') {
      // macOS: 必须设为 Template Image 才能在菜单栏正确显示（自动适配深色/浅色模式）
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
      trayIcon.setTemplateImage(true);
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Claude Board — AI 使用追踪');

    const contextMenu = Menu.buildFromTemplate([
      { label: '打开 Claude Board', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '刷新数据', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tray:refresh'); } },
      { type: 'separator' },
      { label: '设置', click: () => { showMainWindow(); mainWindow?.webContents.executeJavaScript(`go('settings')`).catch(() => {}); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);

    tray.on('click', () => showMainWindow());
    console.log('[tray] created, platform:', process.platform);
  } catch (e) {
    console.error('[tray] createTray failed:', e.message);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  mainWindow.show();
  mainWindow.focus();
}

// ====== IPC 通道 ======
// App info
ipcMain.handle('app:get-version',  () => app.getVersion());
ipcMain.handle('app:get-platform', () => process.platform);
ipcMain.handle('app:get-paths',    () => ({
  home: app.getPath('home'), appData: app.getPath('appData'),
  userData: app.getPath('userData'), cwd: process.cwd(),
}));

// Window control
ipcMain.handle('window:minimize',        () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
  mainWindow.maximize(); return true;
});
ipcMain.handle('window:close',      () => mainWindow?.close());
ipcMain.handle('window:is-maximized',() => mainWindow?.isMaximized() ?? false);

// Settings
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const ok = writeSettings(patch);
  // 路径变了要清缓存
  if (patch.logsPath || patch.workspacePath || patch.configuredProjects) { scannerCache.ts = 0; scannerCache.data = null; }
  return ok;
});
ipcMain.handle('settings:reset', () => {
  try { fs.unlinkSync(SETTINGS_FILE); return true; } catch { return false; }
});

// Projects（手动配置的项目，scanner 只读这份列表）
ipcMain.handle('projects:list', () => {
  const s = readSettings();
  return s.configuredProjects || [];
});
ipcMain.handle('projects:add', (_e, { name, path: p }) => {
  if (!p) return { ok: false, reason: 'path-required' };
  const abs = p.startsWith('~') ? expandHome(p) : p;
  if (!fs.existsSync(abs)) return { ok: false, reason: 'path-not-exist' };
  const s = readSettings();
  const list = s.configuredProjects || [];
  if (list.find(x => x.path === abs)) return { ok: false, reason: 'duplicate' };
  const project = {
    id: 'p_' + Date.now().toString(36),
    name: (name || abs.split('/').pop() || 'project').slice(0, 64),
    path: abs,
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };
  const next = [...list, project];
  writeSettings({ configuredProjects: next });
  scannerCache.ts = 0; scannerCache.data = null;
  return { ok: true, project };
});
ipcMain.handle('projects:remove', (_e, id) => {
  const s = readSettings();
  const list = s.configuredProjects || [];
  const next = list.filter(p => p.id !== id);
  writeSettings({ configuredProjects: next });
  scannerCache.ts = 0; scannerCache.data = null;
  return { ok: true, count: next.length };
});
ipcMain.handle('projects:touch', (_e, id) => {
  const s = readSettings();
  const list = s.configuredProjects || [];
  const next = list.map(p => p.id === id ? { ...p, lastOpenedAt: new Date().toISOString() } : p);
  writeSettings({ configuredProjects: next });
  scannerCache.ts = 0; scannerCache.data = null;
  return { ok: true };
});
// 启动 Claude：在系统终端中执行 `cd <path> && claude`
// 模型价格管理
ipcMain.handle('models:list-prices', () => modelPrices);
ipcMain.handle('models:update-price', (_e, { name, price }) => {
  if (!name) return { ok: false, reason: 'name-required' };
  modelPrices[name] = {
    in: +price.in || 0, out: +price.out || 0, cw: +price.cw || 0, cr: +price.cr || 0,
    addedAt: modelPrices[name]?.addedAt || new Date().toISOString(), auto: false,
  };
  saveModelPrices();
  scannerCache.ts = 0; scannerCache.data = null;
  return { ok: true, price: modelPrices[name] };
});
ipcMain.handle('models:delete-price', (_e, name) => {
  delete modelPrices[name];
  saveModelPrices();
  scannerCache.ts = 0; scannerCache.data = null;
  return { ok: true };
});

// 配置组管理（从 model_helper 融合）
ipcMain.handle('profiles:list',    () => profiles.list());
ipcMain.handle('profiles:get',     (_e, name) => profiles.get(name));
ipcMain.handle('profiles:add',     (_e, p) => profiles.add(p));
ipcMain.handle('profiles:update',  (_e, name, patch) => profiles.update(name, patch));
ipcMain.handle('profiles:delete',  (_e, name) => profiles.remove(name));
ipcMain.handle('profiles:switch',  (_e, name) => profiles.switchTo(name));
ipcMain.handle('profiles:current', () => profiles.current());
ipcMain.handle('profiles:env-fields', () => profiles.getEnvFields());

// 终端检测
ipcMain.handle('terminal:detect', async () => {
  const terminals = await detectAvailableTerminals();
  // 持久化到 settings（方便下次直接读取）
  writeSettings({ detectedTerminals: terminals });
  return terminals;
});
ipcMain.handle('terminal:list-available', async () => {
  // 优先用内存缓存，其次用 settings 缓存，最后实时检测
  if (_detectedTerminals && _detectedTerminals.length > 0) return _detectedTerminals;
  const s = readSettings();
  if (s.detectedTerminals && s.detectedTerminals.length > 0) {
    _detectedTerminals = s.detectedTerminals;
    return _detectedTerminals;
  }
  return await detectAvailableTerminals();
});
ipcMain.handle('projects:launch', async (_e, id) => {
  const s = readSettings();
  const proj = (s.configuredProjects || []).find(p => p.id === id);
  if (!proj) return { ok: false, reason: 'project-not-found' };
  // 更新 lastOpenedAt
  const next = (s.configuredProjects || []).map(p => p.id === id ? { ...p, lastOpenedAt: new Date().toISOString() } : p);
  writeSettings({ configuredProjects: next });
  scannerCache.ts = 0; scannerCache.data = null;
  const cmd = `cd ${JSON.stringify(proj.path)} && claude`;
  try {
    const termInfo = await resolveTerminal();
    if (!termInfo) return { ok: false, reason: 'no-terminal-found' };
    launchInTerminal(termInfo, cmd, proj.path);
    return { ok: true, platform: process.platform, path: proj.path, cmd, terminal: termInfo.id, terminalLabel: termInfo.label };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// Dialogs
ipcMain.handle('dialog:open-directory', async (_e, opts = {}) => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: opts.title || '选择目录',
    defaultPath: opts.defaultPath ? expandHome(opts.defaultPath) : app.getPath('home'),
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:open-file', async (_e, opts = {}) => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: opts.title || '选择文件',
    defaultPath: app.getPath('home'),
    filters: opts.filters || [],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save-file', async (_e, opts = {}) => {
  if (!mainWindow) return null;
  const r = await dialog.showSaveDialog(mainWindow, {
    title: opts.title || '保存',
    defaultPath: opts.defaultPath,
    filters: opts.filters || [{ name: 'Markdown', extensions: ['md'] }],
  });
  return r.canceled ? null : r.filePath;
});

// Data (全部走 scanner)
ipcMain.handle('data:get-overview', async (_e, force) => {
  const d = await getScan(force);
  return d && {
    stats: d.stats, trendDays: d.trendDays, trendData: d.trendData,
    pieData: d.pieData, recentProjects: d.recentProjects, recentActivities: d.recentActivities,
    meta: d.meta,
    // 关键字段：热力图、模型、token、项目——之前漏了导致热力图显示"暂无数据"
    heatmap: d.heatmap, heatmap90dStats: d.heatmap90dStats, levels: d.levels,
    projects: d.projects, models: d.models, tokens: d.tokens,
  };
});
ipcMain.handle('data:get-projects', async () => {
  const d = await getScan();
  return d && d.projects;
});
ipcMain.handle('data:get-models', async () => {
  const d = await getScan();
  return d && d.models;
});
ipcMain.handle('data:get-tokens', async () => {
  const d = await getScan();
  return d && d.tokens;
});
ipcMain.handle('data:get-heatmap-90d', async () => {
  const d = await getScan();
  return d && { heatmap: d.heatmap, stats: d.heatmap90dStats };
});
ipcMain.handle('data:get-levels', async () => {
  const d = await getScan();
  return d && d.levels;
});
ipcMain.handle('data:get-meta', async () => {
  const d = await getScan();
  return d && d.meta;
});
ipcMain.handle('data:rescan', async () => {
  scannerCache.ts = 0; scannerCache.data = null;
  return getScan(true);
});
ipcMain.handle('data:clear-cache', () => {
  scannerCache.ts = 0; scannerCache.data = null;
  return true;
});

// Terminal：多 shell tab 持续会话（xterm.js + pipe 模式，env 全量透传）
// tabId → { proc, sendData }
const shellProcs = new Map();
ipcMain.handle('terminal:start', (event, opts = {}) => {
  const tabId = opts.tabId || 'default';
  // 如果该 tab 已有 shell，先杀掉
  const old = shellProcs.get(tabId);
  if (old) { try { old.proc.kill(); } catch {} shellProcs.delete(tabId); }
  const shellBin = process.env.SHELL || '/bin/zsh';
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };
  const proc = spawn(shellBin, ['-i'], {
    cwd: opts.cwd || process.env.HOME || process.cwd(),
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // 重要：发数据时必须发到创建这个 shell 的那个 webContents（多 tab 时各 tab 各自的 sender）
  const sender = event.sender;
  const channel = `terminal:data:${tabId}`;
  const exitChannel = `terminal:exit:${tabId}`;
  const sendData = (chunk) => { try { sender.send(channel, chunk.toString('utf-8')); } catch {} };
  proc.stdout.on('data', sendData);
  proc.stderr.on('data', sendData);
  try { proc.stdin.write(' '); } catch {}
  proc.on('close', (code) => {
    try { sender.send(exitChannel, code ?? -1); } catch {}
    shellProcs.delete(tabId);
  });
  proc.on('error', (e) => {
    try { sender.send(channel, `\r\n\x1b[31m[spawn error] ${e.message}\x1b[0m\r\n`); } catch {}
  });
  shellProcs.set(tabId, { proc, sender });
  return { ok: true, pid: proc.pid, tabId, shell: shellBin, cwd: proc.spawnargs?.[2]?.cwd || env.HOME };
});
ipcMain.handle('terminal:write', (_e, { tabId, data } = {}) => {
  const id = tabId || 'default';
  const entry = shellProcs.get(id);
  if (entry?.proc?.stdin?.writable) {
    try { entry.proc.stdin.write(data); } catch {}
  }
  return true;
});
ipcMain.handle('terminal:close', (_e, opts = {}) => {
  const id = opts.tabId || 'default';
  const entry = shellProcs.get(id);
  if (entry) { try { entry.proc.kill(); } catch {} shellProcs.delete(id); }
  return true;
});
ipcMain.handle('terminal:close-all', () => {
  for (const [id, entry] of shellProcs) { try { entry.proc.kill(); } catch {} }
  shellProcs.clear();
  return true;
});

// Export save
ipcMain.handle('export:save', async (_e, { content, defaultName, format }) => {
  if (!mainWindow) return { ok: false, reason: 'no-window' };
  const filters = {
    md:   [{ name: 'Markdown', extensions: ['md'] }],
    html: [{ name: 'HTML',     extensions: ['html'] }],
    json: [{ name: 'JSON',     extensions: ['json'] }],
    txt:  [{ name: 'Text',     extensions: ['txt'] }],
  }[format || 'md'] || [];
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '导出报告',
    defaultPath: defaultName || 'claude-board-report.md',
    filters,
  });
  if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
  try { await fs.promises.writeFile(r.filePath, content, 'utf-8'); }
  catch (e) { return { ok: false, reason: e.message }; }
  return { ok: true, path: r.filePath };
});

// Confirm (替代 sandbox 下不可用的 window.confirm)
ipcMain.handle('dialog:confirm', async (_e, { message, title, detail, confirmLabel, cancelLabel } = {}) => {
  if (!mainWindow) return false;
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: [confirmLabel || '确定', cancelLabel || '取消'],
    defaultId: 0,
    cancelId: 1,
    title: title || '确认',
    message: message || '确定继续？',
    detail: detail || '',
    noLink: true,
  });
  return r.response === 0;
});

// Clipboard
ipcMain.handle('clipboard:write', (_e, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text || '');
  return true;
});

// Open path in Finder / shell
ipcMain.handle('shell:open-path', (_e, p) => {
  if (!p) return false;
  return shell.openPath(expandHome(p));
});

// ====== SMOKE_TEST：自动跑 12 屏并收集 console error ======
async function runSmokeTest() {
  const fsx = require('node:fs');
  const report = { ts: new Date().toISOString(), routes: [], errors: [], ipcFails: [], xtermProbe: null, shellProbe: null };
  const ROUTES = ['overview','projects','models','tokens','levels','heatmap','onboarding','settings','terminal','export','design-system','empty'];
  // 1) 进入 terminal 屏 → 等 xterm 初始化 + shell 启动
  await new Promise(r => setTimeout(r, 1500));
  await mainWindow.webContents.executeJavaScript(`go('terminal')`);
  await new Promise(r => setTimeout(r, 1500));
  // 2) 探测 xterm 状态
  try {
    report.xtermProbe = await mainWindow.webContents.executeJavaScript(`(()=>{
      const has = (k) => typeof window[k] !== 'undefined';
      return {
        Terminal: has('Terminal'),
        FitAddon: has('FitAddon'),
        WebLinksAddon: has('WebLinksAddon'),
        xtermInst: typeof xterm !== 'undefined' ? { cols: xterm.cols, rows: xterm.rows, hasBuffer: !!xterm.buffer } : null,
        containerExists: !!document.getElementById('xterm-container'),
        containerChildren: document.getElementById('xterm-container')?.children?.length || 0,
      };
    })()`);
    // 等 3s 看 shell 是否还活着
    await new Promise(r => setTimeout(r, 3000));
    const stillAlive = await mainWindow.webContents.executeJavaScript(`(()=>{
      try {
        const lines = [];
        for (let i = 0; i < Math.min(5, xterm.rows); i++) {
          const l = xterm.buffer.active.getLine(i);
          if (l) lines.push(l.translateToString(true).trim());
        }
        return lines.filter(Boolean);
      } catch (e) { return ['err: ' + e.message]; }
    })()`).catch(e => ['catch: ' + e.message]);
    report.shellStillAliveAfter3s = stillAlive;
  } catch (e) { report.xtermProbe = { err: e.message }; }
  // 单独探测首页热力图数据（隔离 xterm 错误）
  try {
    report.heatAndOverview = await mainWindow.webContents.executeJavaScript(`(async () => {
      try {
        const d = await cb.data.getOverview();
        return {
          keys: d ? Object.keys(d).slice(0, 20) : null,
          heatmapLen: d?.heatmap?.length || 0,
          heatmapNonZero: d?.heatmap?.filter(([_,v]) => v > 0).map(([k,v]) => k + '→' + v) || [],
          recentProjectsLen: d?.recentProjects?.length || 0,
          meta: d?.meta || null,
        };
      } catch (e) { return { err: e.message }; }
    })()`);
  } catch (e) { report.heatAndOverview = { err: e.message }; }
  try {
    report.xtermProbe = await mainWindow.webContents.executeJavaScript(`(()=>{
      const has = (k) => typeof window[k] !== 'undefined';
      return {
        Terminal: has('Terminal'),
        FitAddon: has('FitAddon'),
        WebLinksAddon: has('WebLinksAddon'),
        xtermInst: typeof xterm !== 'undefined' ? { cols: xterm.cols, rows: xterm.rows, hasBuffer: !!xterm.buffer } : null,
        containerExists: !!document.getElementById('xterm-container'),
        containerChildren: document.getElementById('xterm-container')?.children?.length || 0,
      };
    })()`);
    // 等 3s 看 shell 是否还活着
    await new Promise(r => setTimeout(r, 3000));
    const stillAlive = await mainWindow.webContents.executeJavaScript(`(()=>{
      const lines = [];
      for (let i = 0; i < Math.min(5, xterm.rows); i++) {
        const l = xterm.buffer.active.getLine(i);
        if (l) { const t = l.translateToString(true).trim(); if (t) lines.push(t); }
      }
      return lines.filter(Boolean);
    })()`);
    report.shellStillAliveAfter3s = stillAlive;
    // 探测首页热力图渲染情况
    report.heatmapProbe = await mainWindow.webContents.executeJavaScript(`(()=>{
      const grid = document.getElementById('heatmap-grid');
      if (!grid) return { err: 'no #heatmap-grid' };
      const cells = grid.querySelectorAll('.heatmap-cell');
      const visible = Array.from(cells).filter(c => c.style.display !== 'none' && getComputedStyle(c).display !== 'none');
      return {
        gridFound: true,
        cellsTotal: cells.length,
        cellsVisible: visible.length,
        gridStyle: grid.getAttribute('style') || '(no inline style)',
        gridRect: (() => { const r = grid.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.left, y: r.top }; })(),
        gridParent: (() => { const p = grid.parentElement; return p ? p.tagName + '.' + p.className : 'none'; })(),
        firstFewCells: Array.from(cells).slice(0, 5).map(c => ({ cls: c.className, date: c.dataset.date, count: c.dataset.count })),
        scrollContainer: (() => { const s = grid.closest('.heatmap-graph__scroll'); return s ? { scrollW: s.scrollWidth, clientW: s.clientWidth } : null; })(),
      };
    })()`);
  } catch (e) { report.xtermProbe = { err: e.message }; }
  try {
    report.xtermProbe = await mainWindow.webContents.executeJavaScript(`(()=>{
      const has = (k) => typeof window[k] !== 'undefined';
      return {
        Terminal: has('Terminal'),
        FitAddon: has('FitAddon'),
        WebLinksAddon: has('WebLinksAddon'),
        xtermInst: typeof xterm !== 'undefined' ? { cols: xterm.cols, rows: xterm.rows, hasBuffer: !!xterm.buffer } : null,
        containerExists: !!document.getElementById('xterm-container'),
        containerChildren: document.getElementById('xterm-container')?.children?.length || 0,
      };
    })()`);
    // 等 3s 看 shell 是否还活着
    await new Promise(r => setTimeout(r, 3000));
    const stillAlive = await mainWindow.webContents.executeJavaScript(`(()=>{
      const lines = [];
      for (let i = 0; i < Math.min(5, xterm.rows); i++) {
        const l = xterm.buffer.active.getLine(i);
        if (l) { const t = l.translateToString(true).trim(); if (t) lines.push(t); }
      }
      return lines.filter(Boolean);
    })()`);
    report.shellStillAliveAfter3s = stillAlive;
  } catch (e) { report.xtermProbe = { err: e.message }; }
  // 3) 跑真 shell 命令 + 读 xterm buffer
  try {
    await mainWindow.webContents.executeJavaScript(`cb.terminal.write('echo "SMOKE_OK_\\$\\$(date +%s)"; cd ~; pwd; ls -la 2>&1 | head -5; env | grep -E "^HOME=|^USER=|^PATH=" | head -3\\n')`);
    await new Promise(r => setTimeout(r, 1500));
    report.shellProbe = await mainWindow.webContents.executeJavaScript(`(()=>{
      const txt = xterm.buffer.active ? xterm.buffer.active.getLine(0)?.translateToString(true) : '';
      const lines = [];
      for (let i = 0; i < Math.min(20, xterm.rows); i++) {
        const l = xterm.buffer.active.getLine(i);
        if (l) lines.push(l.translateToString(true));
      }
      return { firstLine: txt, last20: lines.join('\\n') };
    })()`);
  } catch (e) { report.shellProbe = { err: e.message }; }
  // 4) 跑其他 12 屏
  for (const route of ROUTES) {
    const t0 = Date.now();
    try {
      await mainWindow.webContents.executeJavaScript(`go('${route}')`);
      await new Promise(r => setTimeout(r, 600));
      const probe = await mainWindow.webContents.executeJavaScript(`(()=>({
        currentRoute: State.currentRoute,
        hasError: !!document.querySelector('.error-state, [data-error]'),
        bodyLen: (document.body.innerText||'').length,
        title: document.title,
      }))()`);
      report.routes.push({ route, ms: Date.now()-t0, ok: probe.currentRoute === route, ...probe });
    } catch (e) { report.errors.push({ route, err: e.message }); }
  }
  // IPC smoke: 触发 27 个 handler 一次（用 renderer 端 cb 对象）
  const IPC_TESTS = `
    (async () => {
      const results = [];
      const tests = [
        ['app:get-version',  () => cb.getAppInfo()],
        ['app:get-platform', () => cb.getAppInfo()],
        ['app:get-paths',    () => cb.getPaths()],
        ['settings:get',     () => cb.settings.get()],
        ['data:get-overview',() => cb.data.getOverview()],
        ['data:get-projects',() => cb.data.getProjects()],
        ['data:get-models',  () => cb.data.getModels()],
        ['data:get-tokens',  () => cb.data.getTokens()],
        ['data:get-levels',  () => cb.data.getLevels()],
        ['data:get-meta',    () => cb.data.getMeta()],
        ['data:get-heatmap-90d',() => cb.data.getHeatmap90d()],
        ['data:rescan',      () => cb.data.rescan()],
        ['data:clear-cache', () => cb.data.clearCache()],
        ['terminal:start',   () => cb.terminal.start()],  // 真启动 zsh 看是否成功
        ['terminal:write',   () => cb.terminal.write('echo ok\\n')],  // 触发真 shell exec
        ['terminal:close',   () => cb.terminal.close()],
        ['export:save',      () => null],  // 需要 UI 触发，跳过
        ['clipboard:write',  () => cb.clipboard.write('test')],
        ['shell:open-path',  () => null],  // 跳过
        ['window:is-maximized',() => null],  // 跳过
        ['dialog:confirm',   () => null],  // 跳过
      ];
      for (const [name, fn] of tests) {
        if (!fn) { results.push({ name, skip: true }); continue; }
        try { const r = await fn(); results.push({ name, ok: true, hasResult: r != null }); }
        catch (e) { results.push({ name, ok: false, err: String(e.message||e) }); }
      }
      return results;
    })()
  `;
  try {
    report.ipcResults = await mainWindow.webContents.executeJavaScript(IPC_TESTS);
  } catch (e) {
    report.ipcFails.push({ err: e.message });
  }
  const out = '/tmp/claude-board-smoke.json';
  fsx.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('=== SMOKE REPORT written to', out, '===');
  console.log('routes ok:', report.routes.filter(r=>r.ok).length, '/', report.routes.length);
  console.log('errors:', report.errors.length, 'ipcFails:', report.ipcFails.length);
  app.quit();
}

// ====== 菜单 ======
app.whenReady().then(async () => {
  // 首次启动：检测系统可用终端并缓存到 settings
  try {
    const s = readSettings();
    if (!s.detectedTerminals || s.detectedTerminals.length === 0) {
      const terminals = await detectAvailableTerminals();
      writeSettings({ detectedTerminals: terminals });
      console.log('[main] first-launch terminal detection saved:', terminals.map(t => t.id).join(', '));
    } else {
      // 已有缓存，填充到内存
      _detectedTerminals = s.detectedTerminals;
      console.log('[main] terminal cache loaded:', s.detectedTerminals.map(t => t.id).join(', '));
    }
  } catch (e) {
    console.warn('[main] terminal detection failed:', e.message);
  }

  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [{ role: 'quit', label: '退出' }] },
      { label: 'View', submenu: [{ role: 'reload', label: '刷新' }, { role: 'toggleDevTools', label: '开发者工具' }] },
    ]));
  }
  createMainWindow();
  createTray(); // 创建系统托盘图标

  // 第二个实例启动时：聚焦已有的主窗口
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

// 退出标记，让 close 事件知道是真的要退出
app.on('before-quit', () => { app.isQuitting = true; });

app.on('window-all-closed', () => {
  // 如果有托盘，不退出（macOS 行为也靠托盘保活）
  if (tray && !tray.isDestroyed()) return;
  if (process.platform !== 'darwin') app.quit();
});
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const u = new URL(navigationUrl);
    if (u.origin !== 'null') { event.preventDefault(); shell.openExternal(navigationUrl); }
  });
});

// ====== Auto-Updater（electron-updater + GitHub Releases）======
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = console;

let updateInfo = null; // 缓存检测到的新版本信息

autoUpdater.on('update-available', (info) => {
  updateInfo = info;
  console.log('[updater] update available:', info.version);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes?.slice?.(0, 500) || '',
    });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[updater] up to date');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:not-available');
  }
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`[updater] downloading ${progress.percent.toFixed(1)}%`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      speed: progress.bytesPerSecond,
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[updater] downloaded, ready to install');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:downloaded', { version: info.version });
  }
});

autoUpdater.on('error', (err) => {
  console.error('[updater] error:', err.message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:error', err.message);
  }
});

// Update IPC
ipcMain.handle('update:check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, currentVersion: app.getVersion(), latestVersion: result?.updateInfo?.version || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('update:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('update:install', () => {
  // 退出并安装
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});
