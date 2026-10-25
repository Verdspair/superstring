# v0.4.0-alpha-2 — 升级说明 / Upgrade Guide

[简体中文](#简体中文) · [English](#english)

## 简体中文

**版本：** `0.4.0-alpha-2`。**对比基线：** 已发布的 `v0.4.0-alpha-1`。

### 相对 v0.4.0-alpha-1 的变化

| 领域 | v0.4.0-alpha-1 | 0.4.0-alpha-2 |
|---|---|---|
| QQ 自主接话控制 | 缺少触发间隔与排队控制 | 新增触发消息数（默认 15）与扰动量（默认 5）控制，支持忙时排队；可选用连续交谈或自主接话（两者互斥） |
| 聊天记录与任务展示 | 加载旧记录时新消息需等待 | 新消息即时显示不等待旧历史；群聊顶部显示进行中的模型任务，任务结束后更新最终结果 |
| QQ 引用与 @ 成员 | 引用与 @ 依赖兼容处理 | 原生支持消息引用与 @ 成员，两者相互独立，并支持搭配已授权表情 |
| 方案与群配置界面 | 群配置与方案设置入口相对分离 | 整合至方案工作流中，直观管理群专属覆盖项；修复保存状态与草稿处理问题，冲突时保留未保存内容 |
| 桌面应用退出 | 关闭窗口可能残留后台进程 | 关闭桌面主窗口后，Superstring 自行启动的服务与相关进程一起退出 |
| 运行追踪与历史读取 | 存在重复查询 | 优化消息历史、任务与追踪读取，减少重复查询，早期工作区加载更顺畅 |
| 数据库结构 | 结构版本 53 | 结构版本 54（新增接话设置等字段，保持已有数据完整） |

### 升级前准备

1. **完全退出程序**：关闭桌面窗口，并确认退出系统托盘或后台常驻进程。切勿在服务运行时复制或移动数据库文件。
2. **完整备份数据目录**：
   - Windows 安装版：备份安装目录下的整个 `userdata` 文件夹（包含数据库、WAL 文件、加密密钥与配置文件）。
   - macOS / Linux：备份系统应用数据目录。
   - 注意：加密保存的模型与服务凭据依赖同一套密钥文件，备份时必须连同密钥文件一起保存。
3. **保留回退环境**：若需保留回退可能，请妥善保存原 v0.4.0-alpha-1 安装包与升级前的 53 版数据备份。新版数据库无法直接由旧版程序读取。
4. **核对安装包**：下载安装包后，建议使用随发布提供的校验清单（`SHA256SUMS`）核对文件完整性。

### 安装或更新

#### Windows x64

运行对应版本的安装程序，选择现有的安装目录。安装器会识别现有安装，在升级过程中保留 `userdata` 中的用户数据，然后替换程序文件。

#### macOS 与 Linux

0.4.0-alpha-2 随本次 Release 提供各系统架构安装包（Windows 安装程序、macOS DMG/ZIP 与 Linux DEB/AppImage 及校验清单 `SHA256SUMS`）。替换应用前请先完全退出旧版本。原生配置文件保存在系统应用数据目录。macOS 安装包为临时签名（ad-hoc signed，未公证），首次运行请右键选择「打开」。

#### 源码启动

更新源码后，运行 `npm ci` 安装锁定版本的依赖，然后运行 `start.cmd`（Windows）或 `./start.sh`（macOS/Linux）。请保留既有数据路径，不要同时启动多个进程使用同一数据目录。

### 数据库结构与回退

已发布的 v0.4.0-alpha-1 业务结构版本为 **53**，本版本为 **54**。程序启动时会自动执行新增迁移 `0054_qq_initiative_batches.sql`：
- 为自主接话新增触发间隔消息数（默认 15）、扰动量（默认 5）以及忙时排队开关（默认开启）等配置字段；
- 记录自主接话专属的观察进度序号，避免高频群聊频繁发起无效评估；
- 迁移为增量写入，新增接话设置字段，已有聊天记录和配置保留；仍建议先备份。

遇到未知结构或降级尝试时，程序会拒绝启动以保护数据安全。如需回退，必须先完全退出程序，恢复升级前备份的 53 版数据与匹配密钥，再启动 v0.4.0-alpha-1 程序。

#### 当前 main 源码更新

本节针对 main 分支源码，不是新的安装包发布。已发布的 v0.4.0-alpha-2 安装包仍使用结构版本 54；当前源码使用 **72**，新增迁移 0055–0072。

在 QQ 连接设置中切换绑定的 QQ 账号时提供安全检查。若原账号或新账号历史关联的会话中存在正在执行的任务、仍在处理的后台工作、正在发送或发送结果未知的消息，系统会拒绝切换，避免在未结清工作时改变账号归属；相同账号保存、无变更操作或修改普通设置不会误拦截。已部署并明确配置本机运行环境后，可在「方案 → QQ设置 → 连接」启用托管并使用登录看板与二维码；默认关闭，QQ 业务总开关独立。当前 Windows 配置可随桌面启动、正常关窗退出及再次打开自动启动。运行资源目前须手动本机部署，不是通用安装器或随包提供的运行环境。已有 QQ 配置保留，本次托管接通不新增数据库迁移；未部署者仍可使用外部 OneBot 连接。

QQ群聊与私聊现共用会话配置页；已有配置与草稿保留，私聊详细策略默认跟随所选方案，未主动自定义的项目不改写。会话菜单可解除绑定并移除目录入口，不删除Agent、方案或平台聊天。私聊添加需填写联系人的QQ号，不能填写机器人自身账号。这些界面与绑定操作不新增数据库迁移。

聊天记录首次从服务器只读取最新 100 条，点击“加载更早消息”分页查看旧记录；保存的历史不会被删除或截断。新消息仍逐条即时显示，刷新和回复完成保留已加载的旧页及阅读位置。优化消息详情、启动记录核对与权限读取中的重复工作。

模型工具调用会对函数名与请求结构做协议兼容处理，遇到明确的函数调用格式异常时可在现有纠错流程内再试一次；异常调用不执行，已完成的工具操作不重复。持续异常、内容过滤与输出上限仍明确报错。兼容处理不保证每个模型与服务商组合都能完成工具调用。

关闭窗口以外的动效略微加快：启动、最小化与从任务栏还原由 250 毫秒改为 225 毫秒，最大化与取消最大化由 100 毫秒改为 90 毫秒，常见界面过渡约缩短一成；关闭窗口保持 150 毫秒，曲线与形状不变，并继续遵循减少动效偏好。

方案、会话与绑定、QQ 设置现位于同一工作区。系统能力的执行设置可配置调用重试，QQ 设置可单独配置唤醒重试；未配置时分别采用共 3 次尝试／2 秒间隔与共 3 次尝试／15 秒间隔（次数均含首次）。既有 QQ 配置保留，新增系统重试设置不需单独迁移；系统调用重试仅针对明确的 HTTP 429／503 拒收，不盲目重放写操作、超时或结果未知的请求。

QQ 回复现在可自主选择文字、单张表情或组合，并可按方案设置三档表情倾向；群聊与私聊均可在会话配置中覆盖。同任务恢复保留首次领取的档位，新任务读取新的有效配置。全局或本群关闭表情后，尚未开始发送的图片不再发送，合法文字不受影响。0064 新增倾向字段，仅更新逐字等于旧出厂默认的表情提示词；自定义提示词与旧数量存值保留。

自主接话兴趣评分校准将 4–6 分（以 5 分为基准）定为自然轻度参与档，认可接梗与轻松互动，达标后正常承接意图组织回复而不重评开口价值；确实无内容、本群自定义规则禁止、来源失效或已确认送达相同内容时仍保留合理沉默，送达状态未知时不盲目重发同一内容且独立新问题仍可回应。默认门槛（6 分）与既有群配置保持不变，无新增数据库字段。

源码新增独立 QQ 回复任务、方案与会话的任务上限和输入防刷屏设置，并统一静图、动图规格，取消旧补充时间窗。新建方案开启防刷屏，已有方案保持关闭；会话覆盖留空时跟随方案。0065 仅新增防刷屏阈值字段（默认 3 条／3 秒），保留已有开关状态与继承关系。已有记录与其它配置保留，退役媒体设置不再使用。

在模型服务中，支持为 LM Studio 本地模型与外部服务登记的模型选填文本编码（如 `cl100k_base`、`o200k_base`，未指定采用保守估算）；页面提供参考帮助但不自动选择；用量显示实际生效的模型、容量与编码，发生保存冲突时保留草稿。QQ 研究按子任务自己的上下文检查容量；媒体与表情结果装不下时返回明确预算提示，不把本可继续的任务拖到下一轮才失败，仍超限时明确失败。

运行详情界面进一步区分两类看板体验：运行概览聚焦结果与依据，采用竖列步骤卡片展示模型调用，默认选定首个步骤并在下方查看详情；技术追踪面向执行诊断，通过时间线查看顺序、耗时与错误，选中步骤直接联动下方详情，父任务下的实际模型调用也可查看，消除多余的重复列表。两看板选中步骤的输出、输入及关联来源分区清晰列出、输出在最前，各条目默认收起并支持按需独立展开；打开详情时预取当前运行全部实际调用并在内存中共享，预取完成后切换或展开不再发起网络请求（未完成预取时显示加载状态；选中步骤的输入、输出及关联来源展示仍受访问权限与保留期限制，已过保留期或已撤回内容明确标示）。区分模型生成内容与平台送达状态，同一送达结果不重复读取；两看板完整技术追踪与来源记录保持保留。

群聊自主接话与冷场记录只显示已实际开始意图判断的任务，包括判定保持沉默的结果。尚未开始判断的等待或跳过记录不再单独显示；判断状态不明的旧记录、原有消息、直接回应、连续会话、失败取消及原始任务队列与审计如实保留。

程序仅对已知匹配的数据库结构执行增量迁移，遇到未知结构或降级尝试时拒绝启动以保护数据安全。更新源码前请完全退出程序，自行完整备份实际使用的数据目录、配置和匹配密钥（安装版为完整 `userdata`），包括数据库及其 WAL 文件。启动新源码会执行新增迁移。不要用旧程序直接打开已升级的数据库；回退必须恢复升级前备份及匹配程序。

### 建议检查的配置

- **QQ 方案自主接话**：在方案设置中复查自主接话配置。若群聊消息频繁，可根据活跃度调整触发消息数与扰动量，确认忙时排队是否符合预期。
- **群聊消息与进行中任务**：在群聊中确认新消息到达时是否平滑显示，检查顶部模型任务指示与详情展开是否正常。
- **模型服务与图片支持**：模型页只管理连接、目录与容量，不再逐模型开关工具、视觉或沙箱。原生图片被服务明确拒绝时回退文本描述；已知不支持原生图片的模型可选择文本描述模式。沙箱总开关仍在系统执行设置，实际工具授权不变。

---

## English

**Version:** `0.4.0-alpha-2`. **Comparison baseline:** published `v0.4.0-alpha-1`.

### What changes from v0.4.0-alpha-1

| Area | v0.4.0-alpha-1 | 0.4.0-alpha-2 |
|---|---|---|
| QQ Autonomous Participation | Lacked batch triggers and queue controls | Adds trigger message counts (default 15) and jitter (default 5), supports queue-on-busy; choose continuous conversation or autonomous participation (mutually exclusive) |
| Chat History & In-flight Tasks | Incoming messages waited while older history loaded | Fresh messages appear immediately without waiting for older history; running model tasks appear at the top of group chats and update final results upon completion |
| QQ Quotes & Mentions | Handled via compatibility logic | Native message quotes and member mentions, fully independent, with authorized sticker support |
| Scheme & Group Settings | Group settings and schemes accessed separately | Integrated into scheme workflows with clear override tracking; fixed save state and draft handling to keep unsaved changes during conflicts |
| Desktop Application Exit | Closing window could leave lingering background processes | Closing the main desktop window exits background services and processes started by Superstring |
| Runtime Traces & History Reads | Contained redundant queries | Optimized message history, task, and trace reads, reducing redundant queries for smoother workspace loading |
| Database Schema | Schema version 53 | Schema version 54 (adds initiative batch settings while preserving existing data integrity) |

### Before Upgrading

1. **Fully exit the application**: Close the desktop window and ensure system tray icons and background processes are closed. Never copy or move database files while services are running.
2. **Back up your complete data directory**:
   - Windows installer: Back up the entire `userdata` folder under the installation directory (including database, WAL files, encryption keys, and configurations).
   - macOS / Linux: Back up the system application data directory.
   - Note: Encrypted model credentials depend on matching key files; always back up encryption keys together with data files.
3. **Keep rollback assets**: If you wish to retain rollback capability, keep your v0.4.0-alpha-1 installer and a pre-upgrade backup of your schema 53 database and keys. Migrated databases cannot be read by older versions.
4. **Verify installers**: After downloading, verify package integrity against the published checksum list (`SHA256SUMS`).

### Installation and Updates

#### Windows x64

Run the installer for this release and select your existing installation directory. The installer preserves user data in `userdata` while replacing application files.

#### macOS and Linux

0.4.0-alpha-2 packages are provided across architectures (Windows installer, macOS DMG/ZIP, and Linux DEB/AppImage with checksum list `SHA256SUMS`). Fully exit older versions before replacing the application. Profiles reside in system application data directories. macOS packages are ad-hoc signed and not notarized (right-click Open on first launch).

#### Source Launch

Update the source code, run `npm ci` to install pinned dependencies, and launch with `start.cmd` (Windows) or `./start.sh` (macOS/Linux). Retain existing data paths and avoid starting multiple instances against the same data directory.

### Database Schema and Rollback

Known v0.4.0-alpha-1 databases run on schema **53**; this release runs on schema **54**. The application executes additive migration `0054_qq_initiative_batches.sql`:
- Adds configuration fields for autonomous participation: trigger message count (default 15), jitter (default 5), and queue-on-busy (enabled by default);
- Adds an autonomous observation sequence cursor to avoid frequent unnecessary evaluations in busy chats;
- The migration is additive, adding initiative setting fields while preserving existing chat records and configuration; backing up beforehand is still recommended.

Unknown schemas or downgrade attempts are rejected to protect data safety. Rolling back requires fully exiting the application, restoring your matching pre-upgrade schema 53 data and key backup, and launching the v0.4.0-alpha-1 executable.

#### Current source updates on main

This section applies to source code on main, not a new packaged release. The published v0.4.0-alpha-2 packages still use schema 54; current source uses **72**, with migrations 0055–0072.

Switching the bound QQ account in QQ connection settings includes safeguards before changing accounts. If historical sessions associated with either the old or new account contain tasks in progress, ongoing background work, or messages being sent or with unknown delivery results, the switch is refused to avoid changing account ownership while work is outstanding. Same-account updates, no-op saves, and ordinary setting edits are not blocked. After manually deploying and explicitly configuring a local runtime, enable managed mode under **Schemes → QQ settings → Connection** to use the login dashboard and QR codes. It is off by default; the QQ business switch is separate. The current Windows setup starts with the desktop, exits on normal window close, and starts automatically when reopened. Runtime resources currently require manual local deployment, not a universal installer or bundled runtime. Existing QQ configuration is retained; this managed connection update adds no database migration. External OneBot connections remain available without local deployment.

QQ groups and private chats now share one conversation policy editor. Existing configuration and drafts remain; private settings follow the selected scheme unless explicitly overridden. Conversation menus can remove a binding and its directory entry without deleting the Agent, scheme, or platform chat. Enter the contact’s QQ number when adding a private chat, not the bot’s own account. These interface and binding changes add no database migration.

Message history initially reads only the latest 100 records from the server. Use “Load older messages” to page through earlier records; saved history is never deleted or truncated. New messages still appear one by one as they arrive, while refreshes and completed replies retain loaded older pages and the reading position. Reduces repeated work in message details, startup history reconciliation, and permission reads.

Tool calls apply protocol compatibility handling to function names and request structures, and an explicit malformed function-call finish can be retried once through the existing correction flow. Rejected calls are not executed and completed tool actions are not repeated. Repeated failures, content filtering, and output limits remain explicit errors. This adaptation does not guarantee that every model and provider combination can complete tool calls.

Transitions other than closing are slightly faster: startup, minimize, and restore from the taskbar go from 250 to 225 ms, maximize and unmaximize from 100 to 90 ms, and common interface transitions are about 10% shorter. Closing stays at 150 ms, with unchanged curves and shapes, and reduced-motion preferences still apply.

Schemes, Conversations & bindings, and QQ settings now share one workspace. Configure call retries in System capabilities execution settings and wake retries separately in QQ settings. When unconfigured, defaults are 3 attempts with a 2-second delay and 3 attempts with a 15-second delay, respectively; both counts include the first attempt. Existing QQ settings are preserved, and the new system retry settings need no separate migration. System call retries apply only to explicit HTTP 429/503 rejections, without blind replay of writes, timeouts, or requests with unknown outcomes.

QQ replies can now independently choose text, one sticker, or a combination, with three levels of scheme-level sticker guidance. Groups and private chats can override the setting in conversation settings. Resumed tasks retain the value captured at first claim, while new tasks use the new effective setting. Global or group sticker disable blocks unstarted image sends without blocking valid text. Migration 0064 adds the guidance field and updates only sticker prompts that exactly match the old factory default. Custom prompts and stored legacy count values are preserved.

Autonomous participation interest scoring is calibrated with 4–6 (baseline 5) as natural light participation for natural, brief conversation, carrying qualified intent into response generation without judging the same participation decision again; legitimate silence remains intact when content is empty, custom group rules forbid speaking, cited facts expire, or identical content is confirmed delivered, and the Agent avoids blindly resending identical content while delivery status is unknown without barring responses to independent new questions. Default threshold (6) and existing group settings remain unchanged with no schema additions.

Source updates add independent QQ reply tasks, scheme and conversation task limits, and input anti-spam settings. Still images and animations use unified settings, and the old supplement time window is removed. Anti-spam is enabled for new schemes and kept off for existing schemes. Empty conversation overrides follow the scheme. Migration 0065 only adds anti-spam threshold columns (default 3 messages / 3 seconds), preserving existing switch states and inheritance. Existing records and other settings are retained; retired media settings are no longer used.

Model Services supports optional text token encodings (such as `cl100k_base` or `o200k_base`) for LM Studio local models and external services, falling back to conservative estimation when unconfigured. Reference help assists manual verification without auto-selection. Usage details show actual effective model, capacity, and encoding, and unsaved drafts are preserved during save conflicts. QQ research checks capacity against each subtask's own context limit; when media or sticker outputs exceed available space, a clear budget message is returned instead of deferring failures to later turns, and genuine capacity exceedances fail clearly.

Run details refine the experience across both views: the overview focuses on results and evidence, displaying model calls as vertical step cards, selecting the first step by default, and showing its details below; technical traces focus on execution diagnosis, using a timeline to inspect execution order, duration, and errors. Selecting a step links directly to its details below, and real model calls under parent runs can be inspected, removing redundant duplicate step listings. Across both views, outputs, inputs, and associated sources are clearly separated with outputs shown first; all rows start collapsed and expand independently on demand. Real calls for the current run are prefetched and shared in memory on load, so switching or expanding requires no extra network requests once prefetched (loading indicators show while prefetching; displaying selected-step inputs, outputs, and associated sources remains subject to access authorization and retention limits, with expired or revoked content clearly marked). Distinguishes model-generated content from platform delivery confirmation, avoiding duplicate reads for the same delivery result; full technical trace records and associated sources are preserved.

Autonomous-participation and idle-topic records show only tasks that have actually started intent judgement, including decisions to remain silent. Waiting or skipped opportunities that have not yet started judgement are no longer shown separately. Older records with unknown judgement status, original messages, direct responses, continuous conversations, failures, cancellations, and full task queues and audits remain available.

The application executes incremental migrations only on matched known schemas, and refuses to start on unknown schemas or downgrade attempts to protect data safety. Before updating source, fully exit the application and back up the actual data directory, configuration, and matching encryption keys, including the database and its WAL files (the complete `userdata` directory for installed Windows builds). Starting the new source applies added migrations. Do not open an upgraded database with an older executable. Rollback requires the pre-upgrade backup and matching application.

### Configuration Checklist

- **QQ Scheme Autonomous Participation**: Review autonomous participation settings in schemes. If group messages are frequent, adjust trigger counts and jitter, and confirm that queue-on-busy behavior matches your preferences.
- **Group Chats & In-flight Tasks**: Verify smooth updates as new messages arrive and inspect active parent/child tasks in group conversations.
- **Model services and images**: The model page manages connections, catalogs, and capacity, without per-model tool, vision, or sandbox switches. Explicit service rejection of native images triggers a description fallback; use description mode for models known not to accept native images. The global sandbox switch remains in system execution settings, and tool grants still apply.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
