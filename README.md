# superstring · 超弦

[English](#english) · [简体中文](#简体中文)

## English

superstring is a local desktop chat application for ongoing conversations with configurable AI assistants. It brings together conversation history, long-term memory, and adjustable personality settings, with room for both everyday conversation and emotional support.

**Current version:** `0.1.0alpha` · **Package version:** `0.1.0-alpha` · **Target platform:** Windows x64

The interface is in Simplified Chinese.

### What it does

- **Conversations:** stream model replies and keep multiple conversations locally.
- **Assistant settings:** configure assistant names, instructions, local models, and response randomness.
- **Long-term memory:** organize conversation content into memories, review and manage them, and use them across conversations with the same assistant. Different assistants have separate memories.
- **Context management:** configure context budgets and conversation-summary behavior.
- **Personality and persona:** adjust expression style, identity, and conversational boundaries.
- **Appearance:** choose from 16 color themes, with system, light, and dark modes.
- **Desktop entry:** open the application in a browser through a lightweight native Windows launcher.

Multiple configurable assistants are not multi-agent collaboration.

### Install and start

Download `superstring-setup-0.1.0-alpha.exe` from the [latest release](https://github.com/Verdspair/superstring/releases/latest).

1. Run the installer and choose a dedicated installation directory. The suggested location is `D:\superstring`; you may type or browse to another location. If D: is unavailable, the installer looks for another non-system fixed drive, or leaves the field empty for you to choose.
2. Leave **Create a desktop shortcut** checked if you want a desktop entry. A Start Menu entry is created even if you uncheck it. Unchecking does not delete an existing desktop shortcut.
3. Open **superstring** from the desktop, Start Menu, or `superstring.exe` in the installation directory.
4. The launcher starts the local application and opens its browser interface. The default application address is `http://127.0.0.1:17861`.

The installer includes the application runtime and built frontend. End users do not need to install Node.js or Bun. **LM Studio and model weights are not included.**

This alpha build is not digitally signed. The release page lists its SHA-256 checksum.

### Connect a model

1. Install LM Studio separately, choose a model suitable for your hardware, and load it.
2. Start its local model server. superstring's default model endpoint is `http://127.0.0.1:1234/v1`.
3. In superstring, open **Settings → Assistant settings → Name and model** (`设置 → 助手设置 → 名称与模型`), refresh the model list, and select the model for your assistant.
4. Save the settings and start a conversation.

superstring does not start LM Studio, download models, or load a model for you. The application can open without the model service, but generating replies requires an available model. Quality, speed, and memory use depend on the selected model and hardware.

### Your data

Installed copies keep their application files and persistent data under the directory you choose:

```text
<installation directory>/
├── superstring.exe    # Desktop entry
├── app/               # Application resources
├── userdata/          # Database, configuration, and persistent state
├── logs/              # Application logs
├── backups/           # Maintenance backups
└── maintenance/       # Installation and recovery records
```

Some directories are created only when needed. Development runs use a separate layout; these paths describe installed copies.

- Conversations and memories are stored locally. The relevant messages, instructions, summaries, and memories are sent to the configured model service to generate replies or process memory.
- With the default local LM Studio endpoint, that model connection stays on the same machine. If you configure a remote endpoint, submitted content leaves the machine and is subject to that service's policies.
- Treat `userdata`, backups, and logs as private. Do not upload them to a repository or attach them unredacted to issue reports.
- New installations do not automatically import another installation's or a developer's conversations and settings.
- Back up important data with the application fully stopped; do not copy only a live SQLite database file while it may still be writing.

### Updates and shutdown

Updates use a new full installer; there is no in-app automatic downloader. Close superstring before installing into the same directory. Reinstallation, updates, and uninstall keep your data and backups.

The installer refuses unsupported downgrades. An older package named `0.1.0-dev` sorts higher than `0.1.0-alpha` and cannot be replaced by this alpha through the downgrade-protected path.

In desktop mode, closing the last superstring browser page starts an approximately eight-second grace period before the backend shuts down. Refreshing or reopening during that period keeps it alive. Shutdown waits for work to finish or cancel safely, so eight seconds is not a strict deadline. Browser suspension and system sleep may interrupt the connection. The application does not remain in the system tray.

### Build from source

**Verified locally on 2026-09-16:** a fresh exported source tree passed `npm ci`, two complete check/test/build runs, isolated startup checks, installer generation, and isolated installation checks, on Windows x64 with Node.js `22.22.2` and Bun `1.4.2`.

Prerequisites:

- Windows x64.
- Node.js `22.12.0` or later, as declared in `package.json`.
- Project dependencies installed using `package-lock.json`; the project pins Bun `1.4.2` as a development dependency.
- For native launcher and installer builds: the .NET Framework C# compiler and the .NET Framework 4.8 reference assemblies required by the build scripts.
- LM Studio and a loaded model for actual model conversations, not for isolated automated tests.

From the source root, in PowerShell:

```powershell
npm ci
.\start.cmd --check
.\start.cmd
```

`start.cmd` runs the development application, builds the frontend, and opens the browser. Unlike the installed desktop launcher, it is a console development entry; closing the browser does not stop it. Use Ctrl+C in its terminal to request shutdown.

Run the checks and builds separately:

```powershell
npm run check
npm run typecheck
.\node_modules\bun\bin\bun.exe test tests/integration tests/contracts
npm run test:web
npm run build

# Native development launcher
npm run build:desktop

# Full Windows installer
node tools/installer/build-package.mjs
```

Backend tests run under Bun; browser-facing tests run under Vitest. Do not substitute an unqualified `bun test` for the separate test commands. A frontend build alone does not produce a desktop installer.

### Limitations and feedback

- This is a single-user local application, not a hosted multi-user service. Do not expose the application port to the public internet.
- Model output and extracted memories may be incomplete or incorrect. Review important information. superstring is not a medical or mental-health treatment service.
- When reporting a problem, include the application version, Windows version, display scaling, reproduction steps, and redacted error details. Do not include private conversations, database files, credentials, or backups.

### Acknowledgments

Special thanks to my friend [nkanf-dev](https://github.com/nkanf-dev). Without his support and encouragement—especially his help with hardware—I could not have brought this project this far or turned my ideas and dreams into reality.

### License

This project's own code is licensed under the [MIT License](LICENSE). Third-party components keep their respective licenses; collected notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

---

## 简体中文

超弦（superstring）是一款在本机运行的桌面聊天应用，让你与可配置的 AI 助手持续交流。它将会话记录、长期记忆与性格人设放在一起，既可以用于日常聊天，也为情感支持留出空间。

**当前版本：** `0.1.0alpha` · **包版本：** `0.1.0-alpha` · **目标平台：** Windows x64

应用界面为简体中文。

### 已有功能

- **会话交流：** 流式显示模型回复，在本机保存多个会话。
- **助手设置：** 配置助手名称、指令、本地模型与回复随机度。
- **长期记忆：** 将对话内容整理为记忆，查看和管理，并在同一助手的不同会话中使用；不同助手的记忆相互隔离。
- **上下文管理：** 调整上下文预算与会话摘要策略。
- **性格与人设：** 调整表达风格、身份和交流边界。
- **外观：** 16 种配色，以及跟随系统、浅色、深色模式。
- **桌面入口：** 通过轻量原生 Windows 启动器，在浏览器中打开应用。

可配置多个助手不等于多助手协作。

### 安装与启动

从[最新版本](https://github.com/Verdspair/superstring/releases/latest)下载 `superstring-setup-0.1.0-alpha.exe`。

1. 运行安装包，选择专用安装目录。建议位置为 `D:\superstring`，也可以手动输入或浏览选择其他位置。D 盘不可用时，安装器会寻找其他非系统固定盘；没有合适磁盘则留空，由你选择。
2. 如果需要桌面入口，保留默认勾选的“在桌面创建快捷方式”。取消勾选后仍会创建开始菜单入口，也不会删除已有桌面快捷方式。
3. 从桌面、开始菜单，或安装目录中的 `superstring.exe` 打开应用。
4. 启动器会启动本机应用并打开浏览器界面，默认应用地址为 `http://127.0.0.1:17861`。

安装包包含应用运行时和已构建的前端，普通安装用户不需要另外安装 Node.js 或 Bun。**安装包不包含 LM Studio 和模型文件。**

当前 Alpha 安装包尚未数字签名，版本页面提供 SHA-256 校验值。

### 连接模型

1. 单独安装 LM Studio，选择适合电脑配置的模型并加载。
2. 启动其本地模型服务。超弦默认连接 `http://127.0.0.1:1234/v1`。
3. 在超弦中进入“设置 → 助手设置 → 名称与模型”，刷新模型列表，为助手选择模型。
4. 保存设置后开始聊天。

超弦不会替你启动 LM Studio、下载模型或加载模型。模型服务未就绪时仍可打开应用，但生成回复需要可用模型；回复质量、速度和内存占用取决于所选模型及电脑配置。

### 数据保存

安装版的程序文件和持久数据保存在你选择的目录下：

```text
<安装目录>/
├── superstring.exe    # 桌面启动入口
├── app/               # 程序资源
├── userdata/          # 数据库、配置与持久状态
├── logs/              # 应用日志
├── backups/           # 维护备份
└── maintenance/       # 安装与恢复记录
```

部分目录在需要时才会创建。源码开发运行使用另一套目录布局；上述结构仅描述安装版。

- 会话与记忆保存在本机。生成回复或处理记忆时，相关消息、指令、摘要和记忆会发送给配置的模型服务。
- 使用默认的本机 LM Studio 地址时，这条模型连接在同一台电脑内完成。如果配置了远程地址，提交的内容会离开本机，并受该服务的数据政策约束。
- 请把 `userdata`、备份和日志视为私人内容，不要上传到代码仓库，也不要未经脱敏就附在问题反馈里。
- 新安装不会自动导入另一份安装或开发环境中的会话与设置。
- 备份重要数据前应先完整退出应用；数据库仍可能写入时，不要只复制正在使用的 SQLite 主文件。

### 更新与退出

更新通过下载新的完整安装包完成，没有应用内自动下载功能。覆盖安装到原目录前，请先关闭超弦。同版重装、升级和卸载都会保留用户数据与备份。

安装器会拒绝不支持的降级。旧包 `0.1.0-dev` 按语义化版本规则高于 `0.1.0-alpha`，无法通过受降级保护的正常流程直接覆盖为本 Alpha 版本。

桌面模式下，关闭最后一个超弦网页后，会经过约八秒宽限期再退出后台；期间刷新或重新打开页面可以保持连接。退出会等待任务完成或安全取消，因此八秒不是严格截止时间。浏览器挂起和系统休眠也可能中断连接。应用不会常驻系统托盘。

### 从源码运行和构建

**已于 2026-09-16 完成本机验证：** 全新导出的源码在 Windows x64、Node.js `22.22.2`、Bun `1.4.2` 下通过了 `npm ci`、两轮完整检查/测试/构建、隔离启动检查、安装包构建及隔离安装检查。

所需环境：

- Windows x64。
- Node.js `22.12.0` 或更高版本，以 `package.json` 声明为准。
- 根据 `package-lock.json` 安装项目依赖；项目将 Bun `1.4.2` 固定为开发依赖。
- 构建原生启动器与安装包时，需要构建脚本使用的 .NET Framework C# 编译器与 .NET Framework 4.8 引用程序集。
- 实际模型对话需要 LM Studio 和已加载模型；隔离自动化测试不需要。

在源码根目录打开 PowerShell：

```powershell
npm ci
.\start.cmd --check
.\start.cmd
```

`start.cmd` 会运行开发应用、构建前端并打开浏览器。它是控制台开发入口，与安装版桌面启动器不同，关闭网页不会让它自动退出；需要在对应终端按 Ctrl+C 请求停止。

分别执行检查与构建：

```powershell
npm run check
npm run typecheck
.\node_modules\bun\bin\bun.exe test tests/integration tests/contracts
npm run test:web
npm run build

# 原生开发启动器
npm run build:desktop

# 完整 Windows 安装包
node tools/installer/build-package.mjs
```

后端测试由 Bun 执行，浏览器相关测试由 Vitest 执行，不要用不带范围的 `bun test` 替代分开的测试命令。只构建前端不会生成桌面安装包。

### 限制与反馈

- 当前为单用户本机应用，不是多用户在线服务，请勿将应用端口暴露到公网。
- 模型回复及整理出的记忆可能不完整或有误，请核对重要信息。超弦不是医疗或心理治疗服务。
- 反馈问题时，请附应用版本、Windows 版本、显示缩放比例、复现步骤和脱敏后的错误信息。不要附上私人对话、数据库、凭据或备份。

### 特别感谢

特别感谢我的朋友 [nkanf-dev](https://github.com/nkanf-dev)。没有他的支持与鼓励，尤其是在硬件上的支持，我不可能将这个项目推进至今，让自己的想法与梦想成为现实。

### 开源协议

本项目自身代码采用 [MIT 开源协议](LICENSE)。第三方组件遵循各自的许可证，已收集的声明见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。
