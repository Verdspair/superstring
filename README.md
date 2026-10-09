<p align="center">
  <img src="src/shared/brand/superstring.svg" width="88" alt="Superstring logo">
  <br>
  <img src="src/shared/brand/superstring-wordmark.svg" width="420" alt="Superstring">
</p>

# Superstring

本地 Agent 工作区，主要用于日常陪伴与聊天，支持网页对话、QQ 群聊与私聊、记忆、知识库、MCP 工具扩展与技能管理。
A local Agent workspace primarily for everyday companionship and chat, supporting web conversations, QQ groups and private chats, memory, knowledge, MCP tools, and skills.

**版本：** `0.4.0-alpha-2` · **Version:** `0.4.0-alpha-2`

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 有上下文的对话工作区

在同一工作区管理网页对话、QQ 群聊和私聊。选择 Agent，配置身份与模型，按需授权读取记忆和文档。模型、提示词和聊天行为都可以按自己的习惯灵活配置。会话记录、配置和导入资料保存在本机；调用外部模型服务时，仅在请求中包含所需的上下文。界面支持 简体中文与 English 切换。

Superstring 运行在本地，支持 Windows、macOS 与 Linux。会话记录、配置、长期记忆与密钥保存在本机，不提供云端数据同步服务，也不要求注册云端账号；调用已配置的模型服务商或工具服务时，仅按已授予的权限将必要的上下文与参数发送至对应端点。

### 愿景与说明

这是我的个人项目，出发点是实现日常陪伴，一起聊天、一起玩耍。

未来希望它能逐步连接更多游戏与虚拟世界，融入更多互动场景。这是正在探索的长期愿景，当前版本尚未开放外部游戏连接。

目前体验可能不如成熟的同类商业产品。欢迎提出反馈与建议，也请在使用中多一些耐心。

### QQ 群聊与私聊

连接独立运行的 OneBot 11 WebSocket 服务（例如 NapCat），再将群或私聊绑定到 Agent 与聊天方案。

新消息到达已绑定的会话时直接显示。加载聊天记录时，新消息不再等旧记录读完才显示，保持当前阅读位置不受影响。群聊顶部显示正在进行的模型任务，点开任务可查看子任务及模型输入输出详情，任务结束后会更新最终结果。

- 可选用连续交谈或自主接话（两种模式互斥）。直接回应与冷场发起可分别配置，直接回应不要求兴趣评分，Agent 仍可保持沉默。自主接话可按消息条数（默认15±5）或经过时间（默认60±20秒）择机判定，新方案默认开启时间窗口，忙时可排队。窗口参数和待发送回复的有效期都可调整，回复有效期默认10分钟。
- 设置主动开口门槛、安静时间、冷却、活跃时段与回复分组。QQ 回复可在当前授权范围内引用消息、@ 成员或搭配表情。引用和 @ 相互独立，表情需由方案授权。
- 编辑方案的场景、判断、回复、复核、表情、媒体与压缩提示词。多个绑定可复用同一方案，不会因此共享会话历史。
- 分别配置判断和回复窗口。超出回复窗口的消息进入缓冲队列，达到阈值后在后台任务队列压缩为上下文包；判断阶段不读取这些包。
- QQ 群名称与用户自定义备注名解耦独立保存。设置自定义备注时优先显示备注，未设置时显示 QQ 原群名，均无则显示群号；支持群名预加载，更换绑定或助手不会丢失备注名。
- 支持在会话卡片和群会话顶部随时启用或停用群发言。停用后群消息照常接收保存，Agent 不发言且不产生新模型任务。

**本群配置**已整合至方案与群目录中，为特定群提供独立的个性化设置与覆盖项。参与、回应、上下文、媒体与提示词可跟随共享方案或保存为本群覆盖值；换绑不继承覆盖值，切回时自动恢复。页面支持针对单个群停用系统能力，停用即时生效。

QQ 接入前置步骤与运行要求：

1. 安装 QQ NT 客户端并登录。QQ 需保持登录在线；QQ 与 OneBot 实现的版本配套以上游说明为准（见 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases)；NapCat v4.18.28 与 QQ 9.9.26.44343 为过去曾验证过的组合，非官方支持列表或最新测试结论）。
2. 安装 OneBot 11 实现（例如 [NapCat](https://github.com/NapNeko/NapCatQQ) 作为已验证参考，程序不排斥其他 OneBot 11 实现，但不保证全部兼容）。以 NapCat Shell 包为例：在 Windows 上解压并运行 `launcher.bat`（Windows 10 运行 `launcher-win10.bat`），按控制台输出打开 WebUI 面板。
3. QQ 客户端与 NapCat 各自保持常驻运行。在 NapCat WebUI 中确认 QQ 处于登录在线状态，开启**正向 WebSocket 服务端**并设置访问令牌，记录连接地址与端口（WebUI 能打开不代表 QQ 已登录或 WebSocket 服务已就绪）。
4. 在 Superstring 的**方案**页进入 QQ 连接设置，填写 WebSocket 地址（同机部署填 `ws://127.0.0.1:端口/`，跨机部署填实际可达地址）、访问令牌与 Agent 账号（填写机器人 QQ 号，非 Superstring 助手 ID），勾选「启用 QQ」并保存；再将群或私聊绑定到 Agent 与方案。

运行与连接说明：
- Superstring 作为客户端主动连接上游 OneBot 正向 WebSocket 服务，不内置、不拉起，也不停止 QQ 或 NapCat 进程。QQ 客户端与 NapCat 需在后台独立保持运行。
- Superstring 不代登录 QQ，自动化受到平台规则与账号状态约束，建议使用测试账号并妥善保管端点与凭据。
- 连接就绪不代表消息一定送达；连接断开时保持 QQ 与 NapCat 正常运行，程序会间隔重试连接，不承诺立即恢复连接或补发遗漏回复。

### 多模态与媒体处理

- **图片输入双模式**：支持原生图片输入（`native`）与文本描述（`description`）双模式。原生模式将图片直接传入支持视觉的模型；描述模式调用已配置的视觉模型提取文字描述。可在决策、评估与生成三阶段独立控制图片输入；不支持原生图片的模型可使用描述模式，模型明确报错不支持图片时也会回退提取描述并记录负缓存（非所有网络错误均自动回退）。图片描述完成后直接提供文字结果，较长内容可继续读取。
- **图片缓存与准备**：图片资产按范围缓存，支持预生成多分辨率副本与动图抽帧；入站媒体按需读取，减少不必要的资源消耗。
- **结构化回复记录**：记录多部件消息与回复引用链，支持按需多层引用；成员记录区分群名片与个人昵称，标注来源属于平台原始上报还是本地目录记录。
- **表情素材管理**：导入表情素材，编辑说明与标签，经检查启用后授权给方案；支持文字、表情或图文混合回复。
- **输出预留上限**：方案判断与回复输出预留上限最高可设为 32768，适应长输出调用；默认值保持 512 与 2048 不变。
- **QQ 数据保留期限**：支持配置 QQ 数据保留期限（1–3650 天，默认 14 天），覆盖消息正文、媒体阅读记录、助手发言、发送记录与昵称。到期内容不可读；物理清理需在存储面板中手动预览确认。运行追踪的保留天数在「系统能力 → 执行限制」中独立配置，两者互不影响。

### 统一 Agent 内核、扩展与工具

导航包含**对话、Agent、系统能力、方案、资料、扩展** 6 个主入口，另设**模型服务**与**偏好**入口。

- **工作区整合**：对话工作区整合消息、运行状态与任务三页签，支持在当前会话与全局范围之间切换。
- **系统能力分类**：按资料读取、联网、QQ、任务执行和外置扩展查看相关工具、技能与 MCP，点击进入功能配置或组件详情。记忆查询页可编辑检索提示词与每档相关性要求。
- **QQ 群成员查询**：助手可按需查看当前群的成员 ID、昵称、群名片和群主／管理员／成员身份，包括自己；支持查找、筛选和按需详情。普通聊天不查询，同轮名单复用；平台未提供的信息明确标为未知。开关在系统能力配置，各群可单独停用。
- **扩展与 MCP 客户端**：在「扩展 → 工具」中查看已注册的系统工具与外部 MCP 工具；支持通过 stdio、HTTP 与 SSE 连接外部 Model Context Protocol 服务，登记的服务默认未启用，支持配置超时与结果限额；环境变量凭据仅保存变量名。
- **技能目录**：在「扩展 → 技能」中查看技能文档与随包提供的 6 个系统技能（证据读取、媒体读取、QQ成员查询、QQ回复、任务执行、网络研究）。
- **程序化工具调用（PTC）**：基于 QuickJS WASM 沙箱的可选执行模式，支持在本地沙箱中编排与聚合只读工具调用；默认关闭，仅在模型服务明确声明具备代码执行能力时生效。
- **联网工具与只读研究**：支持网络搜索（SearXNG 端点与必应备用通道）与带私网拦截护栏的网页提取；支持受控只读研究模式（每次运行最多发起 2 个子任务，每个子任务最多执行 6 步）；默认均保持关闭。
- **任务与本地审批**：「扩展 → 工具」中的工具授权经批准后持续生效，修订变更时需重新确认；持久化任务中需审批的调用会生成等待审批票据，需在本地手动确认。
- **执行检查**：通过执行瀑布查看模型输入与输出，区分模型生成完成与平台确认送达。

### 记忆与知识库

- 按 Agent 和来源分区管理长期记忆，查看出处并纠正或屏蔽内容。QQ 记忆按会话与绑定隔离，与本人私聊共享需显式配置。
- 导入 UTF-8 文本或 Markdown 到知识库，分类管理并逐个授权 Agent；导入不等于自动授权。
- 为对话、判断、视觉、记忆与整理等用途独立选择本地模型或外部 OpenAI 兼容模型，分别保存端点、加密凭据与声明的能力。

当前版本不提供语音转写、完整视频理解、AI 绘图或未受控的多 Agent 协作。

### 运行要求与安装部署

从 [v0.4.0-alpha-2 Release 页面](https://github.com/Verdspair/superstring/releases/tag/v0.4.0-alpha-2)下载各平台安装包与校验清单（`SHA256SUMS`）。升级前请先备份数据。

| 平台 | 支持的分发形式 | 说明 |
|---|---|---|
| Windows x64 | 安装程序（`.exe`） | 可选安装目录，新版安装程序覆盖同一目录升级；数据保存在 `userdata` |
| macOS 13+，Apple Silicon／Intel | 架构对应的 DMG、ZIP | 已随本次发布提供；macOS 为临时签名（ad-hoc signed，未公证），首次运行请右键「打开」；详情见[跨平台桌面打包](tools/desktop/build/cross-platform/README.md) |
| Linux glibc，x64／arm64 | DEB、AppImage | 已随本次发布提供；Debian/Ubuntu 使用 DEB 包；AppImage 需要桌面沙箱与 FUSE 支持 |

安装文件以对应 Release 页面实际附带的构件为准，请使用随发布的校验清单（`SHA256SUMS`）核对。macOS 签名状态与各平台安装细节见[跨平台桌面打包](tools/desktop/build/cross-platform/README.md)。

应用安装包包含运行环境。模型推理需要 LM Studio 等本地服务或配置的外部 OpenAI 兼容服务。

1. 安装并打开 Superstring。
2. 打开**模型服务**配置端点与各用途模型；本地默认端点为 `http://127.0.0.1:1234/v1`。使用原生图片输入需确认模型实际支持图片输入，并检查其视觉能力声明：未声明时程序仍会尝试发送原生图片；模型明确拒绝图片时会自动回退文本描述并记录负缓存（非所有网络错误均自动回退）；若模型不支持图片，请明确声明关闭视觉能力或选用文本描述模式，请勿对不支持的模型虚标支持。使用代码沙箱需服务明确声明代码执行能力。
3. 创建或选择 Agent，导入并授权所需知识。
4. 新建网页对话即可开始使用。
5. 接入 QQ：安装 QQ NT 与 OneBot 11 服务（如 NapCat），登录 QQ 并保持后台运行，在 NapCat 面板开启正向 WebSocket 服务端并保持常驻。
6. 在**方案**页进入 QQ 连接设置，填入 WebSocket 地址、访问令牌与 Agent 账号（机器人 QQ 号），开启「启用 QQ」，再将群或私聊绑定到 Agent 与方案。

LM Studio 需要鉴权时，启动前设置 `LM_STUDIO_API_KEY`。外部服务凭据在本地加密存储，备份时需将资料目录与密钥一同保管。

### 数据与升级

Windows 版本的会话与配置保存在安装目录的 `userdata` 文件夹；原生 macOS/Linux 安装包使用系统应用数据目录。关闭桌面窗口后，Superstring 自行启动的服务与相关进程一起退出。再次双击启动器即可重新启动。

升级前请完全退出程序并备份整个数据目录。切勿使用旧版程序打开已迁移的数据库。业务数据库结构版本为 54。版本差异、数据位置与回退步骤见 [UPGRADING.md](UPGRADING.md)。

### 源码运行

安装 Node.js 22.12.0 或更高版本，然后安装固定依赖：

```sh
npm ci
```

Windows 运行 `start.cmd`，macOS/Linux 运行 `./start.sh`。入口会构建前端资源并启动本地服务，使用 Ctrl+C 停止。开发调试可在两个终端分别运行 `npm run dev:server` 与 `npm run dev:web`。

服务默认绑定 `127.0.0.1:17861`，端口被占用时桌面模式支持自动回退可用端口。

### 文档

- [版本说明](RELEASE_NOTES.md)
- [升级指南](UPGRADING.md)
- [跨平台桌面打包](tools/desktop/build/cross-platform/README.md)
- [桌面参考](docs/reference/desktop.md)
- [运行观测参考](docs/reference/runtime-observability.md)
- [Agent 内核架构](docs/architecture/agent-runtime.md)与[前端工作区架构](docs/architecture/frontend-workspaces.md)
- [MIT 许可证](LICENSE)；依赖项附带各自的许可证与 NOTICE 原文

---

## English

### Conversations, with context

Manage web conversations, QQ group chats, and private chats in one unified workspace. Select an Agent, configure its identity and model, and authorize it to access memories and documents. Configure models, prompts, and chat behavior to suit how you use the app. Conversation history, settings, and imported materials stay local; requests to external model providers include only the necessary context. The interface supports English and Simplified Chinese.

Superstring runs locally on Windows, macOS, and Linux. Conversation history, configurations, long-term memory, and encryption keys stay on your machine. Superstring does not require a cloud account, nor does it provide cloud sync services. When connecting to configured model providers or tool services, it sends only authorized context and necessary parameters to the designated endpoints.

### Vision and notes

This is my personal project, started with the goal of providing everyday companionship—chatting and playing together.

Looking ahead, I hope it can gradually connect with more games and virtual worlds to join in more shared experiences. This is a long-term vision under exploration; the current release does not integrate with external games.

The current experience may not match mature commercial alternatives. Feedback is welcome, and your patience is greatly appreciated.

### QQ groups and private chats

Connect a standalone OneBot 11 WebSocket service (such as NapCat), then bind a group or private chat to an Agent and a chat scheme.

Incoming messages in bound conversations appear automatically. When loading chat history, fresh messages appear right away without waiting for older records to finish loading, keeping your current scroll position undisturbed. In QQ group chats, running model tasks appear above the message history; click a task to view subtasks and model inputs/outputs, and the final result updates upon completion.

- Choose continuous conversation or autonomous participation; these two modes are mutually exclusive. Direct responses and idle-topic initiation can be configured separately. Direct responses bypass interest scoring, while the Agent may still choose silence. Autonomous participation can judge when to join by message count (default 15±5) or elapsed time (default 60±20 seconds). The time window is enabled for new schemes, and opportunities can wait for available capacity. Window settings and the validity period for queued replies are adjustable; replies remain valid for 10 minutes by default.
- Set initiative thresholds, quiet periods, cooldowns, active hours, and reply grouping. QQ replies can quote messages, mention members, or include stickers within authorized permissions. Quotes and mentions are mutually independent; stickers require scheme authorization.
- Edit scheme prompts across scene, judgement, reply, review, sticker, media, and compression roles. Multiple bindings can share schemes without sharing conversation history.
- Configure separate judgement and reply windows. Messages outside the reply window enter a buffer queue and are compressed into context packages in a background task queue; judgement does not consume these packages.
- Decouple original QQ group names from custom aliases. Custom aliases take precedence with fallback to group names; rebinding does not overwrite aliases, and group names support preloading.
- Enable or disable group participation directly from conversation cards or conversation headers. Disabled groups continue to receive and store messages while the Agent stays silent without starting model tasks.

**Group settings** are integrated into scheme and group workflows, providing dedicated configurations and overrides for specific groups. Participation, response, context, media, and prompt fields can either follow the base scheme or store group-specific overrides; rebinding does not inherit overrides, and switching back restores them. System capabilities can be disabled per group with immediate effect.

Prerequisites and operational notes for QQ integration:

1. Install and log into a QQ NT client. QQ must remain logged in and online. Version compatibility between QQ and the OneBot implementation follows upstream documentation ([NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases); NapCat v4.18.28 with QQ 9.9.26.44343 is a previously validated combination, not an official support list or recent verification result).
2. Install an OneBot 11 implementation (such as [NapCat](https://github.com/NapNeko/NapCatQQ) as a validated example; other OneBot 11 implementations are not excluded, but universal compatibility is not guaranteed). Taking the NapCat Shell package as an example: extract it on Windows, run `launcher.bat` (`launcher-win10.bat` on Windows 10), and open the WebUI panel printed in the console.
3. Keep the QQ client and NapCat running independently in the background. In the NapCat WebUI, confirm that QQ remains logged in, enable a **forward WebSocket server**, configure an access token, and record the address and port (opening the WebUI panel does not mean QQ is online or the WebSocket server is ready).
4. In Superstring, open **Schemes**, navigate to QQ connection settings, and enter the WebSocket address (e.g. `ws://127.0.0.1:port/` for local deployment, or an accessible network address for cross-machine setups), access token, and Agent account (enter the bot's QQ number, not the Superstring assistant ID). Check **Enable QQ** and save; then bind groups or private chats to an Agent and a scheme.

Operational details:
- Superstring acts as a client connecting to an upstream OneBot forward WebSocket service. It does not bundle, launch, or stop QQ or NapCat processes. Both QQ and NapCat must run independently in the background.
- Superstring does not handle QQ login. Automation is subject to platform and account policies; use a dedicated test account and protect your endpoints and credentials.
- An active connection does not guarantee message delivery. If the connection drops while QQ and NapCat remain running, the application retries periodically, but does not guarantee immediate reconnection or backfilled replies.

### Multimodal and media processing

- **Dual-mode image input**: Choose between native multimodal input (`native`) and text description extraction (`description`). Native mode passes images directly to image-capable models; description mode extracts text descriptions using a configured vision model. Image inputs are toggled independently across decision, evaluation, and generation stages; models lacking native image support can use description mode, and explicit model rejection triggers fallback to descriptions with in-process negative caching (general network failures do not trigger fallback). Completed image descriptions are returned directly; longer descriptions can be read in further pages.
- **Image caching and preparation**: Scoped asset caches store multi-resolution variants and animated GIF frames; inbound media is loaded on demand, reducing unnecessary processing.
- **Structured reply records**: Tracks multi-part messages and structured reply quote chains with multi-level quoting. Member records distinguish group cards from personal nicknames, tracking platform wire events versus local directory sources.
- **Sticker management**: Import sticker collections, manage tags and descriptions, and authorize collections for chat schemes; supports text, sticker, or combined responses.
- **Output reserve caps**: Scheme judgement and reply output reserve limits can be set up to 32768 to accommodate long outputs from thinking models; defaults remain 512 and 2048.
- **QQ data retention**: Configurable retention period (1–3650 days, default 14 days) covering message text, media reading records, assistant speech, delivery logs, and nicknames. Expired content becomes unreadable; physical deletion requires manual user preview and confirmation in the storage panel. Telemetry trace retention is configured independently under System capabilities → Execution limits.

### Unified Agent core, extensions, and tools

The interface provides six primary sections: **Conversations**, **Agents**, **System capabilities**, **Schemes**, **Library**, and **Extensions**, along with entrances for **Model services** and **Preferences**.

- **Workspace tabs**: The conversation workspace integrates Messages, Runs, and Tasks tabs, switchable between conversation and global scopes.
- **Capability groups**: Browse related tools, skills, and MCP services under material reading, web access, QQ, execution, and external extensions. Open the existing settings or component details directly. Memory query settings include the retrieval prompt and each mode’s relevance criteria.
- **QQ group members**: Assistants can look up IDs, nicknames, group cards, and owner/admin/member roles in the current group, including their own identity. Search, filters, and individual details are available on demand. Ordinary chat needs no lookup; a roster is reused within the run, and missing fields remain unknown. Configure the global switch in System capabilities or disable it per group.
- **Extensions & MCP client**: View registered built-in and external MCP tools under Extensions → Tools; connect to external Model Context Protocol services over stdio, HTTP, and SSE; registered servers are disabled by default, with configurable timeouts and result caps; environment credentials store variable names only.
- **Skills catalog**: View installed skill documentation and six bundled system skills (evidence reading, media reading, QQ members, QQ reply, task execution, web research) under Extensions → Skills.
- **Programmatic Tool Calling (PTC)**: An optional execution mode using a QuickJS WASM sandbox to orchestrate and aggregate read-only tool calls locally; disabled by default and active only when models declare code execution capabilities.
- **Web access and read-only research**: Optional web search (SearXNG and Bing) and page fetching with private network address guards; optional read-only research mode (up to 2 subtasks per run, up to 6 steps per subtask); both default to off.
- **Tasks and local approvals**: Tool authorizations under Extensions → Tools remain active once approved until revisions change; task calls requiring approval generate pending tickets that require manual local confirmation.
- **Execution inspection**: Browse execution waterfalls to inspect model inputs and outputs, distinguishing model generation from confirmed platform delivery.

### Memory and knowledge library

- Manage long-term memories partitioned by Agent and source, inspect references, and correct or block inaccurate content. QQ memory is isolated by conversation, and sharing with personal private chats requires explicit configuration.
- Import UTF-8 text or Markdown into the knowledge library, organize documents into categories, and grant access per Agent; importing does not grant automatic access.
- Select local or external OpenAI-compatible models for conversation, judgement, vision, memory, and organization roles. External providers maintain endpoints, encrypted credentials, and declared capabilities.

Speech transcription, full-video understanding, image generation, and arbitrary unconstrained multi-agent collaboration are not available in this release.

### Requirements and installation

Download distribution assets and the checksum list (`SHA256SUMS`) from [v0.4.0-alpha-2 Releases](https://github.com/Verdspair/superstring/releases/tag/v0.4.0-alpha-2). Back up existing data before upgrading.

| Platform | Supported distribution formats | Notes |
|---|---|---|
| Windows x64 | Installer (`.exe`) | Choose an installation directory; future installers upgrade the same directory; data lives in `userdata` |
| macOS 13+, Apple Silicon or Intel | Architecture-specific DMG and ZIP | Attached to this release; packages are ad-hoc signed, not notarized (right-click Open on first launch); see [Desktop packaging](tools/desktop/build/cross-platform/README.md) for details |
| Linux glibc, x64 or arm64 | DEB and AppImage | Attached to this release; DEB integrates with Debian/Ubuntu; AppImage requires desktop sandbox and FUSE support |

Use files actually attached to the selected release and verify them against its checksum list (`SHA256SUMS`). macOS signing status and platform details are documented in [Desktop packaging](tools/desktop/build/cross-platform/README.md).

Application packages bundle their runtime. Inference requires a local server such as LM Studio or an external OpenAI-compatible provider.

1. Install and launch Superstring.
2. In **Model services**, configure endpoints and default models. The default local endpoint is `http://127.0.0.1:1234/v1`. To use native image input, confirm that the model actually supports images and review its vision declaration: undeclared models will still attempt native delivery; when a model explicitly rejects images, the host falls back to text descriptions and caches the failure for the current process (network failures do not trigger fallback); if a model lacks vision capabilities, explicitly disable vision or select description mode rather than falsely declaring support. Programmatic tool calling requires an explicit code execution declaration.
3. Create or select an Agent, then import and authorize necessary knowledge.
4. Start a web conversation.
5. To connect QQ: install QQ NT and an OneBot 11 service (such as NapCat), keep QQ logged in and running, and enable a forward WebSocket server in the NapCat panel.
6. Under **Schemes**, configure QQ connection details (WebSocket address, access token, and bot QQ number), turn on **Enable QQ**, and bind groups or private chats to an Agent and a scheme.

If LM Studio requires a token, set `LM_STUDIO_API_KEY` before starting. Provider credentials are encrypted on disk; store the profile and encryption keys together.

### Data and upgrades

On Windows, conversations and settings live under the installation's `userdata` directory; native macOS/Linux packages use system application data profiles. Closing the desktop window exits background services and processes started by Superstring. Double-click the launcher again to restart.

Fully exit the application and back up your complete data directory before upgrading. Do not open migrated databases with older versions. The application database schema version is 54. See [UPGRADING.md](UPGRADING.md) for version differences, data paths, and rollback procedures.

### Run from source

Install Node.js 22.12.0 or newer and pinned dependencies:

```sh
npm ci
```

Run `start.cmd` on Windows or `./start.sh` on macOS/Linux. Both build frontend assets and launch the local service; stop with Ctrl+C. For development, run `npm run dev:server` and `npm run dev:web` in separate terminals.

Services bind to `127.0.0.1:17861` by default, with automatic fallback to available ports in desktop mode when occupied.

### Documentation

- [Release notes](RELEASE_NOTES.md)
- [Upgrade guide](UPGRADING.md)
- [Desktop packaging](tools/desktop/build/cross-platform/README.md)
- [Desktop reference](docs/reference/desktop.md)
- [Runtime observability reference](docs/reference/runtime-observability.md)
- [Agent runtime architecture](docs/architecture/agent-runtime.md) and [Frontend workspace architecture](docs/architecture/frontend-workspaces.md)
- [MIT license](LICENSE); third-party license and NOTICE texts accompany packaged dependencies

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）；还为开发与测试提供了算力支持。没有这份支持，项目很难走到现在。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, contributing multi-platform support (macOS/Linux source launch and native desktop distributions), discussing and shaping the project's direction during early and ongoing development (see the [pull request history](https://github.com/Verdspair/superstring/pulls)), and providing compute support for development and testing. Without this support, the project could hardly have reached its current stage.
