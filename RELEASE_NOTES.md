# v0.4.0-alpha-2

[简体中文](#简体中文) · [English](#english)

## 简体中文

本次更新主要调整 QQ 回复、聊天记录和桌面退出行为。以下为相对 v0.4.0-alpha-1 的变化。

### QQ 自主接话与上下文预算

- 群聊自主接话增加分批控制：支持设置触发间隔消息数（默认 15 条，扰动范围 5 条）与忙时排队开关（默认开启），避免群聊消息密集时频繁发起无效判断。
- 修正批量判断时的上下文估算，减少重复来源的预算开销；真正超出模型容量的请求仍会在调用前明确拒绝。

### 聊天记录与进行中任务

- 加载聊天记录时，新消息不再等旧记录读完才显示，保持当前阅读位置不受影响。
- 群聊顶部显示正在进行的模型任务。点开任务可查看子任务执行情况与模型输入输出，任务结束后会更新最终结果。

### QQ 消息引用与 @ 成员

- QQ 回复可以引用指定消息、@ 成员或搭配表情，引用和 @ 互不绑定（例如支持仅 @ 不引用的回复）。
- 内置「QQ回复」技能，明确回复中引用、@ 成员与表情的使用规则，发送表情需在对应方案中授权。

### 桌面应用退出

- 关闭桌面窗口后，Superstring 自行启动的服务和相关进程一起退出。

### 方案与群配置

- 群专属设置直接整合进方案工作流，方便查看群绑定状态与覆盖项。
- 修复保存过程中状态与草稿处理的问题，冲突时保留未保存内容，避免意外覆盖。

### 升级说明

升级前请完全退出程序并备份数据目录。业务数据库从结构版本 **53 升级至 54**（新增迁移 `0054_qq_initiative_batches.sql`）。回退需要旧版程序与**同一套匹配的升级前结构版本 53 数据与密钥备份**。详见 [UPGRADING.md](UPGRADING.md)。

---

## English

This release focuses on QQ replies, chat history, and desktop exit behavior. Changes below compare directly with v0.4.0-alpha-1.

### QQ Autonomous Participation and Context Budget

- Added batch controls for autonomous participation: configure target message counts (default: 15 messages, with jitter of 5) and queue-on-busy options (enabled by default) to prevent frequent unnecessary evaluations in active chats.
- Corrected context estimation for batch evaluations to reduce redundant source overhead; requests that genuinely exceed model limits are still rejected before calling the model.

### Chat History and In-flight Tasks

- Fresh messages appear right away without waiting for older history pages to finish loading, keeping your current scroll position.
- In-flight model tasks appear directly above group chat messages. Click a task to view subtasks and model inputs/outputs; the final result updates upon completion.

### QQ Message Quotes and Member Mentions

- QQ replies can now quote messages, @ members, or include stickers. Quotes and mentions are independent (for example, you can @ a member without quoting a message).
- Includes a built-in "QQ reply" skill defining how quotes, mentions, and stickers interact; sending stickers still requires authorization in the chat scheme.

### Desktop Application Exit

- Closing the desktop window exits the services and related processes started by Superstring.

### Scheme and Group Settings

- Group-specific overrides are now integrated directly into scheme settings, making bindings and override inheritance easy to inspect.
- Fixed state and draft handling during save conflicts, keeping unsaved changes to prevent accidental overwrites.

### Upgrading

Fully exit the application and back up your data directory before updating. The database schema upgrades from **53 to 54** (via migration `0054_qq_initiative_batches.sql`). Rolling back requires the older application executable and a matching pre-upgrade schema 53 database and key backup. See [UPGRADING.md](UPGRADING.md) for details.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
