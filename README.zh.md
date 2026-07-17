# Bimanus

> [English Documentation](./README.md)

一个面向 [`pi`](https://github.com/earendil-works/pi) 编码代理会话的桌面外壳，内置远程 UI 桥接，让你可以在局域网内用手机或平板驱动你的智能体。

Bimanus 在 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 之上封装了一层原生桌面 UI。它**不是**一个独立的编码代理运行时：会话管理、模型/鉴权配置、以及代理执行都通过上游 `pi` 包完成。Bimanus 是 UI 层——线程化的会话时间线、集成终端、内联差异查看器，以及多终端访问——以 `pi` 自身的会话文件作为唯一事实来源。

本项目是 [`minghinmatthewlam/pi-gui`](https://github.com/minghinmatthewlam/pi-gui) 的一个分支（fork），在原有基础上扩展了远程 UI 桥接、多窗口/多客户端并发、Windows TUI 与打包支持，以及 MCP OAuth 桥接。

![Bimanus demo](./docs/readme/demo.gif)

![Bimanus 应用界面](./asserts/2768a62a-5f88-49c9-9134-4fe5917804dc.png)

## 状态

- 公测阶段（macOS arm64、Linux AppImage、Windows NSIS）
- 公开源代码仓库

## 功能特性

- **线程化会话时间线** —— 每个 `pi` 会话渲染为消息与可折叠工具调用组成的时间线。
- **每个线程独立的 Git worktree** —— 可直接在工作区中启动线程（`Local`），或在隔离的 git worktree 中启动，避免并行工作相互冲突。
- **集成终端** —— 应用内嵌真实 PTY 终端（基于 `node-pty`），包含 `pi` 的 TUI。
- **内联差异查看器** —— 在侧边面板中审阅改动文件（⌘/Ctrl + D 切换）。
- **分屏面板（多 CLI 并行）** —— 在右侧打开分屏面板，同时运行多个 CLI 会话（CodeX、Claude、OpenCode、Grok、Copilot 等）。支持单栏、双栏、双栏等宽、田字格 2×2 四种布局。每个 Pane 运行独立的 PTY 终端，支持独立的工作目录绑定（跟随工作区或固定路径）。快捷键 ⇧⌘P（macOS）/ Ctrl+Shift+P（Windows/Linux）。
- **多终端访问** —— 同一个 `DesktopAppStore` 被 Electron 窗口、远程浏览器客户端（SSE + HTTP）、TUI 标签页、分屏面板 Pane、外部 CLI 进程共享。每个终端只看到自己选中的工作区/会话子集。
- **远程 UI 桥接** —— 将渲染层暴露到局域网，通过带令牌鉴权的 HTTP + SSE 服务器（`RemoteUiServer`），用手机或平板驱动 Bimanus。
- **多窗口** —— 多个 Electron 窗口拥有相互隔离的视图状态，并通过串行化动作队列保证共享状态一致。
- **MCP OAuth 桥接** —— 在桌面端管理并授权远程 MCP 服务器，经 StreamableHTTP 桥接进 `pi` 代理运行时。
- **技能与扩展** —— 在专用视图中管理 `pi` 的技能与扩展。
- **外观主题** —— 支持浅色与深色，以及可选的主题预设。
- **原生通知** —— 代理运行结束时收到操作系统通知。
- **会话归档** —— 归档已完成的线程，保持侧边栏整洁。
- **多供应商** —— 在 **设置 → 供应商** 中通过 OAuth 或 API Key 连接模型供应商。

## 安装

### 通过 GitHub Releases

从 [Releases](https://github.com/nexusonelw/bimanus/releases) 下载最新的 `.dmg`（macOS）、`.AppImage`（Linux）或 `.exe` NSIS 安装包（Windows）。

在 macOS 上，将 `Bimanus.app` 拖入 `/Applications` 并正常启动。发布版本已签名并公证。更新时下载新版本并替换 `/Applications` 中的旧应用即可。

Linux 以 AppImage 形式发布。Windows 以 NSIS 安装包形式发布；默认使用应用内捆绑的 `pi` CLI 启动 TUI，因此仅打开 TUI 无需单独安装系统级 `pi`。

### 通过 Homebrew（macOS）

```bash
brew tap nexusonelw/tap
brew install --cask bimanus
```

使用 `brew upgrade --cask bimanus` 更新。公测期间，Homebrew 升级可能更像重新安装而非原地补丁；升级后你可能需要重新确认 Dock 位置或某些权限提示。

### 从源码构建

参见 [开发](#开发)。源码安装面向贡献者与本地开发，并非主要的最终用户安装方式。

## 快速开始

1. 安装并启动 Bimanus。
2. 打开 **设置 → 供应商**，连接一个模型供应商（OAuth 或 API Key）。
3. 添加一个工作区（本地项目文件夹）。
4. 点击 **新建线程**，选择 `Local` 或 `Worktree`，发送你的第一条提示。

你需要 `pi` 支持的有效的模型/供应商鉴权；Bimanus 复用 `pi` 的鉴权与会话状态，因此你已通过 `pi` CLI 配置的内容会自动沿用。

## 远程 UI（手机 / 平板访问）

Bimanus 可以将渲染层暴露到局域网，让你用手机或平板驱动它。远程 UI 直接在应用内开启，无需设置任何环境变量。

### 快速开始

1. 正常启动 Bimanus（源码方式执行 `pnpm run dev`，或打开已安装的应用）。
2. 打开 **设置 → 远程 UI**，开启远程桥接。
3. 设置一个 Bearer Token，并选择要绑定的主机/端口（默认 `0.0.0.0:43174`；开发模式下渲染层由 `43173` 提供）。
4. 从手机或平板打开打印出的 URL（例如 `http://<本机局域网IP>:43173/?token=<你的token>`）。

### 环境变量（可选）

你也可以通过环境变量配置远程 UI，替代设置面板操作：

```bash
PI_APP_REMOTE_UI=1 \
PI_APP_REMOTE_UI_HOST=0.0.0.0 \
PI_APP_REMOTE_UI_PORT=43174 \
PI_APP_REMOTE_UI_TOKEN='你的密钥' \
pnpm run dev
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_APP_REMOTE_UI` | — | 设为 `1` 启用远程桥接 |
| `PI_APP_REMOTE_UI_HOST` | `0.0.0.0` | 绑定地址（LAN 访问需设为 `0.0.0.0`） |
| `PI_APP_REMOTE_UI_PORT` | `43174` | 远程 UI HTTP/SSE 服务器端口 |
| `PI_APP_REMOTE_UI_TOKEN` | 自动生成 | Bearer Token 鉴权 |

当 `PI_APP_REMOTE_UI_TOKEN` 已设置或在设置面板中配置了 Token 时，远程桥接会在启动时自动开启。

### 工作原理

远程 UI 桥接采用**四层架构**：

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器 / 手机 / 平板（瘦客户端）                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ RemoteClient (remote-client.ts)                       │  │
│  │  • EventSource → SSE /api/events（实时推送）           │  │
│  │  • fetch      → POST /api/invoke（IPC 代理）           │  │
│  │  • fetch      → POST /api/remote-agent（Agent 执行）   │  │
│  └──────────┬────────────────────────────────────────────┘  │
└─────────────┼────────────────────────────────────────────────┘
              │  HTTP + SSE（Token 鉴权）
              ▼
┌─────────────────────────────────────────────────────────────┐
│  Electron 主进程                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ RemoteUiServer (remote-ui-server.ts)                  │  │
│  │  • Node.js HTTP 服务器，绑定 0.0.0.0:<port>            │  │
│  │  • 路由：/api/health, /api/events (SSE),              │  │
│  │    /api/invoke, /api/remote-agent, /* (静态资源)      │  │
│  │  • Token 鉴权：Bearer 头 / ?token= / 自定义头          │  │
│  └──────────┬────────────────────────────────────────────┘  │
│             │                                               │
│  ┌──────────▼────────────────────────────────────────────┐  │
│  │ DesktopAppStore（共享状态）                             │  │
│  │  • 与本地 Electron 窗口共用同一份 IPC 分发              │  │
│  │  • 按客户端投影状态（projectStateForView）              │  │
│  │  • 串行化动作队列保证并发安全                           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ RemoteSystemService (remote-system-service.ts)        │  │
│  │  • 远程文件系统：读/写/查找/搜索文件                    │  │
│  │  • 远程 Shell：执行命令、查询状态、终止进程              │  │
│  │  • 操作系统检测门控（需先调用 get-operating-system）    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**关键设计要点：**

- **同一套 UI，两条通道**：React 渲染层（`App.tsx`）对环境无感知。通过 `isElectronHost()` 检测运行环境是 Electron（原生 IPC）还是浏览器（HTTP/SSE 代理），但 UI 代码完全一致。
- **SSE 实时推送**：使用 Server-Sent Events 向远程客户端推送状态变更、终端输出和命令。无需 WebSocket 依赖——仅使用标准 `EventSource` + `fetch`。
- **按客户端状态隔离**：每个远程客户端通过 `projectStateForView` 获得独立的 `DesktopAppStore` 投影视图，并发客户端互不干扰。
- **Token 鉴权**：三种方式传递 Token——`Authorization: Bearer <token>` 头、`?token=<token>` 查询参数、或 `X-Pi-Remote-Ui-Token` 自定义头。

### API 参考

远程 UI 暴露以下 HTTP 端点：

| 端点 | 方法 | 用途 |
|------|------|------|
| `GET /api/health` | GET | 健康检查，返回连接状态 |
| `GET /api/events` | SSE | 实时事件流（state-changed、terminal-*、command 等） |
| `POST /api/invoke` | POST | 代理任意 IPC 通道（工作区、会话、设置等） |
| `POST /api/remote-agent` | POST | 在工作区上直接调用编码 Agent |
| `GET /api/remote-agent/health` | GET | Agent 心跳/存活检查 |
| `GET /*` | GET | 静态资源（渲染层构建产物），SPA 回退 |

**SSE 事件：**

| 事件 | 载荷 | 说明 |
|------|------|------|
| `state-changed` | `DesktopAppState` | 完整应用状态快照（按客户端投影） |
| `command` | `{command, args}` | 桌面命令 |
| `workspace-picked` | 工作区路径 | 工作区选择变更 |
| `terminal-data` | `{data, terminalId}` | PTY 终端输出 |
| `terminal-exit` | `{code, terminalId}` | 终端进程退出 |
| `terminal-error` | `{error, terminalId}` | 终端错误 |
| `theme-changed` | 主题名称 | UI 主题切换 |

### 远程 Agent 执行

`/api/remote-agent` 端点允许远程驱动编码 Agent：

```json
POST /api/remote-agent
Authorization: Bearer <token>
Content-Type: application/json

{
  "workspacePath": "/path/to/project",
  "prompt": "为登录函数添加错误处理",
  "codingAgent": "pi-coding-agent",
  "sessionId": "可选-已有会话ID",
  "newSession": true,
  "timeoutMs": 120000
}
```

支持的 Agent 类型：`pi-coding-agent`、`codex`、`claude-code`、`opencode`、`grok`、`copilot`、`antigravity`、`kiro`、`cursor`、`droid`。

### 远程文件系统与 Shell

远程客户端还可以通过 `RemoteSystemService` 访问主机文件系统和执行 Shell 命令：

- **文件系统**：`get-directory-tree`、`read-file`、`read-file-lines`、`find-files`、`grep-files`、`write-file`、`replace-in-file`
- **Shell**：`execute-shell`、`get-shell-status`、`kill-shell`
- **门控**：每个客户端会话必须先调用 `get-operating-system`

所有 Shell 输出截断至 5,000 字符。长时间运行的任务可通过任务 ID 轮询或终止。

### 端口约定

| 端口 | 用途 | 环境 |
|------|------|------|
| `43173` | Vite 开发服务器（渲染层） | 仅开发环境 |
| `43174` | 远程 UI 桥接（HTTP/SSE） | 开发与生产环境 |

开发模式下，当设置了 `PI_APP_REMOTE_UI=1` 时，Vite dev server 将 `/api/*` 请求代理到 `127.0.0.1:43174`，并绑定到 `0.0.0.0` 以便 LAN 设备直接访问渲染层。

### 安全建议

远程 UI 可控制工作区设置、供应商、技能、扩展、包以及会话，因此请将其置于可信的局域网、VPN 或隧道之后：

- **始终设置强 Bearer Token**——生产环境中不要使用自动生成的默认值。
- **使用 VPN 或 SSH 隧道**——从 LAN 外部访问时务必使用。
- **Token 传输**：首次访问通过 URL 查询参数（`?token=`）传递，随后客户端存储在 `sessionStorage` 中。如果通过互联网暴露，请使用 HTTPS（需要反向代理如 Caddy 或 Nginx）。
- **无 CORS 限制**——服务器默认绑定到 `0.0.0.0`，Token 是唯一的鉴权机制。

## 开发

安装依赖：

```bash
corepack enable
pnpm install
```

以开发模式运行桌面应用：

```bash
pnpm dev
```

构建全部：

```bash
pnpm build
```

运行默认测试套件：

```bash
pnpm test
```

桌面端 E2E 测试通道（lane）与配置详见 [`apps/desktop/README.md`](./apps/desktop/README.md)。默认桌面测试命令运行 `core` 通道；当你需要 `core`、`live`、`native` 时，使用 `pnpm --filter @bimanus/desktop run test:e2e:all`。

本地打包 Linux AppImage：

```bash
pnpm --filter @bimanus/desktop run package:linux
```

本地打包 Windows x64 NSIS 安装包（在 Windows 上运行）：

```bash
pnpm --filter @bimanus/desktop run package:win
```

本地打包 Windows ARM64 安装包：

```bash
pnpm --filter @bimanus/desktop run package:win:arm64
```

类生产环境的打包应用检查：

```bash
pnpm --filter @bimanus/desktop run test:prod:packaged-smoke
```

发布自动化需要以下 GitHub Actions 密钥以进行签名/公证的 macOS 构建：

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

重新生成 README 演示资源：

```bash
pnpm --filter @bimanus/desktop demo:readme
```

## 仓库结构

- `apps/desktop` —— Electron 应用与渲染层 UI（Bimanus 主客户端）
- `apps/website` —— 项目官网（Next.js）
- `packages/session-driver` —— 共享的会话驱动类型
- `packages/catalogs` —— 轻量级工作区/会话目录状态
- `packages/pi-sdk-driver` —— 从桌面应用到 `@earendil-works/pi-coding-agent` 的适配器
- `packages/mcp-bridge-extension` —— 运行在 `pi` 代理运行时内的 MCP 桥接扩展
- `packages/cli-adapter` —— 外部 CLI 代理（codex / claude-code / opencode）的适配器

## 架构

Bimanus 是一个 Electron 应用，围绕严格的 main/preload/renderer 边界组织，构建于 `pi` 运行时之上：

- **渲染层**（`apps/desktop/src`）—— React UI：时间线、输入框、差异面板、终端、设置。仅通过类型化的 IPC 接口（`PiDesktopApi`）与主进程通信。
- **预加载层**（`apps/desktop/electron/preload.ts`）—— 将 IPC 接口暴露给渲染层的窄桥；渲染层不获得广泛的 Node 访问权限。
- **主进程**（`apps/desktop/electron`）—— Node 侧：持有 `DesktopAppStore`、`TerminalService`（PTY + `pi` TUI）、`RemoteUiServer`（HTTP + SSE），以及 MCP 桥接运行时。

多终端并发构建于单一的共享 `DesktopAppStore` 之上。每个终端——Electron 窗口、远程浏览器客户端、TUI 标签页或外部 CLI——都通过 `projectStateForView` 投影出自己的视图子集，所有视图作用域内的变更都经由串行化动作队列（`enqueueWindowScopedAction`）执行，因此并发终端不会破坏彼此的状态。远程 UI 桥接使用 SSE 做实时推送、HTTP POST 代理 IPC，并采用 Bearer Token 鉴权与按 clientId 的状态投影。

## 已知限制

- 应用当前依赖上游 `pi` 的行为与本地鉴权状态。
- 实时端到端验证可能需要本仓库未存储的模型凭证。
- Homebrew 公测升级可能要求 macOS 重新确认部分应用权限或 Dock 位置。

## 致谢

- 派生自 [`minghinmatthewlam/pi-gui`](https://github.com/minghinmatthewlam/pi-gui)。
- 构建于 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 之上。
- 上游运行时与生态由 [`earendil-works/pi`](https://github.com/earendil-works/pi) 提供。

## 许可证

MIT。参见 [LICENSE](./LICENSE)。
