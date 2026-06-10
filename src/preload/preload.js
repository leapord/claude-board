// src/preload/preload.js — 安全的桥接层
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeBoard', {
  // 应用信息
  getAppInfo: async () => ({
    version: await ipcRenderer.invoke('app:get-version'),
    platform: await ipcRenderer.invoke('app:get-platform'),
  }),
  getPaths: () => ipcRenderer.invoke('app:get-paths'),

  // 窗口控制
  window: {
    minimize:      () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize:() => ipcRenderer.invoke('window:toggle-maximize'),
    close:         () => ipcRenderer.invoke('window:close'),
    isMaximized:   () => ipcRenderer.invoke('window:is-maximized'),
  },

  // 设置（持久化到 userData/settings.json）
  settings: {
    get:   ()    => ipcRenderer.invoke('settings:get'),
    set:   (p)   => ipcRenderer.invoke('settings:set', p),
    reset: ()    => ipcRenderer.invoke('settings:reset'),
  },

  // Native dialogs
  dialog: {
    openDirectory: (opts) => ipcRenderer.invoke('dialog:open-directory', opts || {}),
    openFile:      (opts) => ipcRenderer.invoke('dialog:open-file', opts || {}),
    saveFile:      (opts) => ipcRenderer.invoke('dialog:save-file', opts || {}),
    confirm:       (opts) => ipcRenderer.invoke('dialog:confirm', opts || {}),
  },

  // 数据（全部走 scanner，30s 缓存）
  data: {
    getOverview:     (force) => ipcRenderer.invoke('data:get-overview', !!force),
    getProjects:     ()      => ipcRenderer.invoke('data:get-projects'),
    getModels:       ()      => ipcRenderer.invoke('data:get-models'),
    getTokens:       ()      => ipcRenderer.invoke('data:get-tokens'),
    getHeatmapYearly:()      => ipcRenderer.invoke('data:get-heatmap-yearly'),
    getLevels:       ()      => ipcRenderer.invoke('data:get-levels'),
    getMeta:         ()      => ipcRenderer.invoke('data:get-meta'),
    rescan:          ()      => ipcRenderer.invoke('data:rescan'),
    clearCache:      ()      => ipcRenderer.invoke('data:clear-cache'),
  },

  // 用户手动配置的项目（scanner 只读这份列表，不自动发现）
  projects: {
    list:   ()       => ipcRenderer.invoke('projects:list'),
    add:    (p)      => ipcRenderer.invoke('projects:add', p || {}),
    remove: (id)     => ipcRenderer.invoke('projects:remove', id),
    touch:  (id)     => ipcRenderer.invoke('projects:touch', id),
    launch: (id)     => ipcRenderer.invoke('projects:launch', id),
  },

  // 模型价格管理
  models: {
    listPrices:  ()         => ipcRenderer.invoke('models:list-prices'),
    updatePrice: (payload)  => ipcRenderer.invoke('models:update-price', payload),
    deletePrice: (name)     => ipcRenderer.invoke('models:delete-price', name),
  },

  // 配置组管理（从 model_helper 融合）
  profiles: {
    list:      ()                => ipcRenderer.invoke('profiles:list'),
    get:       (name)            => ipcRenderer.invoke('profiles:get', name),
    add:       (profile)         => ipcRenderer.invoke('profiles:add', profile || {}),
    update:    (name, patch)     => ipcRenderer.invoke('profiles:update', name, patch || {}),
    delete:    (name)            => ipcRenderer.invoke('profiles:delete', name),
    switchTo:  (name)            => ipcRenderer.invoke('profiles:switch', name),
    current:   ()                => ipcRenderer.invoke('profiles:current'),
    envFields: ()                => ipcRenderer.invoke('profiles:env-fields'),
  },

  // 终端（xterm.js 持续 shell 会话）
  terminal: {
    start: (opts) => ipcRenderer.invoke('terminal:start', opts || {}),
    write: (data) => ipcRenderer.invoke('terminal:write', typeof data === 'string' ? { data } : data),
    close: (opts) => ipcRenderer.invoke('terminal:close', opts || {}),
    onData: (cb) => {
      const handler = (_e, data) => cb(data);
      // 主进程发送到 terminal:data:${tabId}，这里监听 default tab
      ipcRenderer.on('terminal:data:default', handler);
      return () => ipcRenderer.removeListener('terminal:data:default', handler);
    },
    onExit: (cb) => {
      const handler = (_e, code) => cb(code);
      ipcRenderer.on('terminal:exit:default', handler);
      return () => ipcRenderer.removeListener('terminal:exit:default', handler);
    },
    // 终端检测
    detect:        () => ipcRenderer.invoke('terminal:detect'),
    listAvailable: () => ipcRenderer.invoke('terminal:list-available'),
  },

  // 导出
  export: {
    save: (payload) => ipcRenderer.invoke('export:save', payload),
  },

  // 剪贴板
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },

  // 系统 shell
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  },

  // 自动更新
  updater: {
    check:    ()     => ipcRenderer.invoke('update:check'),
    download: ()     => ipcRenderer.invoke('update:download'),
    install:  ()     => ipcRenderer.invoke('update:install'),
    onAvailable:    (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('update:available', h); return () => ipcRenderer.removeListener('update:available', h); },
    onNotAvailable: (cb) => { const h = () => cb(); ipcRenderer.on('update:not-available', h); return () => ipcRenderer.removeListener('update:not-available', h); },
    onProgress:     (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('update:progress', h); return () => ipcRenderer.removeListener('update:progress', h); },
    onDownloaded:   (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('update:downloaded', h); return () => ipcRenderer.removeListener('update:downloaded', h); },
    onError:        (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('update:error', h); return () => ipcRenderer.removeListener('update:error', h); },
  },
});
