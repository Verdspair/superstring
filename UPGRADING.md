# v0.4.0-alpha-2 — 升级说明 / Update guide

[简体中文](#简体中文) · [English](#english)

## 简体中文

**版本：** `0.4.0-alpha-2`。**对比基线：** 已发布 `v0.4.0-alpha-1`。

### 相对 v0.4.0-alpha-1 的变化

| 方面 | v0.4.0-alpha-1 | 0.4.0-alpha-2 |
|---|---|---|
| QQ 自主接话与批量评估 | 上一版没有这些分批计数及忙时排队控制 | 新增自主接话分批控制，统一构造批量消息并全批共享上下文来源，保留容量约束，超限时明确拒绝 |
| 会话新消息与运行观测 | 旧历史读取期间新消息显示可能等待 | 新消息无需等待旧历史加载完成即时呈现，不打乱已有滚动位置；群聊消息顶部展示进行中父任务并可查看子任务详情 |
| QQ 原生提及与引用段 | 内部记录引用事实，投递段处理依赖兼容逻辑 | 用户提及与回复引用原生转换为 OneBot at 与 reply 消息段；支持独立提及元数据与仅提及回复，元数据挂载于首个实际投递部件 |
| 扩展技能与回复规范 | 随包提供系统技能 | 新增随包内置的 `speech.reply` 技能规范，明确回复中引用、提及与表情字段的交互约定（声明不越权授予外部工具） |
| 方案与群配置界面 | 本群配置与全局方案入口相对分离 | 群配置整合至方案工作流中，直观展示群绑定状态、覆盖项与继承关系，改善保存时状态与草稿处理，发生冲突时不会意外覆盖 |
| 桌面端生命周期与退出 | 关闭窗口包含进程等待逻辑 | 关闭窗口直接结束程序自有进程树；常规服务停机仍先取消任务、处理在途写入并安全关闭数据库 |
| 运行追踪与历史读取 | 运行追踪与历史读取存在重复查询 | 优化消息历史、任务与追踪读取，减少重复查询，加载更及时 |
| 业务数据库结构 | 结构版本 53 | 结构版本 54（新增迁移 `0054_qq_initiative_batches.sql`） |

网页与 QQ 共享统一 AgentRuntime、因果瀑布追踪、上下文裁剪与多模态图片双模式在 v0.4.0-alpha-1 中已经具备，本次更新聚焦于自主接话分批与预算估算修正、会话实时更新与任务可视化、原生提及/引用段投递，以及桌面端退出生命周期的明确化。

#### 新增功能

- **QQ 自主接话分批与忙时排队**：新增自主接话分批计数控制（目标消息步长默认为 15，随机扰动量默认为 5，约束扰动量小于目标数）及忙时排队开关（默认开启）；会话新增自主接话独立的观察边界序列号（`chiming_in_observed_seq`），不与直接回应的消费边界混用，避免高频群聊频繁发起无效评估。
- **会话新消息即时呈现**：旧历史读取期间，新到达的消息无需等待更早历史加载完成即可即时显示，无需手动刷新页面，已加载的内容与用户当前滚动位置保持不变。
- **群聊模型任务可视化观测**：群聊消息时间线上方直观展示正在进行中的模型父任务状态（任一子任务处于运行状态即保持活跃指示）；点击父任务可打开详情，点击某个子任务查看该项详情，并在其结束时更新一次，不会预先拉取所有子任务正文。
- **QQ 原生提及与引用段投递**：用户提及与回复引用原生转换为 OneBot 协议的 `at` 与 `reply` 消息段；支持独立提及元数据（包括仅提及回复），元数据挂载于首个实际投递部件（支持纯表情或纯提及回复）。
- **内置 QQ 回复技能规范**：新增随包内置的 `speech.reply` 技能规范，明确终态回复中引用、提及与表情字段的交互约定（声明不越权授予外部工具）。
- **并发投递状态恢复与保存草稿保护**：优化并发投递时的事务提交与状态恢复逻辑；改善方案与群配置保存时的状态与草稿处理，发生冲突时不会意外覆盖。

#### 原有功能改进

- **修正批量判断预算估算与重复来源开销**：由同一批量消息构造器统一计算窗口拟合与实际发送请求，完整冻结来源列表全批共享一次，避免重复复制；评分专属信息不进持久视图，回复子运行仅继承 reply 视图，避免批量评估裁剪影响回复工具预算。保留容量限制与原有裁剪顺序，超限时在模型调用前明确拒绝，不增加总容量配额，不引入自动重试或额外压缩。
- **方案与群配置界面整合**：将本群覆盖设置融入方案工作流，统一群绑定与方案管理入口，直观查看群专属覆盖项与继承状态。
- **桌面端退出生命周期明确**：关闭桌面窗口会直接结束程序自有进程树；常规服务停机仍先取消任务、处理在途写入并安全关闭数据库。
- **运行观测与历史查询优化**：优化消息历史、任务与追踪读取，减少重复查询，加载更及时；优化早期工作区加载可用性。

#### 升级前准备

1. 结束所有活跃会话，**完整退出程序**，包括系统托盘与后台常驻进程。切勿在服务运行时备份或复制数据库文件。
2. 完整备份数据目录。Windows 安装版请备份安装目录下的整个 `userdata` 文件夹（包含数据库、WAL 附属文件、加密密钥文件、素材与配置）；原生 macOS/Linux 请备份对应的应用数据目录。加密保存的凭据必须依赖同一套匹配的密钥文件才能读取。
3. 若需保留回退可能，请妥善保存 v0.4.0-alpha-1 安装包与升级前结构版本 53 的数据备份。新版数据库无法直接由旧版程序读取。
4. 使用对应发布的校验文件核对下载的安装包。

#### 安装或更新

##### Windows x64

运行对应版本的安装程序，选择现有的安装目录。安装器会识别现有安装布局与版本，在升级过程中备份现有内容，然后替换程序文件。用户数据保留在 `userdata` 中，不会自动导入开发目录数据。

##### macOS 与 Linux

0.4.0-alpha-2 随本次 Release 提供各系统架构安装包（Windows 安装程序、macOS DMG/ZIP 与 Linux DEB/AppImage 及校验清单 `SHA256SUMS`）。下载后替换应用前必须先完整退出旧版本。原生配置文件保存在系统应用数据目录，不会自动导入源码目录数据。平台安装指南、签名公证细节与沙箱要求见[跨平台桌面打包](tools/desktop/build/cross-platform/README.md)。

##### 源码启动

更新源码后，运行 `npm ci` 安装锁定版本的依赖，然后运行 `start.cmd`（Windows）或 `./start.sh`（macOS/Linux）。请保留既有数据路径，不要同时启动多个进程使用同一数据目录。

#### 数据库结构与回退

已发布的 v0.4.0-alpha-1 业务结构版本为 **53**，本版本为 **54**。程序按顺序执行新增迁移 `0054_qq_initiative_batches.sql`：
- 为 `qq_schemes` 增加 `initiative_batch_target_count`（整数，默认 15，约束大于等于 1）；
- 为 `qq_schemes` 增加 `initiative_batch_jitter_count`（整数，默认 5，约束大于等于 0 且小于目标步长）；
- 为 `qq_schemes` 增加 `initiative_queue_on_busy`（整数，默认 1，仅取 0 或 1）；
- 为 `conversations` 增加 `chiming_in_observed_seq`（整数，默认 0）。

迁移 0001 至 0053 与已发布版本完全一致，仅 0054 为新增。遇到未知结构或降级尝试时，程序会拒绝迁移，不会静默重建数据库。如需回退，必须先退出程序，单独保存当前数据，恢复同一套匹配的升级前结构版本 53 数据与密钥备份，再启动 v0.4.0-alpha-1 程序。

#### 建议检查的配置

- **QQ 方案与自主接话分批**：复查方案中的自主接话设置。若群聊消息频繁，可根据群活跃度适当调整目标步长与扰动量，确认忙时排队是否符合预期。
- **群聊消息与任务观测**：在群聊中确认新消息到达时是否平滑更新，检查顶部模型任务指示与详情展开是否正常。
- **模型服务与图片支持**：复查模型服务配置与视觉能力声明。使用原生图片输入需确认模型实际支持图片输入；不支持的模型请使用文本描述模式（`description`）。

语音转写与完整视频理解在此版本中仍未开放。QQ 自动化受到平台规则与账号状态约束，连接正常不代表消息一定送达。

---

## English

**Version:** `0.4.0-alpha-2`. **Comparison baseline:** published `v0.4.0-alpha-1`.

### What changes from v0.4.0-alpha-1

| Area | v0.4.0-alpha-1 | 0.4.0-alpha-2 |
|---|---|---|
| QQ Spontaneous Participation & Batching | Earlier release lacked batch count and queue-on-busy controls | Adds spontaneous participation batch controls, building batch messages with shared sources, preserving capacity limits and rejecting genuine overflow |
| Live Messages & Task Observability | Incoming messages could wait while older history records were loading | Fresh messages appear immediately without waiting for older history to load, keeping scroll position undisturbed; active parent model tasks appear at the top of group chats |
| QQ Native Mentions & Quotes | Records quote facts internally with delivery handled via compatibility logic | User mentions and reply quotes convert natively to OneBot at and reply segments; supports independent mention metadata, attaching metadata to the first delivered part |
| Extensions & Reply Contract | Bundles system skills | Adds bundled `speech.reply` skill specification clarifying reply contracts for quotes, mentions, and stickers without escalating tool permissions |
| Scheme & Group Directory UI | Group configuration pages kept relatively distinct from schemes | Integrates group settings into the scheme workflow with clear visibility of binding states and inheritance, improving save and draft handling to prevent accidental overwrites |
| Desktop Lifecycle & Shutdown | Window close included lingering process wait logic | Closing the window directly terminates the application-owned process tree; standard service stops continue to cancel active tasks, settle in-flight writes, and close the database safely |
| Trace & History Reads | Redundant queries during trace and history reads | Optimizes message history, task, and trace reads, reducing redundant queries and improving load responsiveness |
| Database Schema | Schema version 53 | Schema version 54 (adds migration `0054_qq_initiative_batches.sql`) |

Shared AgentRuntime across Web and QQ, causal waterfall tracing, context trimming, and dual-mode multimodal image support were introduced in earlier releases. This update focuses on spontaneous participation batching, corrected budget estimation, live conversation updates and task inspection, native mention/quote delivery, and desktop lifecycle clarity.

#### New Features

- **QQ Spontaneous Participation Batching & Queue on Busy**: Introduces batch message count controls (target count defaults to 15, jitter count defaults to 5 with jitter constrained below target) alongside a queue-on-busy switch (enabled by default); tracks observation progress with a dedicated sequence boundary (`chiming_in_observed_seq`) separate from direct response consumption, avoiding redundant evaluations in busy group chats.
- **Immediate Live Message Presentation**: Freshly arrived messages appear immediately without waiting for older history pagination to complete, leaving loaded content and scroll position undisturbed.
- **Group Chat Model Task Observability**: Displays active model parent tasks directly above group chat message history whenever any child task is running; selecting a parent task opens investigation details, and selecting a child task inspects its detail and refreshes upon completion, without eagerly prefetching all child payloads.
- **Native QQ Mentions & Reply Quotes**: Transforms user mentions and reply quotes directly into native OneBot `at` and `reply` message segments; supports independent mention metadata and mention-only replies, attaching metadata to the first delivered carrier part (supporting sticker-only or mention-only replies).
- **Built-in QQ Reply Skill Specification**: Adds the bundled `speech.reply` skill specification, defining clear contracts for quotes, mentions, and stickers without granting unauthorized external tools.
- **Concurrent Delivery Recovery & Draft Save Protection**: Refines transactional commit and state recovery during concurrent delivery; improves state and draft handling during scheme and group editing, preventing accidental overwrites when editing across tabs.

#### Improvements

- **Corrected Batch Judgement Budget Estimation & Shared Sources**: Calculates window fitting and wire requests using the same batch message builder, sharing the frozen context source list once across all targets instead of duplicating it; excludes score-specific context from durable views and restricts child reply runs to reply views. Preserves capacity limits and original trimming order, explicitly rejecting requests before model calls when exceeding limits, without inflating total capacity, adding automatic retries, or extra compression.
- **Integrated Scheme & Group Configuration UI**: Incorporates per-group overrides into the scheme workflow, consolidating group binding management and clarifying override inheritance.
- **Explicit Desktop Lifecycle & Exit**: Closing the desktop window directly terminates the application-owned process tree; standard service stops continue to cancel active tasks, settle in-flight writes, and close the database safely.
- **Trace Observability & History Query Optimization**: Optimizes message history, task, and trace reads, reducing redundant queries and improving workspace responsiveness.

#### Before Upgrading

1. Stop all active sessions and **fully exit the application**, including system tray icons and background processes. Never copy database files while the service is running.
2. Back up your complete data directory. On Windows, back up the entire `userdata` folder under the installation directory (including database, WAL files, encryption key files, assets, and configs); on native macOS/Linux, back up the corresponding application data directory. Encrypted credentials require matching key files to remain readable.
3. Keep your v0.4.0-alpha-1 installer and a pre-upgrade backup of your schema 53 database if you wish to retain rollback capability.
4. Verify downloaded installers against the published checksum list (`SHA256SUMS`).

#### Installation and Updates

##### Windows x64

Run the installer for this release and select your existing installation directory. The installer detects the existing setup, backs up application files, and replaces them. User data in `userdata` is preserved.

##### macOS and Linux

0.4.0-alpha-2 packages are provided across architectures (Windows installer, macOS DMG/ZIP, and Linux DEB/AppImage with checksum list `SHA256SUMS`). Fully exit older versions before replacing the application. Profiles reside in system application data directories. Platform guides, signing status, and sandbox details are documented in [Desktop packaging](tools/desktop/build/cross-platform/README.md).

##### Source Launch

Update the source code, run `npm ci` to install pinned dependencies, and launch with `start.cmd` (Windows) or `./start.sh` (macOS/Linux). Retain existing data paths and avoid starting multiple instances against the same data directory.

#### Database Schema and Rollback

Known v0.4.0-alpha-1 databases run on schema **53**; this release runs on schema **54**. The application executes additive migration `0054_qq_initiative_batches.sql`:
- Adds `initiative_batch_target_count` (integer, default 15, minimum 1) to `qq_schemes`;
- Adds `initiative_batch_jitter_count` (integer, default 5, minimum 0 and strictly less than target) to `qq_schemes`;
- Adds `initiative_queue_on_busy` (integer, default 1, restricted to 0 or 1) to `qq_schemes`;
- Adds `chiming_in_observed_seq` (integer, default 0) to `conversations`.

Migrations 0001 through 0053 match earlier releases. Unknown schemas or downgrade attempts are rejected without silent database destruction. Rolling back requires stopping the application and restoring a **matching pre-upgrade schema 53 data and key backup** before launching v0.4.0-alpha-1.

#### Configuration Checklist

- **QQ Schemes & Batch Controls**: Review spontaneous participation settings. Adjust target counts and jitter if message frequency warrants, and ensure busy queue behavior matches your expectations.
- **Group Chats & Task Observability**: Verify smooth updates as new messages arrive and inspect active parent/child tasks in group conversations.
- **Model Services & Vision Support**: Review configured model endpoints and vision declarations. Ensure models used with native image mode genuinely support visual inputs; switch to description mode (`description`) for text-only models.

Speech transcription and full-video understanding remain unavailable in this release. QQ automation is subject to platform rules and account status; an active connection does not guarantee message delivery.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
