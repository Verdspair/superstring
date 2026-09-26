# v0.3.0-beta

[English](#english) · [简体中文](#简体中文)

## English

This prerelease expands the local chat application into an Agent workspace with QQ conversations, connected execution records and native desktop package targets. Changes below compare with the published **v0.2.1**, not intermediate development builds.

### QQ conversations and proactive participation

- Connect a OneBot 11 WebSocket service and bind QQ groups or private chats to Agents and shared, named chat schemes.
- Control direct responses, follow-up conversation, spontaneous participation and idle-topic initiation separately. Initiative uses a configurable interest threshold; a trigger is not a promise that the Agent will speak.
- Configure reply grouping, timing, per-conversation module switches and attention lists. Edit the scheme's seven prompt roles without changing another binding's history.
- Keep judgement and reply context windows separate. Older reply-window messages accumulate into bounded compression packages rather than being summarized on every wake.
- Import, review, enable and authorize sticker collections; send text, a sticker or both. Supported image descriptions and sampled animated-image frames can inform replies.

### Unified workspace and execution inspection

- Web, private-chat and group conversations share a conversation workspace, with persistent custom or generated avatars.
- Agents can read authorized memory and knowledge before answering through a common action loop. Recipients, access checks and delivery remain controlled by the application.
- A dedicated Runs workspace groups model calls and related tasks into execution waterfalls. Inspect the actual model input and output while the referenced sources remain available and authorized, and distinguish generation from confirmed delivery.
- The interface is reorganized around Conversations, Agents, Library, Connections and Runs, with separate Model services and Preferences. Existing English/Simplified Chinese and 16-theme appearance settings remain available.

### Memory and model services

- Manage web and QQ memories through visible source partitions. QQ scopes remain isolated by conversation and bound Agent; sharing with your own private chat is explicit.
- Register external OpenAI-compatible model services, credentials and model capacities alongside local LM Studio models. Choose models by task and inspect their availability from Model services.
- Improve compatibility with providers that differ in structured-output and native-tool-call support. Invalid model output remains visible as a coded failure instead of being mistaken for a successful action.
- Preserve valid settings and data when upgrading; existing memory correction and knowledge authorization continue to apply.

### Desktop platforms

- Add native macOS and Linux desktop packaging, menu/tray integration, profile isolation and an authenticated local backend; retain the Windows C# launcher and installer.
- Keep supported desktop sessions online in the background when selected, and wait for owned service work to settle on explicit exit.
- Add migration-time profile backups to native macOS/Linux startup. Installation and data paths are documented in [Desktop distributions](docs/reference/desktop.md).

Use the architecture-specific assets actually attached to the release. Model servers, model weights and the QQ service are separate installations.

### Reliability

- Improve long-lived streaming connections and recovery of interrupted work.
- Enforce source access and revision checks when inspecting stored model inputs or using retrieved material.
- Keep delivery failures and unknown receipts distinguishable, without blindly resending uncertain messages.

### Upgrading

Fully exit the application and back up the complete data directory before upgrading. A known v0.2.1 database upgrades from schema **4 to 47**, preserving application data; unsupported structures and downgrades are rejected. A rollback requires the older application **and its matching pre-upgrade data backup**. See [UPGRADING.md](UPGRADING.md).

---

## 简体中文

本次预发布将本地聊天应用扩展为支持 QQ 会话、执行追踪与原生桌面分发的 Agent 工作区。以下变化直接对比已发布的 **v0.2.1**，不把开发过程中的修修补补列为独立新功能。

### QQ 会话与主动参与

- 连接 OneBot 11 WebSocket 服务，将 QQ 群和私聊绑定到 Agent 与可复用的命名聊天方案。
- 分别控制直接回应、连续交谈、自主接话和冷场发起；主动参与使用可配置的兴趣门槛，触发唤醒不代表一定发言。
- 配置回复分组、节奏、会话级模块开关与关注名单；编辑方案的七类提示词，不改变其他绑定的历史。
- 区分判断与回复上下文窗口；回复窗口外的旧消息达到水位后压成有限数量的上下文包，不在每次唤醒时重复摘要。
- 导入、检查、启用并授权表情集合，支持文字、表情或混合发送；可将受支持图片与动图抽帧的描述用于回复。

### 统一工作区与执行检查

- 网页、私聊与群聊共用会话工作区，支持持久保存上传或生成的会话头像。
- Agent 可先读取已授权的记忆和知识，再通过共同的动作循环决定回答；收件人、授权复查与投递仍由程序控制。
- 新增运行工作区，将模型调用和关联任务汇总为执行瀑布；来源仍有效且授权可读时，可检查实际模型输入输出，并区分生成完成与平台确认送达。
- 界面按对话、Agent、资料、接入、运行组织，模型服务和偏好单独设入口；保留简体中文／English 与 16 主题外观配置。

### 记忆与模型服务

- 以可见来源分区统一管理网页与 QQ 记忆；QQ 仍按会话和绑定 Agent 隔离，与本人私聊共享须显式开启。
- 在本地 LM Studio 之外登记外部 OpenAI 兼容模型服务、凭据与容量；在模型服务页选择各用途模型并查看可用状态。
- 改善不同服务的结构化输出与原生工具调用兼容性；不合要求的模型输出仍以明确错误码记录，不伪装成成功动作。
- 升级保留有效配置与数据；已有的记忆纠正、知识授权规则继续生效。

### 桌面平台

- 新增原生 macOS/Linux 桌面打包、菜单与托盘、资料目录隔离和本地后端鉴权；Windows 保留 C# 启动器与安装器。
- 支持按偏好关闭窗口后继续后台在线；明确退出时等待所管理的服务完成安全收尾。
- 原生 macOS/Linux 启动在需要迁移时先备份资料目录；安装方式与数据位置见[桌面发行说明](docs/reference/desktop.md)。

请使用版本页面实际附带的对应架构文件；模型服务、模型文件与 QQ 接入服务均需另行安装。

### 稳定性

- 改善长连接流式对话与中断任务的恢复。
- 在查看保存的模型输入、使用检索资料时，复查来源权限与修订状态。
- 区分投递失败与回执未知，不对不确定送达盲目重发。

### 升级

升级前完整退出应用，并备份整个数据目录。已知 v0.2.1 数据库从结构版本 **4 升级到 47**，保留应用数据；不支持的结构与降级会被拒绝。回退需要旧程序和**匹配的升级前数据备份**，不能只替换程序文件。详见 [UPGRADING.md](UPGRADING.md)。

---

## Thanks / 致谢

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。
