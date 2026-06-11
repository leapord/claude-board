# 发布指南

## 自动更新机制

Claude Board 使用 `electron-updater` 配合 GitHub Releases 实现自动更新功能。客户端通过读取 GitHub Releases 中的 `latest.yml`（Windows）和 `latest-mac.yml`（macOS）文件来检查新版本。

## 发布流程

### 前置条件

1. **安装 GitHub CLI**
   ```bash
   # macOS
   brew install gh

   # Windows
   winget install GitHub.cli

   # Linux
   # 参考 https://github.com/cli/cli/blob/trunk/docs/install_linux.md
   ```

2. **登录 GitHub CLI**
   ```bash
   gh auth login
   ```

3. **确保已构建**
   ```bash
   npm run dist:all    # 构建所有平台
   # 或
   npm run dist:mac    # 仅构建 macOS
   npm run dist:win    # 仅构建 Windows
   ```

### 使用发布脚本（推荐）

项目根目录提供了自动发布脚本：

```bash
./scripts/release.sh
```

脚本会自动：
1. 检查构建产物和 `latest.yml` 文件
2. 创建 git tag
3. 使用 `gh release create` 创建 Release
4. 上传所有安装包和 `latest.yml` 文件
5. 验证上传状态

### 手动发布步骤

如果你想手动操作，按照以下步骤：

#### 1. 更新版本号

修改 `package.json` 中的 `version` 字段：
```json
{
  "version": "0.3.2"
}
```

#### 2. 提交代码并打 tag

```bash
git add .
git commit -m "feat: v0.3.2 — 新功能描述"
git tag -a v0.3.2 -m "Release v0.3.2"
git push origin master --tags
```

#### 3. 构建安装包

```bash
npm run dist:all
```

#### 4. 创建 GitHub Release 并上传文件

```bash
# 创建 release 并上传所有文件（包括 latest.yml）
gh release create v0.3.2 \
    --title "Release v0.3.2" \
    --notes "Release notes here" \
    dist/latest.yml \
    dist/latest-mac.yml \
    dist/*.exe \
    dist/*.dmg \
    dist/*.zip
```

#### 5. 验证发布

```bash
# 查看 release 详情
gh release view v0.3.2

# 检查附件列表
gh release view v0.3.2 --json assets --jq '.assets[].name'
```

## 重要说明

### 为什么需要 latest.yml？

- `latest.yml` 和 `latest-mac.yml` 是 `electron-updater` 用来检查新版本的关键文件
- 如果这些文件没有上传，客户端将无法检测到新版本
- 每次发布都必须包含这两个文件

### 文件说明

构建完成后，`dist/` 目录下会生成以下文件：

| 文件 | 说明 |
|------|------|
| `latest.yml` | Windows 更新清单 |
| `latest-mac.yml` | macOS 更新清单 |
| `ClaudeBoard-Setup-0.3.2-x64.exe` | Windows 64位安装包 |
| `ClaudeBoard-Setup-0.3.2-arm64.exe` | Windows ARM64 安装包 |
| `ClaudeBoard-Portable-0.3.2-x64.exe` | Windows 64位便携版 |
| `ClaudeBoard-0.3.2-x64.dmg` | macOS 64位安装包 |
| `ClaudeBoard-0.3.2-arm64.dmg` | macOS ARM64 安装包 |
| `ClaudeBoard-0.3.2-x64.zip` | macOS 64位 zip 包 |
| `ClaudeBoard-0.3.2-arm64.zip` | macOS ARM64 zip 包 |

### 自动更新工作原理

1. 客户端启动时检查 GitHub Releases 的最新版本
2. 读取 `latest.yml` 或 `latest-mac.yml` 获取版本信息
3. 比较版本号，如果发现新版本则提示用户更新
4. 下载对应平台的安装包
5. 用户确认后安装并重启

## 故障排除

### gh 命令不可用

```bash
# 检查是否安装
gh --version

# 检查是否登录
gh auth status

# 重新登录
gh auth login
```

### latest.yml 未上传

如果发布后发现 `latest.yml` 没有上传：

```bash
# 方法1：重新上传
gh release upload v0.3.2 dist/latest.yml dist/latest-mac.yml

# 方法2：编辑 release 并添加文件
gh release edit v0.3.2 --add-file dist/latest.yml --add-file dist/latest-mac.yml
```

### 自动更新不工作

1. **检查 latest.yml 是否存在**
   ```bash
   gh release view v0.3.2 --json assets --jq '.assets[].name' | grep latest
   ```

2. **检查版本号格式**
   - 确保 `package.json` 中的版本号格式正确（如 `0.3.2`）

3. **检查网络连接**
   - 自动更新需要访问 GitHub API
   - 某些网络环境可能需要代理

### 构建失败

```bash
# 清理并重新构建
rm -rf dist node_modules
npm install
npm run dist:all
```

## 版本号规范

遵循 [Semantic Versioning](https://semver.org/)：

- **MAJOR.MINOR.PATCH**（如 0.3.2）
- **MAJOR**：不兼容的 API 修改
- **MINOR**：向下兼容的功能性新增
- **PATCH**：向下兼容的问题修正

## 发布检查清单

- [ ] 更新版本号（package.json）
- [ ] 更新 CHANGELOG.md（如果有）
- [ ] 测试构建产物
- [ ] 提交代码并打 tag
- [ ] 运行 `./scripts/release.sh` 发布
- [ ] 验证 GitHub Releases 页面
- [ ] 确认 `latest.yml` 和 `latest-mac.yml` 已上传
- [ ] 测试自动更新功能
- [ ] 通知用户新版本发布
