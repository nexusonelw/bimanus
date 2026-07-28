# Linux 安装与远程访问

本文说明如何在 Linux（x64 / arm64）上安装 Bimanus、配置远程访问端口与密码、启动应用，以及卸载。

相关脚本：

| 脚本 | 作用 |
|------|------|
| [`scripts/install-linux.sh`](../scripts/install-linux.sh) | 从 GitHub Releases 一键安装 |
| [`scripts/uninstall-linux.sh`](../scripts/uninstall-linux.sh) | 一键卸载 |

## 环境要求

- Linux **x64**（`x86_64`）或 **arm64**（`aarch64`）
- `curl`
- `python3` **或** `node`（用于解析 GitHub Release 元数据）
- 建议在有桌面环境的机器上运行（Electron GUI）。纯无头服务器可能还需要额外显示/GPU 配置，不在本文范围。
- 可访问 `https://github.com` / `https://api.github.com`

## 快速安装

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | bash
```

安装脚本会：

1. 识别 CPU 架构（`x64` / `arm64`）。
2. 拉取最新 GitHub Release（包含 `v0.1.0-beta.*` 等预发布版本）。
3. 下载对应架构 AppImage（`Bimanus-*-x64.AppImage`、`Bimanus-*-x86_64.AppImage` 或 `Bimanus-*-arm64.AppImage`）。
4. 提示配置远程访问 **端口**（默认 `43174`）和 **密码/Token**（默认随机生成）。
5. 完成安装，并打印局域网导入地址：

   ```text
   http://<局域网IP>:<端口>/?token=<密码>
   ```

### 非交互安装

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | \
  bash -s -- --yes --port 43174 --token 'your-secret'
```

环境变量写法：

```bash
BIMANUS_REMOTE_UI_PORT=43174 \
BIMANUS_REMOTE_UI_TOKEN='your-secret' \
bash scripts/install-linux.sh --yes
```

### 安装参数

| 参数 | 环境变量 | 说明 |
|------|----------|------|
| `--port <n>` | `BIMANUS_REMOTE_UI_PORT` | 远程 UI 端口（默认 `43174`） |
| `--token <s>` / `--password <s>` | `BIMANUS_REMOTE_UI_TOKEN` | 远程访问密码 / Bearer Token |
| `--host <addr>` | `BIMANUS_REMOTE_UI_HOST` | 绑定地址（默认 `0.0.0.0`） |
| `--version <tag>` | `BIMANUS_VERSION` | 指定 Release 标签（如 `v0.1.0-beta.30`） |
| `--repo owner/repo` | `BIMANUS_REPO` | GitHub 仓库（默认 `nexusonelw/bimanus`） |
| `--install-dir <dir>` | `BIMANUS_INSTALL_DIR` | AppImage 目录（默认 `~/.local/opt/bimanus`） |
| `--bin-dir <dir>` | `BIMANUS_BIN_DIR` | 启动命令目录（默认 `~/.local/bin`） |
| `--yes` / `-y` | — | 使用默认值，不交互提问 |
| `--no-start` | — | 减少启动相关完成提示 |
| `--help` | — | 显示帮助 |

若 GitHub API 匿名请求被限流，可设置 `GITHUB_TOKEN` 或 `GH_TOKEN`。

## 安装后的文件位置

| 路径 | 内容 |
|------|------|
| `~/.local/opt/bimanus/*.AppImage` | 应用本体 |
| `~/.local/opt/bimanus/remote-ui.env` | 启动器读取的远程 UI 环境变量（`PI_APP_REMOTE_UI*`） |
| `~/.local/opt/bimanus/.bimanus-install-meta` | 供卸载脚本使用的安装元数据 |
| `~/.local/bin/bimanus` | 启动包装脚本（需在 `PATH` 中） |
| `~/.local/share/applications/bimanus.desktop` | 桌面入口 |
| `~/.config/Bimanus/ui-state.json` | 应用 UI 状态，含 `remoteUiPort` / `remoteUiToken` |

确保 `~/.local/bin` 已加入 `PATH`：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 启动

```bash
bimanus
```

安装脚本会把 token 写入 `remote-ui.env` 与 `ui-state.json`，因此启动后远程 UI 桥接会自动开启。

### 启动时用命令行覆盖远程配置

优先级：**CLI > 环境变量 > 设置页持久化**。

```bash
bimanus \
  --remote-ui \
  --remote-ui-host 0.0.0.0 \
  --remote-ui-port 43174 \
  --remote-ui-token 'your-secret'
```

| 参数 | 说明 |
|------|------|
| `--remote-ui` / `--no-remote-ui` | 强制开启 / 关闭远程桥接 |
| `--remote-ui-host <addr>` | 绑定地址 |
| `--remote-ui-port <n>` | HTTP/SSE 端口 |
| `--remote-ui-token <s>` / `--remote-ui-password <s>` | Bearer Token / 访问密码 |

### 用环境变量覆盖

```bash
PI_APP_REMOTE_UI=1 \
PI_APP_REMOTE_UI_HOST=0.0.0.0 \
PI_APP_REMOTE_UI_PORT=43174 \
PI_APP_REMOTE_UI_TOKEN='your-secret' \
bimanus
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_APP_REMOTE_UI` | — | 设为 `1` 强制启用 |
| `PI_APP_REMOTE_UI_HOST` | `0.0.0.0` | LAN 访问绑定地址 |
| `PI_APP_REMOTE_UI_PORT` | `43174` | 远程 UI 端口 |
| `PI_APP_REMOTE_UI_TOKEN` | — | Bearer Token / 密码 |

之后也可以在应用内 **设置 → 远程 UI** 修改端口和密码。

## 从其他设备访问

1. 在 Linux 主机上启动 Bimanus（`bimanus`）。
2. 确认主机与客户端在同一局域网/VPN，且防火墙放行对应端口。
3. 打开安装结束时打印的导入地址，或自行拼装：

   ```text
   http://<主机局域网IP>:<端口>/?token=<密码>
   ```

4. 鉴权方式（同一 token）：
   - 查询参数：`?token=<密码>`
   - 请求头：`Authorization: Bearer <密码>`
   - 请求头：`X-Pi-Remote-Ui-Token: <密码>`

请妥善保管 token。优先使用局域网 / VPN / 隧道；不要在没有额外防护的情况下把桥接暴露到公网。

## 更新

重新执行安装脚本即可。它会下载最新（或 `--version` 指定）AppImage，并重写启动器与环境配置。

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | bash
```

非交互保留原密码：

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | \
  bash -s -- --yes --port 43174 --token 'your-existing-secret'
```

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | bash
```

同时删除应用数据（`~/.config/Bimanus`）：

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | \
  bash -s -- --yes --purge
```

### 卸载参数

| 参数 | 说明 |
|------|------|
| `--install-dir <dir>` | 覆盖安装目录 |
| `--bin-dir <dir>` | 覆盖启动命令目录 |
| `--purge` | 同时删除 `~/.config/Bimanus` |
| `--yes` / `-y` | 跳过确认 |
| `--help` | 显示帮助 |

若存在 `~/.local/opt/bimanus/.bimanus-install-meta`，卸载脚本会按安装时记录的路径清理自定义目录。

## 不使用脚本的手动安装

1. 从 [Releases](https://github.com/nexusonelw/bimanus/releases) 下载对应架构 AppImage。
2. 赋予执行权限并启动：

   ```bash
   chmod +x Bimanus-*-*.AppImage
   PI_APP_REMOTE_UI=1 \
   PI_APP_REMOTE_UI_PORT=43174 \
   PI_APP_REMOTE_UI_TOKEN='your-secret' \
   ./Bimanus-*-*.AppImage
   ```

## 发布说明（维护者）

`pnpm release` 会通过 `scripts/release-local.mjs` 构建并上传 Linux **x64** 与 **arm64** AppImage。

```bash
pnpm release
# 如需跳过某一架构：
pnpm release --no-linux-arm64
pnpm release --no-linux-x64
```

仅本地打包：

```bash
pnpm --filter @bimanus/desktop run package:linux        # x64 + arm64
pnpm --filter @bimanus/desktop run package:linux:x64
pnpm --filter @bimanus/desktop run package:linux:arm64
```

## 故障排查

| 现象 | 排查方向 |
|------|----------|
| `No AppImage asset found for arch=arm64` | 该 Release 可能尚未包含 arm64 产物。换更新的版本，或用 `--version` 指定含 arm64 AppImage 的标签。 |
| `bimanus: command not found` | 将 `~/.local/bin` 加入 `PATH`，或直接运行 AppImage 路径。 |
| 远程页面 Unauthorized | Token 不一致。检查 `remote-ui.env`、CLI 参数或 **设置 → 远程 UI**。 |
| 其他设备连不上 | 防火墙、局域网 IP 错误、未绑定 `0.0.0.0`，或不在同一网络。 |
| GitHub API 403 / 限流 | 设置 `GITHUB_TOKEN` / `GH_TOKEN` 后重试。 |
| 服务器上启动失败 | Electron 依赖图形/GPU 相关库。请使用桌面环境或虚拟显示；安装脚本不处理该场景。 |
