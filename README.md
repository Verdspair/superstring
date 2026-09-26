# Superstring

A local, single-user desktop Agent workspace for Windows, macOS and Linux. Conversations, long-term memory, Agents and settings stay on your machine, and model inference runs on your configured model server.

**Version:** `0.2.1`.

**版本：** `0.2.1`。

[English](#english) · [简体中文](#简体中文)

## English

### What it is

Superstring is a desktop chat client that keeps its data local. It talks to an OpenAI-compatible model server — LM Studio by default, at `http://127.0.0.1:1234/v1` — and stores application data locally. macOS/Linux desktop profiles use the system user-data directory; Windows retains its installation layout. There is no account to create and no cloud sync.

Built with Bun, Hono, SQLite and React 19.

### Features

| | |
|---|---|
| Local chat | Streaming conversations with the models you run yourself; the app ships the client, not the model |
| Assistants | Separate assistants, each with its own instructions, model choice and settings, including per-assistant overrides |
| Long-term memory | Memories built from your conversations, editable and correctable in place, with three reading presets |
| Knowledge library | Import `.txt` / `.md` files or paste text, organize it into categories, and authorize it per assistant |
| Context-usage panel | Estimated usage, loaded model capacity and the breakdown behind each request, shown next to the chat input |
| Runtime observability | Search and filter execution traces across conversations, model calls, delivery and background work |
| Settings | Left-side categories with top tabs, per-page saving, 16 themes, English and Simplified Chinese |

### Requirements

- Native package targets: Windows x64; macOS 13+ arm64/x64; Linux glibc arm64/x64. See [desktop distributions](docs/reference/desktop.md) for package formats and validation boundaries.
- A local OpenAI-compatible model server; LM Studio is the tested one.
- Model weights and LM Studio itself are not bundled — install and download them separately.

### Install on Windows

1. Download `superstring-setup-<version>.exe` from [Releases](https://github.com/Verdspair/superstring/releases) and check it against `SHA256SUMS.txt`.
2. Run the installer and choose an installation folder. Running a newer installer over the same folder upgrades in place and keeps your conversations, memories and saved settings. Fully close the app first, and back up `userdata`.
3. Data lives in `userdata` inside the installation folder: `superstring.sqlite` for the database, plus backups.

If LM Studio has **Require API token** enabled, set the token for the app before launching:

```powershell
$env:LM_STUDIO_API_KEY = "your-lm-studio-token"
& "D:\superstring\superstring.exe"
```

This applies to that launch only. For shortcut launches, add `LM_STUDIO_API_KEY` to your Windows user environment variables and sign out and back in.

### Run from source

Install Node.js 22.12.0 or newer, then:

```bash
npm ci
```

Launch `start.cmd` on Windows, or `./start.sh` on macOS/Linux. Both entry points build the web assets and start the server; Ctrl+C in the terminal stops them.

For source-only development, set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when running `npm ci` to skip the desktop runtime download.

### Documentation

- [UPGRADING.md](UPGRADING.md) — what changed in this version and how to upgrade from the previous one
- [RELEASE_NOTES.md](RELEASE_NOTES.md) — release notes
- [Runtime observability](docs/reference/runtime-observability.md) — filters, trace navigation and diagnostic data lifetime
- [Desktop distributions](docs/reference/desktop.md) — macOS/Linux installation, data, recovery and CI release
- [LICENSE](LICENSE) — MIT for this project's own code

---

## 简体中文

### 这是什么

Superstring 是一个把数据留在本机的桌面 Agent 工作区。它连接 OpenAI 兼容模型服务——默认是 LM Studio，地址 `http://127.0.0.1:1234/v1`。macOS/Linux 桌面端将数据保存到系统用户目录，Windows 保留原安装目录布局。不需要注册账号，也不做云端同步。

技术栈为 Bun、Hono、SQLite 与 React 19。

### 功能

| | |
|---|---|
| 本地对话 | 与自己运行的模型流式对话；应用只提供客户端，不包含模型 |
| 助手 | 每个助手有独立的提示词、模型选择和配置，也支持单独覆盖 |
| 长期记忆 | 从对话中生成的记忆，可直接修改和纠正，提供三档读取预设 |
| 知识库 | 导入 `.txt`、`.md` 文件或粘贴文本，按分类管理，并按助手分别授权 |
| 上下文用量面板 | 在输入框旁查看估算用量、已加载模型容量和本次请求的组成 |
| 运行观测 | 检索、筛选对话、模型调用、投递及后台任务的执行链路 |
| 设置 | 左侧分类加顶部页签，按页保存，16 种主题，支持简体中文与 English |

### 运行要求

- 原生打包目标：Windows x64、macOS 13+ arm64/x64、Linux glibc arm64/x64。安装方式及验证边界见[桌面发行文档](docs/reference/desktop.md)。
- 需要一个本机 OpenAI 兼容模型服务，当前测试使用的是 LM Studio。
- LM Studio 与模型文件不随应用提供，需另行安装和下载。

### Windows 安装

1. 从[版本页面](https://github.com/Verdspair/superstring/releases)下载 `superstring-setup-<版本>.exe`，并用 `SHA256SUMS.txt` 校验。
2. 运行安装包并选择安装目录。用较新版本覆盖同一目录即为原地升级，会话、记忆和已存配置都会保留。升级前请完整退出应用，并备份 `userdata`。
3. 数据位于安装目录内的 `userdata`：数据库为 `superstring.sqlite`，同目录另有备份。

LM Studio 开启 **Require API token** 时，启动前先为应用设置 token：

```powershell
$env:LM_STUDIO_API_KEY = "your-lm-studio-token"
& "D:\superstring\superstring.exe"
```

此设置仅对本次启动生效。使用快捷方式启动时，请在 Windows 用户环境变量中添加 `LM_STUDIO_API_KEY`，再注销并重新登录。

### 源码运行

需安装 Node.js 22.12.0 或更高版本，然后执行：

```bash
npm ci
```

Windows 启动 `start.cmd`，macOS/Linux 启动 `./start.sh`。两者都会构建前端资源并启动服务，在终端按 Ctrl+C 停止。

只运行源码时，可在执行 `npm ci` 前设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，跳过桌面运行时下载。

### 文档

- [UPGRADING.md](UPGRADING.md)——本版相对上一版的变化与升级步骤
- [RELEASE_NOTES.md](RELEASE_NOTES.md)——版本说明
- [运行观测](docs/reference/runtime-observability.md)——筛选、链路追溯与观测数据生命周期
- [桌面发行](docs/reference/desktop.md)——macOS/Linux 安装、数据、恢复及 CI 发布
- [LICENSE](LICENSE)——本项目自身代码采用 MIT 协议

---

## Thanks / 致谢

Special thanks to my friend [nkanf-dev](https://github.com/nkanf-dev) for his support and encouragement, especially his help with hardware, for contributing macOS/Linux source-launch support in [#1](https://github.com/Verdspair/superstring/pull/1), and for reporting that an occupied port could make the app unusable in some cases.

特别感谢我的朋友 [nkanf-dev](https://github.com/nkanf-dev) 的支持与鼓励，尤其在硬件上的帮助；也感谢他在 [#1](https://github.com/Verdspair/superstring/pull/1) 中贡献 macOS/Linux 源码启动支持，以及发现部分情况下端口被占用导致软件无法使用的问题。
