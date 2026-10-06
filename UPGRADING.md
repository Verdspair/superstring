# 0.4.0-alpha-1 — 升级说明 / Update guide

[简体中文](#简体中文) · [English](#english)

## 简体中文

**版本：** `0.4.0-alpha-1`。**对比基线：** 已发布 `v0.3.0-beta`。

### 相对 v0.3.0-beta 的变化

| 方面 | v0.3.0-beta | 0.4.0-alpha-1 |
|---|---|---|
| 统一工作区 | 网页与 QQ 共用工作区，消息时间线与单次运行记录 | 工作区整合消息、运行观测与任务三页签；可切换全局或当前会话范围 |
| 扩展与工具 | 仅内置基础动作 | 新增 MCP 外部服务接入、技能目录与随包系统技能；联网搜索与网页提取（默认关闭） |
| 代码与研究 | 无代码执行与独立研究子任务 | 新增基于 QuickJS WASM 的程序化工具调用（默认关闭）；受控只读研究子任务（默认关闭） |
| QQ 图片输入 | 入站图片文本描述 | 原生图片输入（`native`）与文本描述（`description`）双模式；按需读取与图片资产缓存 |
| QQ 消息与引用 | 单段消息记录，单一历史昵称 | 多部件消息事实，支持多层回复引用；区分当前群名片与个人昵称，标记来源属于平台原始上报还是本地记录 |
| QQ 本群配置与群名 | 仅支持全局方案与列表派生群名 | 支持单账号 × 群 × Agent 独立方案覆盖与本群系统能力停用；QQ 群本名与用户自定义备注解耦独立保存 |
| 任务与审批 | 动作在单次运行内联执行，无独立任务状态 | 持久化任务状态机，支持任务排队与结果分页；需审批的任务调用需本地手动确认 |
| 数据保留与治理 | 固定 14 天到期常量与基础清理 | QQ 保留期限可配置为 1–3650 天（默认仍为 14 天）；五类数据分页管理并支持清理预览与在用保护（运行追踪保留独立配置） |
| 模型输出预留 | 方案判断与回复输出预留上限为 16384 | 方案输出预留上限放宽至 32768（默认值仍为 512 与 2048） |
| 业务数据库结构 | 结构版本 47 | 结构版本 53（新增迁移 0048 至 0053） |

网页与 QQ 共享统一 AgentRuntime、因果瀑布追踪、上下文裁剪与水位包压缩在 v0.3.0-beta 中已经存在，本次更新聚焦于工具扩展、任务持久化、多模态输入与群级配置。

#### 新增功能

- **MCP 外部服务接入**：支持通过 stdio、HTTP 与 SSE 协议连接外部 Model Context Protocol 服务。登记的服务默认未启用，支持配置调用超时与结果长度限制。环境变量凭据仅保存变量名，不回传敏感内容。
- **技能目录与随包系统技能**：引入标准技能目录，随包提供证据读取、媒体读取、任务执行与网络研究 4 个系统技能。
- **联网工具**：新增网络搜索与网页抓取工具。支持 SearXNG 端点与必应备用搜索通道；网页抓取按字符分页，内置私网地址拦截护栏。该模块默认关闭，需显式开启并授权。
- **程序化工具调用（PTC）与只读研究**：新增基于 QuickJS WASM 沙箱的代码执行模式，用于在本地编排只读工具调用；新增受控只读研究模式（每次运行最多发起 2 个子任务，每个子任务最多执行 6 步）。两项功能默认均保持关闭，代码模式仅在模型服务明确声明具备代码执行能力时生效。
- **QQ 原生图片输入双模式**：QQ 消息支持将图片原生传入视觉模型，或使用视觉模型提取文本描述；支持在决策、评估与生成三阶段独立控制图片输入。图片资产按范围缓存，支持生成多分辨率副本与动图抽帧。
- **QQ 多部件消息与回复引用**：记录有序消息片段与回复引用链（`reply_to_message_id`），支持多层按需引用。群成员记录区分群名片与个人昵称，标注来源属于平台原始上报还是本地目录记录。
- **QQ 本群配置与系统能力停用**：支持按 QQ 账号 × 群 × Agent 维度配置本群专属参数，覆盖基础方案中的触发、节奏、上下文与提示词等字段；支持针对单个群停用 12 项系统能力，停用即时生效，切换时旧证据永久失效。
- **QQ 群名与自定义备注**：独立维护 QQ 群原始名称与用户自定义备注名，显示时备注名优先，留空自动回退为群本名；更换绑定或助手不会丢失备注名，支持群名预加载。
- **持久化任务与本地审批**：新增持久化任务状态机，支持任务排队、租约管理与结果分页。「扩展 → 工具」中的工具授权经批准后持续生效，修订变更时需重新确认；持久化任务中需审批的调用会生成等待审批票据，必须在本地界面手动确认，禁止静默执行。

#### 原有功能改进

- **输出预留上限放宽**：方案判断与回复两档的输出预留上限由 16384 放宽至 32768，适应长输出调用。两档默认值仍保持 512 与 2048 不变。
- **QQ 数据保留期限可配置**：QQ 保留期限由固定 14 天改为 1–3650 天可配置（默认仍为 14 天）。同一设置覆盖消息正文、媒体阅读记录、助手发言、发送台账与昵称 5 类数据。新写入数据按当前设置计算到期时间，已有记录的到期时间保持不变；数据到期后变为不可读，物理清理需用户在存储面板手动预览确认，处于运行中、待审批或状态未知的受保护记录不会被清除。运行追踪与任务负载的保留天数在「系统能力 → 执行限制」中单独配置，两者互不影响。
- **后台任务队列压缩**：QQ 消息水位压缩任务从会话主流程同步等待移出，改由后台任务队列异步排队执行，主流程不再阻塞等待压缩完成。
- **运行数据管理面板**：扩展运行追踪数据管理，支持按类别查看数据占用并手动预览确认清理。
- **页面加载与缓存优化**：增加加密会话快照缓存，支持空闲分块预加载与 SSE 会话变更流，减少界面重复查询。

#### 升级前准备

1. 结束所有活跃会话，**完整退出程序**，包括系统托盘与后台常驻进程。仅关闭窗口可能导致本地服务继续运行。
2. 完整备份数据目录。Windows 安装版请备份安装目录下的整个 `userdata` 文件夹（包含数据库、WAL 附属文件、加密密钥文件、素材与配置）；原生 macOS/Linux 请备份对应的应用数据目录。切勿在服务运行时仅复制单个数据库文件；加密保存的凭据必须依赖同一套匹配的密钥文件才能读取。
3. 若需保留回退可能，请妥善保存 v0.3.0-beta 安装包与升级前的数据备份。新版数据库无法直接由旧版程序读取。
4. 使用对应发布的校验文件核对下载的安装包。

#### 安装或更新

##### Windows x64

运行对应版本的安装程序，选择现有的安装目录。安装器会识别现有安装布局与版本，在升级过程中备份现有内容，然后替换程序文件。用户数据保留在 `userdata` 中，不会自动导入开发目录数据。

##### macOS 与 Linux

0.4.0-alpha-1 已随本次 Release 提供各系统架构安装包（Windows 安装程序、macOS DMG/ZIP 与 Linux DEB/AppImage 及校验清单 `SHA256SUMS`）。下载后替换应用前必须先完整退出旧版本。原生配置文件保存在系统应用数据目录，不会自动导入源码目录数据。平台安装指南、签名公证细节与沙箱要求见[桌面发行说明](docs/reference/desktop.md)。

##### 源码启动

更新源码后，运行 `npm ci` 安装锁定版本的依赖，然后运行 `start.cmd`（Windows）或 `./start.sh`（macOS/Linux）。请保留既有数据路径，不要同时启动多个进程使用同一数据目录。

#### 数据库结构与回退

已发布的 v0.3.0-beta 业务结构版本为 **47**，本版本为 **53**。程序按顺序执行新增迁移（0048 至 0053）：
- **迁移 0052** 会将**全部已有方案**的图片模式统一初始化为 `native`（三阶段全开，最多 8 张原图），并将消息设置初始化为默认配置（按需引用、2 层深度、混合时间显示、Asia/Shanghai 时区）。
- **迁移 0051** 为现有群绑定播种本群配置记录，镜像保留原绑定的四个触发开关。
- **迁移 0049** 重建输出预留列，保留用户原有配置值，仅放宽校验上限。

遇到未知结构或降级尝试时，程序会拒绝迁移，不会静默重建数据库。如需回退，必须先退出程序，单独保存当前数据，恢复同一套匹配的升级前数据与密钥备份，再启动 v0.3.0-beta 程序。

#### 建议检查的配置

- **模型服务与图片输入**：检查外部模型服务配置。使用原生图片输入需确认模型实际支持图片输入，并检查其视觉能力声明：未声明时程序仍会尝试发送原生图片；模型明确拒绝图片时会自动回退文本描述并记录负缓存（非所有网络错误均自动回退）；若模型不支持图片，请明确声明关闭视觉能力或选用文本描述模式（`description`）并配置视觉描述模型，请勿对不支持的模型虚标支持。使用代码沙箱需服务明确声明代码执行能力。
- **QQ 方案与图片模式**：复查各方案与各群绑定的图片模式。迁移已将存量方案设为 `native`，若绑定的模型不支持视觉输入，请切换回文本描述模式（`description`）。
- **扩展与系统能力**：检查 MCP 服务连接配置与技能目录。代码沙箱（QuickJS）、只读研究子任务与网络访问工具默认均处于关闭状态，请按需在系统能力页开启并配置执行限额。
- **数据保留**：检查 QQ 设置与运行数据面板中的保留期限（默认 14 天），确认符合本地存储管理要求。

语音转写与完整视频理解在此版本中仍未开放。QQ 自动化受到平台规则与账号状态约束，连接正常不代表消息一定送达。

---

## English

**Version:** `0.4.0-alpha-1`. **Comparison baseline:** published `v0.3.0-beta`.

### What changes from v0.3.0-beta

| Area | v0.3.0-beta | 0.4.0-alpha-1 |
|---|---|---|
| Workspace | Web and QQ conversations in a shared workspace with timeline messages and single-run inspection | Three integrated workspace tabs: Messages, Runs, and Tasks; switchable between global and conversation scopes |
| Extensions & Tools | Built-in basic actions only | MCP external service client, skills catalog with 4 bundled system skills; web search and page fetch (default off) |
| Code & Research | No code execution or dedicated research subtasks | Programmatic Tool Calling via QuickJS WASM (default off); controlled read-only research subtasks (default off) |
| QQ Image Input | Inbound image text descriptions | Dual-mode image input: native multimodal (`native`) and text description (`description`); on-demand reading and asset caching |
| QQ Messages & Quotes | Single-segment message records, single legacy nickname | Multi-part message facts, multi-level reply quote chains; distinct group card and personal nicknames with source tracking (platform wire vs local directory) |
| QQ Group Config & Names | Shared global schemes only; group title derived from conversation list | Per-group overrides (account × group × Agent) with capability disabling; decoupled group names and custom aliases |
| Tasks & Approvals | Inline execution within a single run; no durable task state machine | Durable task state machine with queuing and result paging; task calls requiring approval require local confirmation |
| Retention & Storage | Fixed 14-day expiry constant and basic cleanup | QQ retention period configurable (1–3650 days, default 14); categorized paging with preview and in-use protection (telemetry retention configured separately) |
| Output Reserve Caps | Cap of 16384 for scheme judgement and reply output reserve | Cap expanded to 32768 for judgement and reply output reserve (defaults remain 512 and 2048) |
| Database Schema | Schema version 47 | Schema version 53 (new migrations 0048 through 0053) |

A unified AgentRuntime, causal waterfall traces, context trimming, and watermark compression packages already existed in v0.3.0-beta. This release focuses on tool extensibility, durable task state, multimodal input, and per-group configuration governance.

#### New Features

- **MCP External Service Integration**: Connect to external Model Context Protocol services over stdio, HTTP, and SSE transports. Registered servers are disabled by default, with configurable timeouts and result size caps. Environment variable credentials store variable names rather than secret values.
- **Skills Catalog & Bundled System Skills**: Standard skills catalog with four bundled system skills: evidence reading, media reading, task execution, and web research.
- **Web Access Tools**: Web search and page fetch capabilities. Supports SearXNG endpoints with fallback to Bing; page fetching pages content by character count with private network address guards. Disabled by default.
- **Programmatic Tool Calling (PTC) & Read-Only Research**: Optional QuickJS WASM sandbox execution for orchestrating read-only tool calls locally; controlled read-only research mode (up to 2 subtasks per run, up to 6 steps per subtask). Both default to off; code mode requires models with explicit code execution declarations.
- **QQ Image Input Dual Modes**: Send images directly to vision-capable models (`native`) or extract text descriptions (`description`); independent toggles across decision, evaluation, and generation stages. Image assets are scoped and cached with multi-resolution variants and animated GIF frames.
- **QQ Multi-Part Messages & Reply Quotes**: Structured message facts with multi-part segments and reply quote chains (`reply_to_message_id`) supporting multi-level quoting. Member records distinguish group cards from personal nicknames, tracking whether sources originate from platform wire events or local directory records.
- **QQ Per-Group Configuration & Capability Disabling**: Dedicated settings for each QQ account × group × Agent combination, allowing sparse overrides of base schemes; supports disabling 12 individual system capabilities per group with immediate fail-closed effect and permanent invalidation of earlier evidence.
- **QQ Group Names & Custom Aliases**: Independent tracking of original QQ group names and user custom aliases. Custom aliases take precedence with fallback to group names; rebinding does not overwrite aliases, and group names support preloading.
- **Durable Tasks & Local Approvals**: Durable task state machine supporting queuing, lease management, and result paging. Tool authorizations under Extensions → Tools remain active once approved until revisions change; task calls requiring approval generate pending tickets that require manual local confirmation.

#### Improvements

- **Expanded Output Reserve Caps**: Judgement and reply output reserve limits expanded from 16384 to 32768 to accommodate long model calls. Default values remain 512 and 2048.
- **Configurable QQ Data Retention**: QQ retention period configurable between 1 and 3650 days (default remains 14 days). Covers message text, media reading notes, assistant speech, send ledgers, and nicknames. Newly written rows apply the configured expiry window, while existing rows retain their timestamps; expired content becomes unreadable, and physical deletion requires manual user preview and confirmation, protecting running, pending, or unknown execution states. Telemetry trace retention is configured independently under System capabilities → Execution limits.
- **Background Task Queue Compression**: Watermark compression runs asynchronously in a background task queue so the main conversation flow no longer blocks waiting for compression to settle.
- **Runtime Storage Management Panel**: Storage telemetry inspection and manual cleanup panel; previews storage usage by category and protects active, pending, or unknown execution states from deletion.
- **Page Caching & Preloading**: Encrypted session snapshot caching, idle chunk preloading, and SSE conversation change streams reduce redundant interface queries.

#### Before Upgrading

1. Stop active conversations and **fully exit the application**, including the system tray and background processes. Closing only the window may leave the background service running.
2. Back up the complete data directory. On Windows, back up the `userdata` directory inside your installation folder (including database, WAL sidecar files, encryption keys, assets, and settings). On macOS and Linux, back up your native application data directory. Do not copy only the `.sqlite` file while the service is running; encrypted credentials require the matching key files from the same backup.
3. Keep your v0.3.0-beta installer and pre-upgrade backup if rollback capability is needed. A newer database schema cannot be read by an older application.
4. Verify downloaded installation packages against the checksum list provided with the release.

#### Installation and Updates

##### Windows x64

Run the installer for your target release and select your existing installation directory. The installer detects existing layouts and versions, creates a backup during the upgrade, and updates application files. User data remains in `userdata` and development checkout data is not imported.

##### macOS and Linux

Release 0.4.0-alpha-1 attaches distribution assets for each supported system and architecture (Windows installer, macOS DMG/ZIP, Linux DEB/AppImage, and `SHA256SUMS`). Fully exit the application before replacing the app or package. Native profiles use system application data paths and do not migrate data from source checkouts. See [Desktop distributions](docs/reference/desktop.md) for sandbox requirements, signing, and notarization details.

##### Source Launch

Update your repository, install pinned dependencies with `npm ci`, and run `start.cmd` (Windows) or `./start.sh` (macOS/Linux). Preserve existing data paths and do not run multiple processes against the same database directory.

#### Database Schema and Rollback

Published v0.3.0-beta uses schema **47**; this release uses schema **53**. Migrations 0048 through 0053 are applied in order:
- **Migration 0052** initializes the image mode of **all existing schemes** to `native` (all three stages enabled, up to 8 original images), and populates default message settings (on-demand quotes, depth 2, hybrid time display, Asia/Shanghai timezone).
- **Migration 0051** seeds per-group configuration rows for existing bindings, mirroring earlier trigger flags.
- **Migration 0049** rebuilds output reserve columns, preserving saved values while raising the CHECK constraint cap.

Unsupported database structures or downgrade attempts are rejected without migration. To roll back, exit the application, set aside current data, restore a complete matching pre-upgrade data and key backup, and launch v0.3.0-beta.

#### Configuration Checklist

- **Model Services and Image Input**: Verify declared model capabilities. To use native image input, confirm that your model actually supports images and review its vision declaration: undeclared models still attempt native delivery; when a model explicitly rejects images, the host falls back to text descriptions and caches the failure for the current process (network failures do not trigger fallback); if a model lacks vision capabilities, explicitly disable vision or select description mode (`description`) rather than falsely declaring vision support. Programmatic tool calling requires an explicit code execution declaration.
- **QQ Schemes & Image Modes**: Review image input modes across schemes and group bindings. Because migration 0052 initializes existing schemes to `native`, switch models lacking vision capabilities back to `description` mode.
- **Extensions & Permissions**: Review MCP server registrations and skills. QuickJS code mode, read-only research, and web access are disabled by default; enable them and configure limits under System capabilities as needed.
- **Data Retention**: Confirm that retention windows in QQ settings and Runtime storage (default 14 days) match your local operational requirements.

Speech transcription and full-video understanding remain unavailable. QQ automation is subject to platform and account policies; active transport connections do not guarantee delivery.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
