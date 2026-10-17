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

### 当前 main 源码更新（非安装包发布）

以下功能属于 main 源码更新，未重发 v0.4.0-alpha-2 安装包。

- **自主文字与表情回复**：Agent 可选择纯文字、单张表情或图文组合。只发文字时无需额外声明不用表情。方案可设置较少使用、平衡选择或积极考虑三档表情倾向，默认平衡；本群可覆盖，私聊跟随方案。这是软倾向，不是发送比例或次数限制。
- **表情关闭即时生效**：关闭全局或本群表情后，尚未开始发送的表情（含排队部件）不再发送，合法文字照常。已开始的请求不撤回，未知送达结果不盲目重发。回复仍至多一张表情，旧数量控件退役但不重写已保存值。

- QQ 艾特与合法引用助手消息的请求可独立执行；每会话艾特／普通任务上限默认 4／1（1–64）。全局／每服务模型请求上限另行配置，默认 4／2（1–256），同时生效。
- 输入防刷屏默认对新方案开启、对已有方案关闭。同成员首条起 3 秒内至少 3 条纯图片消息按一个候选处理，他人插话不打断；自动排除的图片仍可按需读取，直接请求不受分组等待影响。
- 所有图片类别共用静图与动图规格，取消单独表情画质和补充时间窗；图片设置收敛为基本／高级，保留自定义阶段。
- 保存普通 QQ 方案设置时不再误中断正在执行的回应任务；进行中的任务保留原有配置，后续新任务采用新设置；会话暂停与权限停用仍立即生效。
- 较新回复确认后，已被完整覆盖的旧自主回复提前停止；多成员任务只跳过已覆盖成员，不同艾特任务保持独立。
- 聊天记录加载失败后重试拉取最新页，不从最早记录重新开始。
- 修正 QQ 表情回复的输出规则冲突；错误的表情写法不会发送，并可在现有步骤限制内纠正后继续回复。
- **模型编码**：在模型服务 → LM Studio 本地编码或外部服务登记模型时可选填文本编码（如 `cl100k_base`、`o200k_base`），未指定时采用保守估算；提供参考帮助与来源说明但不自动选择；用量显示实际生效的模型、容量与编码；保存发生冲突时保留当前草稿。
- **QQ 研究与工具结果**：研究模式按子任务自己的上下文检查容量；媒体或表情结果装不下时返回明确的预算提示，不把本可继续的任务拖到下一轮才失败；仍超出容量时明确失败。
- **运行详情与追踪排版**：易读概览聚焦结果与依据，采用竖列步骤卡片选择单步并在下方展示详情；技术追踪面向过程与诊断，采用单一时间线联动查看选中步骤详情，去除时间线与下方详情列表的重复展示；两看板选中步骤条目均为独立展开的列表行且默认收起，输出、输入与其他关联来源分区清晰、输出在最前；运行详情加载时自动预取内容，读取完成后，展开不再发起网络请求（已过保留期或已撤回的内容明确标示相应保留状态）；完整技术追踪记录与来源保留。步骤详情直接展示原始 `finish_reason`、HTTP 状态码和流式 `[DONE]` 标记，多次请求分别列出，未返回原因、显式 `null`、无 HTTP 响应和历史未记录分别显示，方便排查调用失败。
- **自主任务记录**：自主接话与冷场任务在开始意图判断后显示，包括选择沉默的结果。不再单独展示尚未判断的等待或跳过记录；判断状态不明的旧记录、原有消息、任务队列和技术追踪保持可见。
- 当前源码数据库结构为 71；旧安装包仍为 54。更新前完整备份，回退时恢复匹配的升级前数据与程序。

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

### Current source updates on main (not a packaged release)

These features are source updates on main. The v0.4.0-alpha-2 packages have not been reissued.

- **Independent text and sticker replies**: The Agent can choose text, one sticker, or a combination. Text-only replies need no extra sticker opt-out. Schemes offer low, medium, or high sticker-use guidance, defaulting to medium; groups can override it, while private chats follow the scheme. This is a soft preference, not a sending ratio or count limit.
- **Immediate sticker disable**: Turning off global or group stickers blocks unstarted sticker sends, including queued parts, without blocking valid text. Started requests are not withdrawn, and unknown delivery results are not blindly retried. Replies still allow at most one sticker. The old count control is retired without rewriting stored values.

- QQ mentions and valid replies to assistant messages run as independent tasks. Per-conversation mention and ordinary task limits default to 4 and 1 (range 1–64). Global and per-service model request limits are configured separately, default to 4 and 2 (range 1–256), and both apply.
- Input anti-spam is enabled for new schemes and kept off for existing schemes. At least three image-only messages from one sender within three seconds of the first form one candidate; other senders do not break it. Excluded images remain readable on demand, and direct requests do not wait for grouping.
- All image categories share still-image and animation settings. Separate expression quality settings and supplement time windows are removed. Basic and advanced image settings retain custom stage choices.
- Saving standard QQ scheme settings no longer mistakenly interrupts an in-flight reply task; running tasks retain their original configuration and new tasks apply updated values. Conversation pauses and permission changes still take effect immediately.
- After a newer reply is confirmed, fully covered autonomous replies stop early. Multi-member tasks skip only covered members, and separate mention tasks remain independent.
- Chat history load failures retry from the newest page instead of restarting from the earliest records.
- Fixed conflicting output rules for QQ sticker replies. Invalid sticker output is not sent and can be corrected within the existing step limit before the reply continues.
- **Model encodings**: Optionally select text token encodings (such as `cl100k_base` or `o200k_base`) when configuring LM Studio local models or external services under Model Services; falls back to conservative estimation when unspecified. Reference help and documentation links assist verification without auto-selection. Usage details show the actual effective model, capacity, and encoding, and unsaved drafts are preserved if save conflicts occur.
- **QQ research and tool results**: Research runs check capacity against each subtask's own context limit; when media or sticker results exceed the available window, a clear budget message is returned instead of postponing failures to subsequent turns, with requests that genuinely exceed capacity failing clearly.
- **Run details and trace layout**: Run overviews focus on results and evidence, presenting vertical step cards to select an individual step and inspect its details below; technical traces focus on process diagnosis, linking a unified timeline directly to selected step details without redundant item listings; entries across both boards are independent expandable rows that start collapsed, with outputs, inputs, and associated sources clearly separated and outputs first; content is prefetched when run details load, and once reading completes, expanding toggles the display without additional network requests (expired or revoked content clearly reflects its retention state). The full technical trace record and its sources are preserved. Steps directly display raw `finish_reason`, HTTP status codes, and streaming `[DONE]` markers; multiple requests are listed separately, with missing reasons, explicit `null`, no HTTP response, and historical calls without records shown as distinct states to help diagnose failed calls.
- **Autonomous task records**: Autonomous-participation and idle-topic tasks appear once intent judgement starts, including decisions to remain silent. Waiting or skipped opportunities that have not been judged are no longer shown separately. Older records with unknown judgement status, messages, task queues, and technical traces remain available.
- Current source uses schema 71; existing packages still use schema 54. Make a full backup before updating, and restore matching pre-upgrade data and executables when rolling back.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
