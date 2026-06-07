# Claude Board

跨平台桌面工具，基于 **Electron**。

## 技术栈

- **运行时**：Electron 31+
- **架构**：三层分离（main / preload / renderer）
- **安全基线**：contextIsolation + sandbox + CSP
- **打包**：electron-builder（mac/win/linux）
- **数据层（规划）**：v0.1 暂不接入；v0.2 引入 `better-sqlite3`（回退方案：`sql.js` WASM）

## 目录结构

```
claude-board/
├── src/
│   ├── main/         # 主进程（Node 环境）
│   │   └── main.js
│   ├── preload/      # 预加载脚本（安全桥接层）
│   │   └── preload.js
│   └── renderer/     # 渲染进程（浏览器环境）
│       ├── index.html
│       ├── renderer.js
│       └── styles.css
├── package.json
└── .gitignore
```

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式（带 DevTools）
npm run dev

# 仅启动
npm start

# 打包（不生成安装包，仅目录）
npm run pack

# 跨平台分发包
npm run dist          # 当前平台
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## 版本规划

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.1 | ✅ 当前 | 工程基座、窗口、CSP、安全配置 |
| v0.2 | 🔜 | 接入 SQLite（`better-sqlite3`），IPC 数据通道 |
| v0.3 | 📋 | 业务功能 |
