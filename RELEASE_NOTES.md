# 0.4.0-alpha-1

[简体中文](#简体中文) · [English](#english)

## 简体中文

本次预发布版本引入 MCP 外部服务接入、标准技能目录、QQ 消息原生图片输入与结构化回复引用、本群独立配置覆盖，以及持久化任务状态机与本地审批机制。以下变更直接对比已发布的 **v0.3.0-beta**。

### 外部扩展、技能与程序化工具调用

- 支持连接外部 Model Context Protocol（MCP）服务，覆盖 stdio、HTTP 与 SSE 三种传输协议；登记的服务默认未启用，支持配置调用超时与返回结果长度限制，环境变量凭据仅保存变量名。
- 引入标准技能目录，随包提供证据读取、媒体读取、任务执行与网络研究 4 个系统技能。
- 新增网络搜索与网页抓取工具，支持接入 SearXNG 端点与必应搜索通道，网页抓取内置私网地址拦截护栏；该模块默认保持关闭。
- 引入基于 QuickJS WASM 沙箱的程序化工具调用（PTC）模式，支持在本地沙箱中编排与聚合只读工具调用；新增受控只读研究模式（每次运行最多发起 2 个子任务，每个子任务最多执行 6 步）。两项功能默认关闭，代码沙箱需模型服务明确声明具备代码执行能力。

### QQ 消息多模态与回复引用

- 新增原生图片输入（`native`）与文本描述（`description`）双模式，支持将图片传入支持图片的模型；支持在决策、评估与生成三阶段独立控制图片输入；图片资产按范围缓存，支持多分辨率副本与动图抽帧。
- 记录多部件消息事实与回复引用链（`reply_to_message_id`），支持多层按需引用。
- 细化成员身份记录，区分当前群名片与个人昵称，标注来源属于平台原始上报还是本地目录记录。
- 入站媒体转为按需提取，减少无效资源消耗。

### QQ 本群配置与群名管理

- 新增单账号 × 群 × Agent 本群配置页，支持针对特定群覆盖基础方案中的触发、节奏、上下文与提示词等字段。
- 支持针对单个群停用 12 项系统能力，停用即时生效，切换时旧证据永久失效。
- 独立保存 QQ 群原始名称与用户自定义备注名，显示时备注名优先，留空自动回退为群本名；更换绑定或助手不覆盖备注名，支持群名预加载。

### 任务持久化与本地执行审批

- 新增持久化任务状态机，维护排队、运行、等待工具、等待审批、完成、失败与取消等状态，支持任务排队与结果分页。
- 持久化任务中需审批的调用生成审批票据，必须在本地界面手动确认，禁止静默执行。
- 对话工作区整合消息、运行观测与任务三页签，支持在当前会话与全局范围之间切换。

### 运行治理、输出预留与数据保留

- 方案判断与回复两档的输出预留上限由 16384 放宽至 32768，适应长输出调用；默认值仍为 512 与 2048。
- 新增 QQ 数据保留期限设置（1–3650 天，默认仍为 14 天），覆盖消息正文、媒体阅读记录、助手发言、发送台账与昵称；到期数据不可读，物理清理需用户在存储面板手动预览确认。运行追踪的保留天数在「系统能力 → 执行限制」中单独配置。
- QQ 消息水位压缩移入后台任务队列异步执行，主流程无需同步等待压缩完成。
- 引入加密会话快照缓存、空闲分块预加载与 SSE 会话变更流，减少界面重复查询。

### 升级说明

升级前请完整退出程序并备份整个数据目录。已知 v0.3.0-beta 数据库从结构版本 **47 升级至 53**。迁移 0052 会将现有方案的图片模式统一初始化为 `native` 并写入默认消息设置；升级后请检查模型实际图片支持与视觉能力声明，并按需调整方案模式。回退需要旧版程序与**同一套匹配的升级前完整数据备份**。详见 [UPGRADING.md](UPGRADING.md)。

---

## English

This prerelease introduces external Model Context Protocol (MCP) integrations, standard skills, native image input and structured reply quoting for QQ messages, per-group configuration overrides, and a durable task state machine with local approval controls. Changes below compare directly with published **v0.3.0-beta**.

### External Extensions, Skills, and Programmatic Tool Calling

- Connect to external Model Context Protocol (MCP) services across stdio, HTTP, and SSE transports. Registered servers are disabled by default, with configurable timeouts and result size caps; environment variable credentials store variable names rather than secret values.
- Introduce a standard skills catalog with four bundled system skills: evidence reading, media reading, task execution, and web research.
- Add web search and page fetch tools supporting SearXNG endpoints with fallback to Bing; page fetching enforces private network address guards. Disabled by default.
- Introduce Programmatic Tool Calling (PTC) via a QuickJS WASM sandbox to orchestrate and aggregate read-only tool calls locally; add a read-only research mode (up to 2 subtasks per run, up to 6 steps per subtask). Both default to off; code mode requires models with explicit code execution declarations.

### QQ Multimodal Messaging and Reply Quotes

- Add dual-mode image input supporting native multimodal delivery (`native`) and text description extraction (`description`); independent toggles control image input across decision, evaluation, and generation stages; image assets are scoped and cached with multi-resolution variants and animated GIF frames.
- Preserve multi-part segments and structured reply quote chains (`reply_to_message_id`), supporting multi-level quoting.
- Distinguish group cards from personal nicknames in member records, tracking whether names originate from platform wire events or local directory records.
- Inbound media processing shifts from automatic arrival reads to on-demand reading.

### QQ Per-Group Configuration and Group Names

- Add dedicated per-group configuration pages (QQ account × group × Agent) to override triggers, rhythm, context, and prompt fields from base schemes.
- Support disabling 12 individual system capabilities per group with immediate fail-closed enforcement and permanent invalidation of earlier evidence.
- Decouple original QQ group names from custom aliases. Custom aliases take precedence with fallback to group names; aliases survive rebinding, and group names support preloading.

### Durable Tasks and Local Execution Approvals

- Introduce a durable task state machine tracking queued, running, waiting-for-tool, waiting-for-approval, completed, failed, and cancelled states, with lease handling and result paging.
- Task calls requiring approval generate pending tickets that require explicit local confirmation rather than silent execution.
- Consolidate conversation workspaces into three tabs: Messages, Runs, and Tasks, with toggles between conversation and global scopes.

### Runtime Governance, Output Reserves, and Retention

- Expand judgement and reply output reserve limits from 16384 to 32768 to accommodate long model calls; default values remain 512 and 2048.
- Add a QQ data retention setting (1–3650 days, default remains 14 days) covering message text, media reading notes, assistant speech, send ledgers, and nicknames; expired content becomes unreadable, and physical deletion requires manual user preview and confirmation in the storage panel. Telemetry trace retention is configured independently under System capabilities → Execution limits.
- Move QQ watermark compression into a background task queue so the main conversation flow does not wait for compression to settle.
- Introduce encrypted session snapshot caching, idle chunk preloading, and SSE conversation change streams to reduce redundant queries.

### Upgrading

Fully exit the application and back up your complete data directory before upgrading. Known v0.3.0-beta databases migrate from schema **47 to 53**. Migration 0052 initializes existing schemes to `native` image mode and applies default message settings; review actual model image support and vision declarations after updating. Rolling back requires the older application and a **matching pre-upgrade data backup from the same snapshot**. See [UPGRADING.md](UPGRADING.md).

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
