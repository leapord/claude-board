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
- **🏆 等级** — Lv.1-99 积分系统（萌芽 → 学者 → 工匠 → 大牛）+ 升级规则帮助
- **🔥 热力图** — GitHub-style 年度活跃热力图
- **🖥️ 终端** — 内置 xterm.js 终端，直接操作
- **📤 导出** — 一键导出周报（Markdown/HTML/JSON/TXT）
- **⚙️ 设置** — 路径配置 + 自动扫描 + 终端偏好 + 主题切换

## v0.3.0 新增

### 🌓 主题切换
支持 **暗色 / 亮色 / 跟随系统** 三种模式，在设置 → 外观中切换。
亮色主题覆盖全部组件（侧边栏、卡片、弹窗、输入框、按钮）。

### 🔄 自动更新
集成 `electron-updater` + GitHub Releases，支持：
- 检查新版本
- 后台下载 + 进度通知
- 下载完成后一键重启安装

### 🌐 i18n 国际化
内置 **简体中文 / English** 双语支持，设置 → 通用 → 界面语言切换。

### 📌 系统托盘
- 状态栏显示托盘图标
- 右键菜单：打开主窗口 / 刷新数据 / 设置 / 退出
- 支持「最小化到托盘」（关闭窗口时隐藏到托盘，不退出）
- macOS 点击托盘图标恢复窗口

### 🏆 等级帮助
等级页面新增 ❓ 帮助按钮，展示完整升级积分规则。

### 📦 构建资源
新增应用图标（icns/ico/png）+ 托盘图标 + 图标生成脚本。

## 终端检测

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
- **electron-updater** — 自动更新
- **electron-builder** — 跨平台打包

## 开发 & 打包

```bash
# 安装依赖
npm install

# 开发模式（带 DevTools）
npm run dev

# 仅启动
npm start

# 打包
npm run dist:mac      # macOS DMG + ZIP
npm run dist:win      # Windows 安装包 + 便携版
npm run dist:all      # 所有平台
```

打包产物在 `dist/` 目录下。

## 目录结构

```
claude-board/
├── build/              # 应用图标 + 托盘图标
│   ├── icon.icns       # macOS 图标
│   ├── icon.ico        # Windows 图标
│   ├── icon.png        # 通用图标
│   └── tray-icon.png   # 托盘图标
├── scripts/
│   ├── generate-icon.js # 图标生成脚本
│   └── release.sh       # 发布脚本
├── src/
│   ├── main/
│   │   ├── main.js     # 主进程：窗口 + IPC + 设置 + 托盘 + 自动更新
│   │   ├── scanner.js  # Claude Code 日志扫描器
│   │   └── profile-manager.js # 配置组管理
│   ├── preload/
│   │   └── preload.js  # 安全桥接层（含 updater IPC）
│   └── renderer/
│       ├── index.html   # 13 屏 SPA
│       ├── renderer.js  # 全部 UI 逻辑（含 i18n）
│       ├── i18n.js      # 国际化翻译字典（zh-CN / en-US）
│       └── styles.css   # 设计系统（暗色 + 亮色）
└── package.json
```

## 版本历史

| 版本 | 说明 |
|---|---|
| v0.1 | 工程基座、12 屏 UI、数据扫描、终端 |
| v0.2 | 终端偏好设置 + 跨平台检测 + 配置组融合 |
| **v0.3.0** | **主题切换 + 自动更新 + i18n + 系统托盘 + 等级帮助** |

## License

MIT
