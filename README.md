# Claude Board

跨平台 **Claude Code 使用追踪**桌面工具，基于 Electron。

> 全部数据本地处理，不上传任何信息。

## 截图

| 概览 | 热力图 |
|---|---|
| 概览屏含 4 stat cards + 趋势图 + 饼图 + 热力图 | 年度日历热力图 + 30天柱状图 |

## 功能

- **📊 概览** — 今日对话、本周 Cost、活跃天数、Token 消耗一目了然
- **📁 项目** — 手动配置工作目录，一键启动 Claude Code
- **🤖 模型** — 模型分布 + 可编辑价格表（支持 Claude/GLM/DeepSeek/Qwen 等 30+ 模型）
- **💎 Token** — Input/Output/Cache 详解 + 桑基图流向
- **🏆 等级** — Lv.1-99 积分系统（萌芽 → 学者 → 工匠 → 大牛）
- **🔥 热力图** — GitHub-style 年度活跃热力图
- **🖥️ 终端** — 内置 xterm.js 终端，直接操作
- **📤 导出** — 一键导出周报（Markdown/HTML/JSON/TXT）
- **⚙️ 设置** — 路径配置 + 自动扫描 + **终端偏好设置**

## 终端检测（v0.2 新增）

首次启动自动扫描系统可用终端并保存到配置：

| 平台 | 优先级 |
|---|---|
| macOS | iTerm2 → Terminal.app |
| Windows | Windows Terminal → PowerShell → CMD |
| Linux | GNOME Terminal → Konsole → X Terminal |

可在 **设置 → 通用 → 启动终端** 中切换偏好。

## 技术栈

- **Electron 31+** — contextIsolation + sandbox + CSP
- **三层分离** — main / preload / renderer
- **xterm.js** — 内置终端
- **ECharts** — 数据可视化
- **electron-builder** — 跨平台打包

## 开发

```bash
npm install
npm run dev      # 开发模式（带 DevTools）
npm start        # 仅启动
npm run dist:mac # macOS DMG
npm run dist:win # Windows 安装包
```

## 目录结构

```
claude-board/
├── src/
│   ├── main/           # 主进程
│   │   ├── main.js     # 窗口 + IPC + 设置 + 终端检测
│   │   └── scanner.js  # Claude Code 日志扫描器
│   ├── preload/
│   │   └── preload.js  # 安全桥接层
│   └── renderer/
│       ├── index.html   # 12 屏 SPA
│       ├── renderer.js  # 全部 UI 逻辑
│       └── styles.css   # 设计系统
├── test-terminal-detect.js  # 终端检测跨平台测试
└── package.json
```

## 版本规划

| 版本 | 状态 | 说明 |
|---|---|---|
| v0.1 | ✅ | 工程基座、12 屏 UI、数据扫描、终端 |
| v0.2 | ✅ 当前 | 终端偏好设置 + 跨平台检测 + 模型价格表扩展 |
| v0.3 | 📋 | SQLite 持久化、亮色主题、数据导入 |
