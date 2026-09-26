# v0.3.0-beta — Update guide / 升级说明

[English](#english) · [简体中文](#简体中文)

## English

**Version:** `0.3.0-beta` — prerelease. **Comparison baseline:** published `v0.2.1`.

### What changes from v0.2.1

| Area | v0.2.1 | v0.3.0-beta |
|---|---|---|
| Conversations | Local web chat | Shared workspace for web, QQ private and group conversations, with editable avatars |
| QQ access | No active QQ connection workflow | OneBot 11 transport, Agent bindings, named schemes and per-conversation controls |
| Participation | Replies to web requests | Four independently controlled QQ triggers; initiative uses an interest threshold and final delivery checks |
| Context | Web recent history, summaries and retrieval | QQ judgement/reply windows plus bounded reply-window compression packages |
| Memory | Agent-owned web memory and correction | Visible web/QQ source partitions; conversation-scoped QQ memory and explicit own-private-chat sharing |
| Models | Local OpenAI-compatible service configuration | Registered external providers with credentials, declared capacities and per-task model choices |
| Execution | Web response and task status | Shared Agent actions, run history, causal waterfalls and protected model input/output inspection |
| Desktop | Windows installer; macOS/Linux source launch | Windows installer plus native macOS/Linux packaging and isolated native profiles |
| Navigation | Settings categories and page tabs | Conversations, Agents, Library, Connections and Runs, with Model services and Preferences |

The knowledge library, memory correction, context-usage ring, English/Simplified Chinese and 16 themes already existed in v0.2.1. They continue in the reorganized workspace rather than being introduced again. Saved valid values are retained; upgrading does not automatically enable QQ speech or grant access to imported material.

### Before upgrading

1. Finish or cancel active work and **fully quit the application**, including background mode. Closing only the browser/window may leave the local service running.
2. Back up the complete data directory, including the database, its SQLite sidecars if present, encryption keys, settings and imported materials. Do not make a database-only copy while the service is writing.
3. Keep the v0.2.1 installer and its matching data backup if you may need to roll back. Beta-to-stable version ordering does not make a newer database readable by an older program.
4. Verify the downloaded package against the checksum file supplied with that release.

### Install or update

#### Windows x64

Run `superstring-setup-0.3.0-beta.exe` and choose the existing installation directory. The installer checks the existing layout and version, backs up the closed installation as part of upgrade, and replaces application files without importing a development checkout's data.

Data remains under `userdata` in that installation. The backup of **all of userdata** matters: encrypted credentials cannot be recovered from a database copy alone if its keys are missing.

#### macOS and Linux

Use the release asset matching your operating system and CPU architecture. Quit the application before replacing the macOS app or updating its Linux package. Native profiles use the operating system's application-data directory; they do not automatically discover or migrate data from a source checkout. The prerelease macOS packages are ad-hoc signed and not notarized: open them with the Finder **Open** action (or allow the app under System Settings → Privacy & Security).

See [Desktop distributions](docs/reference/desktop.md) for DMG/ZIP, DEB/AppImage, sandbox requirements and native profile recovery. The Windows installer is not a cross-platform data-transfer tool.

#### Source launch

Update the source, install its pinned dependencies with `npm ci`, then use `start.cmd` or `./start.sh`. Preserve the existing source-mode data and state paths; changing a command-line database path selects another database, not a migration of files. Do not start two processes against the same profile.

### Database and rollback

The published v0.2.1 uses business schema **4**; this version uses **47**. The ordered migration chain handles known schemas and validates structure before proceeding. Unsupported structures or attempts to use an older application with a newer schema are rejected rather than silently rebuilding the database.

For rollback, stop the new application, preserve its current data separately, restore one complete pre-upgrade backup, and launch the corresponding older application. Do not combine a database and encryption keys from different backups.

### Review these settings

- **Model services:** confirm endpoints, model names, context windows and task-specific defaults. If local LM Studio requires a token, set `LM_STUDIO_API_KEY`; credentials for registered external providers are edited in the application.
- **Agents:** check identity, expression, memory/knowledge access and recent context. Model output quality and latency depend on the selected provider and model.
- **Library:** confirm source partitions and knowledge grants. Imported sticker collections need review, enablement and scheme authorization before they can be used.
- **Connections:** install a QQ client and an OneBot 11 service separately (the validated combination is NapCat v4.18.28 with QQ 9.9.26.44343; see [README.md](README.md)), then bind a QQ conversation to an Agent and scheme. Enable only the triggers you want. A direct response bypasses interest scoring but still permits the Agent to choose silence.
- **Preferences:** check language, appearance and supported desktop close behavior. Choose background mode only if connected Agents should stay online after the window closes.

Image descriptions require a configured vision model. Voice transcription and full-video understanding remain unavailable. QQ automation may be limited by the platform or account; do not treat an active transport connection as a guarantee of delivery.

---

## 简体中文

**版本：** `0.3.0-beta`，预发布版。**对比基线：** 已发布 `v0.2.1`。

### 相对 v0.2.1 的变化

| 方面 | v0.2.1 | v0.3.0-beta |
|---|---|---|
| 对话 | 本地网页聊天 | 网页、QQ 私聊与群聊共用工作区，可编辑会话头像 |
| QQ 接入 | 没有可用的 QQ 连接流程 | OneBot 11 连接、Agent 绑定、命名方案和会话级控制 |
| 发言 | 响应网页请求 | 四种 QQ 触发独立控制，主动发言受兴趣门槛与提交检查约束 |
| 上下文 | 网页近期原文、摘要与检索 | 新增 QQ 判断／回复窗口及回复档上下文压缩包 |
| 记忆 | Agent 所属网页记忆与纠正 | 可见的网页／QQ 来源分区，QQ 会话级隔离与本人私聊显式共享 |
| 模型 | 本地 OpenAI 兼容服务配置 | 登记外部服务、凭据、容量，并按用途选择模型 |
| 执行检查 | 网页响应与任务状态 | 统一 Agent 动作、运行记录、因果瀑布与受来源授权保护的模型输入输出 |
| 桌面 | Windows 安装器，macOS/Linux 源码启动 | 保留 Windows 安装器，新增原生 macOS/Linux 打包与独立资料目录 |
| 导航 | 设置分类和页签 | 对话、Agent、资料、接入、运行，另设模型服务与偏好 |

知识库、记忆纠正、上下文用量圆环、中英界面与 16 种主题在 v0.2.1 已有，本次保留并整合到新工作区，不重复列为新增。有效的已有设置继续保留；升级不会自动开启 QQ 发言，也不会自动授权已导入资料。

### 升级前

1. 完成或取消在途任务，**完整退出应用**，包括后台模式。只关闭浏览器或窗口可能不会停止本地服务。
2. 备份整个数据目录，包括数据库、存在的 SQLite 附属文件、加密密钥、设置和导入素材；不要在服务写入时只复制数据库文件。
3. 如需回退，保留 v0.2.1 安装包及其匹配的数据备份；版本排序正确不代表旧程序能读新结构数据库。
4. 使用所选版本附带的校验清单核对下载文件。

### 安装或更新

#### Windows x64

运行 `superstring-setup-0.3.0-beta.exe`，选择现有安装目录。安装器检查布局与版本，在升级流程中备份已关闭的安装内容，再替换程序文件；不会从开发目录导入资料。

数据仍位于该安装目录的 `userdata`。备份**完整 userdata** 很重要：只留数据库而丢失对应密钥，不能恢复加密保存的凭据。

#### macOS 与 Linux

使用版本页面中匹配系统与处理器架构的文件，替换 macOS 应用或更新 Linux 包前先退出。原生资料目录使用系统应用数据位置，不会自动发现或搬迁源码目录中的旧数据。本预发布版的 macOS 包为临时签名、未公证：首次打开请用访达的「打开」放行（或在「系统设置 → 隐私与安全性」中允许）。

DMG/ZIP、DEB/AppImage、沙箱要求与资料恢复见[桌面发行说明](docs/reference/desktop.md)。Windows 安装器不是跨平台数据搬迁工具。

#### 源码启动

更新源码后运行 `npm ci` 安装锁定依赖，再运行 `start.cmd` 或 `./start.sh`。保留现有源码模式数据与状态路径；指定另一数据库路径是在选择另一数据库，不是在搬迁文件。不要同时让两个进程使用同一资料目录。

### 数据库与回退

已发布 v0.2.1 的业务结构版本为 **4**，本版为 **47**。程序按顺序处理已知迁移，并在继续前验证结构；未知结构、旧程序打开新结构等情况会拒绝执行，不会静默重建数据库。

需要回退时，停止新程序，单独保存其当前数据，恢复一份完整的升级前备份，再使用与备份对应的旧程序。不要混用不同备份的数据库与加密密钥。

### 建议检查的配置

- **模型服务**：核对端点、模型名、上下文容量和各用途默认模型。本地 LM Studio 需要 token 时设置 `LM_STUDIO_API_KEY`；外部服务凭据在应用内修改。
- **Agent**：检查身份、表达、记忆／知识读取权限与近期上下文配置。输出质量和延迟仍取决于所选模型与服务商。
- **资料**：核对来源分区和知识授权；导入的表情集合需检查、启用并授权给方案后才能使用。
- **接入**：需单独安装 QQ 客户端与 OneBot 11 服务（已验证组合为 NapCat v4.18.28 与 QQ 9.9.26.44343，见 [README.md](README.md)），再将 QQ 会话绑定到 Agent 和方案，只开启需要的触发。直接回应无需兴趣评分，但仍允许 Agent 选择沉默。
- **偏好**：检查语言、外观与支持的桌面关闭行为；只有希望关窗口后保持在线时才选择后台模式。

图片描述需要配置视觉模型；语音转写和完整视频理解仍未开放。QQ 自动化可能受平台或账号限制，连接就绪不等于消息一定送达。

---

## Thanks / 致谢

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。
