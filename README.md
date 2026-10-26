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

在同一工作区管理网页对话、QQ 群聊和私聊。选择 Agent，配置身份与模型，按需授权读取记忆和文档。模型、提示词和聊天行为都可以按自己的习惯灵活配置。会话记录、配置和导入资料保存在本机；调用外部模型服务时，仅在请求中包含所需的上下文。界面支持简体中文与 English 切换。偏好中提供雾紫、峡湾、白桦、鼠尾草、暖玫和渐变樱粉六套主题，支持浅色、深色与跟随系统。界面与窗口动效统一并遵循减少动效偏好。启动、最小化与从任务栏还原约 225 毫秒，最大化与取消最大化约 90 毫秒，关闭窗口保持 150 毫秒；曲线与形状不变。

Superstring 运行在本地，支持 Windows、macOS 与 Linux。会话记录、配置、长期记忆与密钥保存在本机，不提供云端数据同步服务，也不要求注册云端账号；调用已配置的模型服务商或工具服务时，仅按已授予的权限将必要的上下文与参数发送至对应端点。

### 愿景与说明

这是我的个人项目，出发点是实现日常陪伴，一起聊天、一起玩耍。

未来希望它能逐步连接更多游戏与虚拟世界，融入更多互动场景。这是正在探索的长期愿景，当前版本尚未开放外部游戏连接。

目前体验可能不如成熟的同类商业产品。欢迎提出反馈与建议，也请在使用中多一些耐心。

### QQ 群聊与私聊

可使用已在本机部署并配置的托管 QQ 运行环境，或连接独立运行的 OneBot 11 WebSocket 服务（例如 NapCat），再将群或私聊绑定到 Agent 与聊天方案。

聊天记录首次从服务器只读取最新 100 条，点击“加载更早消息”继续查看旧记录，不删除或截断已保存的历史。新消息到达已绑定的会话时逐条即时显示；刷新和回复完成不会丢掉已加载的旧页，查看历史时保持当前阅读位置。群聊顶部显示正在进行的模型任务，点开任务可查看子任务及模型输入输出详情，任务结束后会更新最终结果。

- 可选用连续交谈或自主接话（两种模式互斥）。直接回应与冷场发起可分别配置，直接回应不要求兴趣评分，Agent 仍可保持沉默。自主接话可按消息条数（默认15±5）或经过时间（当前源码新建为30±10秒）择机判定，新方案默认开启时间窗口，忙时可排队。窗口参数和待发送回复的有效期都可调整，回复有效期默认10分钟。回复失效时，可查看已记录的原因，包括发送超时、对话变化、发送条件变化或内容保留期到期；未记录原因的旧回复只提示“回复已失效”。同一批次中的回复生成完成后即可进入发送流程，不再等待其他目标生成。回复已进入发送流程时，不会再次回答同一条已处理消息。图片工具选错引用时可在本轮纠正；已失效的内容仍不可读取。运行详情同时显示最近尝试结果和失败历史。可为本会话设置多名会话管理员，管理员的要求会被优先考虑；可在「会话与绑定」和本群配置中设置，也可从方案详情查看其使用会话。消息历史会避免同一发送的重复显示。自主接话与冷场记录只显示已开始意图判断的任务；尚未判断的等待或跳过记录不再单独展示，已判断后选择沉默的任务仍保留。无法确认判断状态的旧记录、原有消息、任务队列和技术追踪保持可见。
- 设置主动开口门槛、安静时间、冷却、活跃时段与回复分组。自主接话评分中档（4–6，基准5）认可自然接梗与轻量回应，达标后直接承接意图，并保留合理沉默、自定义约束与状态未确认时的防重复。QQ 回复可在当前授权范围内引用消息、@ 成员或搭配表情。引用和 @ 相互独立，表情需由方案授权。
- 编辑方案的场景、判断、回复、复核、表情、媒体与压缩提示词。多个绑定可复用同一方案，不会因此共享会话历史。
- 分别配置判断和回复窗口。超出回复窗口的消息进入缓冲队列，达到阈值后在后台任务队列压缩为上下文包；判断阶段不读取这些包。
- QQ 群名称与用户自定义备注名解耦独立保存。设置自定义备注时优先显示备注，未设置时显示 QQ 原群名，均无则显示群号；支持群名预加载，更换绑定或助手不会丢失备注名。
- 支持在会话卡片和群会话顶部随时启用或停用群发言。停用后群消息照常接收保存，Agent 不发言且不产生新模型任务。
- **独立回复任务**：有效艾特和引用助手消息的请求分别执行，不再因同一会话中的慢回复等待整批结束。每会话的艾特任务与普通任务上限默认 4／1，可设 1–64；会话覆盖值留空时跟随方案。模型请求另设全局总上限和每服务上限，默认 4／2，可设 1–256，两项同时生效。艾特任务优先取得下一个可用名额，不中断正在执行的任务。
- **输入防刷屏**：新方案默认开，已有方案保持关，可按会话覆盖。默认将同一成员在首条起3秒内的至少3条纯图片消息按一个候选处理；条数可设2–20条，首窗可设1–30秒，方案默认与会话覆盖分别保存。他人插话不打断，自身文字、其它媒体或直接请求结束分组。命中组与纯表情不自动供图，仍可经工具按需读取；直接艾特和合法引用照常处理，原记录不删除。
- **研究与媒体预算**：QQ 研究按子任务自己的上下文检查容量；媒体或表情结果装不下时返回明确预算提示，不把本可继续的任务拖到下一轮才失败，真正超出容量时明确失败。

在「对话」列表顶部点击 **新建／添加**，可选择新建网页对话、添加 QQ 群聊或添加 QQ 私聊。QQ 会话可从已观察列表中按类型和已知名称／号码查找，也可手动填写群号或对方 QQ 号，再明确选择 Agent 和方案。群聊填写群号，私聊填写联系人的 QQ 号，不是 NapCat 登录的机器人账号；自身账号会被拦截并提示。添加只保存配置，不会创建群、添加好友、发送消息或自动开启 QQ、主动联系、记忆共享；已有绑定会指向管理入口，不会静默覆盖。添加成功即进入对话列表，没有消息也可打开空会话；目录读取失败时只重读目录，不会重复添加。添加时可原地新建并选中方案，保留号码与 Agent；新方案未开启参与方式会明确提示，不自动替你开启。QQ 连接设置和方案详情的使用会话页复用同一添加流程。

打开「方案」，在 QQ 任务入口中选择「会话与绑定」「QQ连接」或「数据与保留」，也可直接打开共用方案。方案详情只显示当前方案的设置与使用会话；各任务有明确的返回入口。进入群聊可编辑**本群配置**。群聊的参与、回应、上下文、媒体与提示词可跟随共享方案或保存为本群覆盖值；换绑不继承覆盖值，切回时自动恢复。页面支持针对单个群停用系统能力，停用即时生效。群聊与私聊共用同一套会话配置页，分别显示“本群配置”和“本私聊配置”。可按会话与 Agent 自定义策略，未自定义的项目跟随方案；私聊不显示群成员、群能力停用或按群内发言人拆分等专属项。配置入口位于会话顶部、会话菜单和绑定管理。网页对话不使用 QQ 方案。QQ 会话菜单中的“移除会话”解除绑定并从目录移除，不删除 Agent、方案或 QQ 平台聊天；本机历史资料按原规则保留但不再由这个入口访问。运行中任务或发送结果未知时会拒绝移除，避免中断或误重发。

#### QQ 接入方式选择与版本说明

- **版本与界面差异**：当前从源码运行时提供集成的「QQ连接」任务工作区（包含「连接」「消息事件」「运行设置」三项任务与 NapCat 本机托管组件）；已发布的 `v0.4.0-alpha-2` 桌面安装包未包含该新版托管界面，仅提供外部 OneBot 连接设置。使用已发布 `v0.4.0-alpha-2` 安装包的用户，请以「方式二：外部 OneBot 服务独立连接」为准；从源码运行可使用「方式一：本机托管 QQ 运行环境」。
- **两种接入方式**：
  - **方式一（推荐，限 Windows x64 源码运行）**：使用内置的 NapCat 本机托管组件，由 Superstring 协同管理 NapCat 进程、扫码/快捷登录与本地正向 WebSocket 服务配置。
  - **方式二（跨平台 / 外部独立运行 / 已发布安装包）**：独立运行 QQ 客户端与 OneBot 11 服务（如 NapCat、LLOneBot 等），Superstring 仅作为客户端连接用户指定的 WebSocket 服务端。

#### 方式一：本机托管 QQ 运行环境（当前源码版，限 Windows x64）

1. **准备官方运行时发行包**：
   - 本机托管仅支持 **Windows x64** 系统。macOS、Linux 或其他架构请使用方式二。
   - 前往 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载官方 `v4.18.41` Release 中的 **Windows.Node 独立运行包** `NapCat.Shell.Windows.Node.zip`。必须选用带有 Windows.Node 标识的独立运行包，不能使用普通 Shell 包或非 Node 架构版本。该运行包不随 Superstring 安装包附带，程序亦不提供后台静默下载，需用户自行从官方渠道获取。
   - **无需另装 QQNT 桌面客户端**：该官方 Node 运行包已内嵌 QQ NT 核心与必要运行库，**使用该运行包时不需要在系统上另行安装 QQ NT 客户端**。
   - 将下载的压缩包完整解压到一个专用的本地运行目录（例如 `D:\NapCat`）。
   - **目录结构与路径要求**：解压后的根目录必须完整包含 `node.exe`、`index.js`、`wrapper.node`、`crypto.dll`、`ssl.dll`、`package.json`（name 属性为 `qq-chat` 且架构为 `x64`）、`config.json`，以及包含 `express` 和 `ws` 依赖的 `napcat` 子目录。配置路径必须指向该**解压后的根目录**，不要选择未解压的 `.zip` 压缩文件、内部子目录或 `launcher.bat` 脚本（Superstring 直接通过 `node.exe index.js` 拉起进程，以确保生命周期受控）。
   - **配置初始化提示**：准备资源时除在私有目录生成描述文件外，若检测到 `napcat/config/webui.json` 缺失，会生成默认回环配置（`127.0.0.1:6099` 与随机生成的控制令牌，该令牌仅用于底层管理，非业务通信令牌）；若已有配置中绑定为 IPv6 通配符 `::`，会将其规范化为 `127.0.0.1` 并保留其他已有字段。建议使用干净专用的官方运行目录，避免影响个人其他用途的 NapCat 配置。
2. **在 Superstring 中配置资源路径与刷新**：
   - 打开主导航的「方案」，在 QQ 任务入口中点击「QQ连接」，进入「连接」视图。
   - 首次未配置时，「QQ 托管组件」中的「运行时路径」输入区域为**默认展开状态**（此时「路径设置」折叠按钮处于禁用状态）。直接在展开的输入框中输入或粘贴 NapCat 解压根目录的绝对路径，点击「更新路径」。（若后续需要修改路径，可点击「路径设置」展开）。
   - 点击「更新路径」校验成功后，面板立即显示“运行时文件验证有效”；随后点击页面右上方的**「刷新状态」**（Refresh state）读回组件状态，以解锁「启用托管服务」开关。
3. **设置 OneBot 目标连接参数**：
   - 在下方的「OneBot 连接」设置组中配置所需的业务连接字段：
     - **Agent 账号**：填写准备登录的机器人 QQ 账号。
     - **WebSocket 地址**：填写正向 WebSocket 回环端点（例如 `ws://127.0.0.1:3001`）。
     - **访问令牌**：填写自定义的通信访问令牌（由用户自行设定，留空表示保持原有令牌）。
     - 点击「保存接入设置」。
   - *说明*：用户需在 OneBot 连接设置中显式指定目标账号、端点与令牌；托管服务启动后将据此匹配并写入 NapCat 的监听配置。若上述字段未填完整，托管组件将提示需要网络配置。
4. **启用托管服务并保存**：
   - 在「QQ 托管组件」面板中勾选「启用托管服务」，点击面板底部的「保存」按钮（卡片底部的「保存」仅用于提交托管偏好）。
   - 保存后应用会自动调度启动或停止本地托管服务。保存操作仅记录偏好并触发激活，**保存成功不等于服务已就绪（Ready）**，界面亦不会实时自动推进。
   - 点击「刷新状态」读回当前阶段。若之前已有登录且核心有效，可能直接恢复为核心在线；若为全新登录，状态会推进至“等待扫码”。
5. **登录 QQ 账号**：
   - **手机 QQ 扫码**：状态进入“等待扫码”后，点击「刷新二维码」，面板中将显示临时登录二维码。使用手机 QQ 扫描该二维码并在手机上确认登录。
   - **本机快捷登录**：在服务运行中并等待扫码时使用；若账号列表未出现，可先点击「刷新状态」。从列表中选择已知账号并点击「快速登录」发起登录请求（若有换号操作，应用先保存账号并在受在途任务保护时拦截）。发起快速登录仅代表请求已受理，**不保证绕过手机端确认，请留意手机 QQ 上的登录确认或安全验证**；若状态仍停留在等待扫码，请改用二维码扫码登录。
   - *账号列表说明*：快捷登录列表来自当前受管运行时的控制接口查询，应用不会另行扫描整机账号。可用账号与凭据实际保存位置由 QQ NT 与 NapCat 运行时管理；专用运行目录用于避免影响其他用途的 NapCat 配置文件，但这不等于底层 QQ 账号资料的物理隔离。
   - 完成扫码或快速登录后，点击「刷新状态」确认 QQ 核心是否已登录在线。
6. **开启业务总开关与连接就绪**：
   - 核心在线后，Superstring 自动向 NapCat 的监听列表中注入名为 `superstring` 的正向 WebSocket 监听器；若已存在参数完全匹配（包含端口、令牌、回环地址、消息格式与自身上报等）的现有监听器，则采取只读复用。
   - 在页面顶部勾选「参与第三方聊天 / 启用 QQ」（业务总开关），勾选后系统会自动保存（无需另点击保存按钮，卡片底部的「保存」仅用于提交托管开关，下方的「保存接入设置」仅用于提交连接参数）。待保存完成后，底层才会建立 OneBot 连接并完成身份握手核验。
   - 随后点击「刷新状态」，当托管进程正常、QQ 核心在线、OneBot 监听匹配验证通过，且「参与第三方聊天」处于开启状态时，连接状态才最终显示为“已连接”。两个开关相互独立。

#### 方式二：外部 OneBot 服务独立连接（适用于 macOS / Linux、已发布安装包或自行管理服务）

1. **安装并运行 QQ 客户端**：安装 QQ NT 客户端并登录。QQ 需保持登录在线；QQ 与 OneBot 实现的版本配套以上游说明为准（见 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases)；NapCat v4.18.28 与 QQ 9.9.26.44343 为过去曾验证过的组合，非官方支持列表或最新测试结论）。
2. **安装并运行 OneBot 11 实现**：以 NapCat Shell 包为例，在 Windows 上解压并运行 `launcher.bat`（Windows 10 运行 `launcher-win10.bat`），按控制台输出打开 WebUI 面板（程序不排斥其他 OneBot 11 实现，但不保证全部兼容）。
3. **配置正向 WebSocket**：在 NapCat WebUI 中确认 QQ 处于登录在线状态，开启**正向 WebSocket 服务端**并设置访问令牌，记录连接地址与端口（WebUI 能打开不代表 QQ 已登录或 WebSocket 服务已就绪）。
4. **在 Superstring 中配置连接**：在 Superstring 的连接设置中（已发布安装包位于「QQ 设置」，源码版位于「QQ连接」），填写 WebSocket 地址（同机部署填 `ws://127.0.0.1:端口/`，跨机部署填实际可达的 ws/wss 地址）、访问令牌与 Agent 账号（填写机器人 QQ 号），点击「保存接入设置」保存连接参数；随后在页面顶部开启「参与第三方聊天 / 启用 QQ」（当前源码版勾选即自动保存，已发布旧安装包按界面保存按钮操作）；再将群或私聊绑定到 Agent 与方案。外部服务由用户独立管理，Superstring 保持纯客户端连接，不管理、不重启、不停止外部已有进程。

运行与连接说明：
- 外部连接方式下，QQ 与 OneBot 服务由用户独立运行；Superstring 不停止已有外部运行环境。
- 自动化受到平台规则与账号状态约束，建议使用测试账号并妥善保管端点与凭据。
- 连接就绪不代表消息一定送达；连接断开时保持 QQ 与 NapCat 正常运行，程序会间隔重试连接，不承诺立即恢复连接或补发遗漏回复。
- **账号切换安全保护**：在 QQ 连接设置中更换绑定的账号时提供安全检查。若原账号或新账号历史关联的会话中存在正在执行的任务、仍在处理的后台工作、正在发送或发送结果未知的消息，程序会拒绝切换，避免在未结清工作时改变账号归属；相同账号保存、无变更操作或修改普通设置不会误拦截。
- **消息事件即时排障**：在「方案 → QQ连接 → 消息事件」任务中提供紧凑的通信事件列表，专司底层通信与协议排障。可按消息、通知、请求与元事件类型筛选，展开结构化字段详情，并在向上翻看历史记录时自动暂停跟随。正文预览遵守原会话绑定、来源修订与保留期限，未绑定或失效的消息仅展示元数据。

### 多模态与媒体处理

- **图片输入双模式**：支持原生图片输入（`native`）与文本描述（`description`）双模式。原生模式将图片直接传入支持视觉的模型；描述模式调用已配置的视觉模型提取文字描述。可在决策、评估与生成三阶段独立控制图片输入；不支持原生图片的模型可使用描述模式，模型明确报错不支持图片时也会回退提取描述并记录负缓存（非所有网络错误均自动回退）。图片描述完成后直接提供文字结果，较长内容可继续读取。
- **图片缓存与准备**：图片资产按范围缓存，支持预生成多分辨率副本与动图抽帧；入站媒体按需读取，减少不必要的资源消耗。
- **结构化回复记录**：记录多部件消息与回复引用链，支持按需多层引用；成员记录区分群名片与个人昵称，标注来源属于平台原始上报还是本地目录记录。
- **表情素材管理**：导入表情素材，编辑说明与标签，经检查启用后授权给方案；支持文字、表情或图文混合回复。
- **自主文字与表情回复**：Agent 可选择纯文字、单张表情或图文组合。只发文字时无需额外声明不用表情。方案可设置较少使用、平衡选择或积极考虑三档表情倾向，默认平衡；本群可覆盖，私聊跟随方案。这是软倾向，不是发送比例或次数限制。
- **表情关闭即时生效**：关闭全局或本群表情后，尚未开始发送的表情（含排队部件）不再发送，合法文字照常。已开始的请求不撤回，未知送达结果不盲目重发。回复仍至多一张表情，旧数量控件退役但不重写已保存值。
- **输出预留与新建默认**：当前源码中新建助手和方案的输出预留为 32768，并采用自动上下文分配；助手保留近期原文 200 轮（QQ 按消息条数）。已有配置与历史快照不改写，实际调用仍受所选模型容量限制。已发布安装包仍使用其对应版本的默认值。
- **QQ 数据保留期限**：支持配置 QQ 数据保留期限（1–3650 天，默认 14 天），覆盖消息正文、媒体阅读记录、助手发言、发送记录与昵称。到期内容不可读；物理清理需在存储面板中手动预览确认。运行追踪的保留天数在「系统能力 → 执行限制」中独立配置，两者互不影响。
- **统一图片规格**：各类别的静图共用长边设置或保留原图，动图共用帧数与帧长边。取消单独的表情画质设置和补充时间窗。基本区提供自动／按需选择，高级区保留模式、三阶段开关与自定义配置。真实明确关联原图的新请求有独立的有界读取预算，同请求失败不自动重试；成功内容可在权限和有效期内复用。

### 统一 Agent 内核、扩展与工具

导航按**日常**（对话、Agent、资料）、**应用**（方案）与**系统**（模型服务、系统能力、扩展）组织为 7 个工作区入口，底部设**偏好**与搜索入口；主导航与会话列表均支持通过细线拖动调整宽度。

- **工作区整合**：对话工作区整合消息、运行状态与任务三页签，支持在当前会话与全局范围之间切换。 新消息通过会话通知更新消息记录，查看历史时保留阅读位置并提示新消息。运行记录按任务用途显示名称，原始标识可在详情查看。
- **系统能力分类**：按资料读取、联网、QQ、任务执行和外置扩展查看相关工具、技能与 MCP，点击进入功能配置或组件详情。记忆读取规则、候选数、返回条数与字节额度在 Agent 的访问规则中配置；旧检索字段保留原值，不再生效的设置以只读方式说明。
- **QQ 群成员查询**：助手可按需查看当前群的成员 ID、昵称、群名片和群主／管理员／成员身份，包括自己；支持查找、筛选和按需详情。普通聊天不查询，同轮名单复用；平台未提供的信息明确标为未知。开关在系统能力配置，各群可单独停用。
- **扩展与 MCP 客户端**：在「扩展 → 工具」中查看已注册的系统工具与外部 MCP 工具；支持通过 stdio、HTTP 与 SSE 连接外部 Model Context Protocol 服务，登记的服务默认未启用，支持配置超时与结果限额；环境变量凭据仅保存变量名。
- **技能目录**：在「扩展 → 技能」中查看技能文档与随包提供的 6 个系统技能（证据读取、媒体读取、QQ成员查询、QQ回复、任务执行、网络研究）。
- **程序化工具调用（PTC）**：基于 QuickJS WASM 沙箱的可选执行模式，支持在本地编排与聚合已授权的只读工具调用；默认关闭，在「系统能力 → 执行设置」开启，不需要逐模型许可。
- **联网工具与只读研究**：支持网络搜索（SearXNG 端点与必应备用通道）与带私网拦截护栏的网页提取；支持受控只读研究模式（每次运行最多发起 2 个子任务，每个子任务最多执行 6 步）；默认均保持关闭。
- **工具授权与本地审批**：当前源码中新建助手默认获得当前已安装工具和知识文档的助手级授权，不修改既有助手，也不自动开启服务或授权以后新增的资源。可在「扩展 → 工具」单独禁用某助手或恢复基础继承；持续批准与单次审批分别管理。工具修订变化仍须复验，需要审批的任务继续在本地确认。
- **调用与唤醒重试**：在「系统能力 → 执行设置」中可配置模型与只读工具调用失败重试（默认共 3 次尝试，含首次，间隔 2 秒，仅对明确的 HTTP 429／503 拒收重试，写操作与超时不盲目重试）；在「方案 → QQ连接 → 运行设置」中可配置唤醒失败重试（默认共 3 次尝试，含首次，间隔 15 秒）。
- **运行概览与步骤选择**：运行概览聚焦结果与依据，采用竖列步骤卡片展示模型调用，打开时默认选定首个步骤并在下方展示详情。
- **技术追踪与执行排查**：面向过程诊断，通过时间线查看执行顺序、耗时与错误，点击步骤直接联动下方详情；父任务下的实际模型调用也可查看，消除多余的重复列表。
- **运行内容展开与按需读取**：选中步骤的输出、输入与关联来源分区呈现且输出在最前，各条目默认收起并支持按需独立展开；打开运行详情时自动预取当前运行全部实际调用，预取完成后切换或展开不再发起网络请求（预取未完成前显示加载状态；输入、输出与来源展示仍受访问权限与保留期限制，已过保留期或已撤回内容明确标示）；区分模型生成完成与平台送达，同一送达结果不重复读取；完整技术追踪记录与关联来源保留。
- **模型结束原因**：在运行详情中查看模型步骤，可直接查看原始 `finish_reason`、HTTP 状态码和流式 `[DONE]` 标记。多次请求分别列出，未返回原因、显式 `null`、无 HTTP 响应和历史未记录分别显示，方便排查调用失败。
- **模型服务与编码**：在「模型服务」中可为本地（如 LM Studio）或外部模型选填文本编码（如 `cl100k_base`、`o200k_base`），未指定采用保守估算；提供参考帮助与来源链接但不自动选择；展示实际模型、容量与编码用量，保存冲突时保留草稿。
- **模型工具调用兼容**：对工具调用的函数名与请求结构做协议兼容处理，减少因格式差异被服务拒绝的情况；遇到明确的函数调用格式异常时可在现有纠错流程内再试一次，不执行异常调用、不重复已完成的工具操作，持续异常仍明确报错。是否可用仍取决于所接入的模型与服务商。

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
| macOS 13+，Apple Silicon／Intel | 架构对应的 DMG、ZIP | 已随本次发布提供；macOS 为临时签名（ad-hoc signed，未公证），首次运行请右键「打开」；详情见[升级指南](UPGRADING.md) |
| Linux glibc，x64／arm64 | DEB、AppImage | 已随本次发布提供；Debian/Ubuntu 使用 DEB 包；AppImage 需要桌面沙箱与 FUSE 支持 |

安装文件以对应 Release 页面实际附带的构件为准，请使用随发布的校验清单（`SHA256SUMS`）核对。macOS 签名状态与各平台安装细节见[升级指南](UPGRADING.md)。

应用安装包包含运行环境。模型推理需要 LM Studio 等本地服务或配置的外部 OpenAI 兼容服务。

1. 安装并打开 Superstring。
2. 打开**模型服务**配置连接与可用模型；本地默认端点为 `http://127.0.0.1:1234/v1`。各任务模型在 Agent、QQ 或知识设置中配置，跨任务整理默认模型在系统执行设置中管理。原生图片输入由服务实际处理；明确拒绝图片时回退文本描述并记住当前进程内的拒绝结果，普通网络错误不自动降级。已知不支持原生图片时可选择文本描述模式，无需配置逐模型视觉或代码执行开关。
3. 创建或选择 Agent，导入并授权所需知识。
4. 新建网页对话即可开始使用。
5. 接入 QQ：从源码运行时可使用 Windows x64 本机托管环境（详见「QQ 群聊与私聊」中的方式一）；使用已发布安装包或 macOS/Linux 时，独立运行 QQ 与 OneBot 11 服务（如 NapCat），开启正向 WebSocket 服务端。
6. 在「方案」的 QQ 连接设置中配置账号（源码版位于「QQ连接」任务，已发布安装包位于「QQ 设置」）；填入 WebSocket 地址、访问令牌与 Agent 账号（机器人 QQ 号），开启「启用 QQ」，再将群或私聊绑定到 Agent 与方案。

LM Studio 需要鉴权时，启动前设置 `LM_STUDIO_API_KEY`。外部服务凭据在本地加密存储，备份时需将资料目录与密钥一同保管。

### 数据与升级

Windows 版本的会话与配置保存在安装目录的 `userdata` 文件夹；原生 macOS/Linux 安装包使用系统应用数据目录。关闭桌面窗口后，Superstring 自行启动的服务与相关进程一起退出。再次双击启动器即可重新启动。

升级前请完全退出程序并备份整个数据目录。切勿使用旧版程序打开已迁移的数据库。当前 main 分支源码数据库结构版本为 72（新增迁移 0055–0072；已发布的 v0.4.0-alpha-2 安装包仍为 54，未重新打包发布）。版本差异、数据位置与回退步骤见 [UPGRADING.md](UPGRADING.md)。

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
- [MIT 许可证](LICENSE)；依赖项附带各自的许可证与 NOTICE 原文

---

## English

### Conversations, with context

Manage web conversations, QQ group chats, and private chats in one unified workspace. Select an Agent, configure its identity and model, and authorize it to access memories and documents. Configure models, prompts, and chat behavior to suit how you use the app. Conversation history, settings, and imported materials stay local; requests to external model providers include only the necessary context. The interface supports English and Simplified Chinese. Preferences offers six themes—Lavender, Fjord, Birch, Sage, Hearth, and Blossom with soft gradients—with light, dark, and system modes. Interface and window motion is consistent and respects reduced-motion preferences: startup, minimize, and restore from the taskbar take about 225 ms; maximize and unmaximize about 90 ms; closing stays at 150 ms, with unchanged curves and shapes.

Superstring runs locally on Windows, macOS, and Linux. Conversation history, configurations, long-term memory, and encryption keys stay on your machine. Superstring does not require a cloud account, nor does it provide cloud sync services. When connecting to configured model providers or tool services, it sends only authorized context and necessary parameters to the designated endpoints.

### Vision and notes

This is my personal project, started with the goal of providing everyday companionship—chatting and playing together.

Looking ahead, I hope it can gradually connect with more games and virtual worlds to join in more shared experiences. This is a long-term vision under exploration; the current release does not integrate with external games.

The current experience may not match mature commercial alternatives. Feedback is welcome, and your patience is greatly appreciated.

### QQ groups and private chats

Use a managed QQ runtime already deployed and configured locally, or connect a standalone OneBot 11 WebSocket service (such as NapCat), then bind a group or private chat to an Agent and a chat scheme.

Message history initially reads only the latest 100 records from the server. Use “Load older messages” to read earlier records without deleting or truncating saved history. Incoming messages in bound conversations appear immediately, one by one. Refreshing or completing a reply keeps already loaded older pages and your reading position. In QQ group chats, running model tasks appear above the message history; click a task to view subtasks and model inputs/outputs, and the final result updates upon completion.

- Choose continuous conversation or autonomous participation; these two modes are mutually exclusive. Direct responses and idle-topic initiation can be configured separately. Direct responses bypass interest scoring, while the Agent may still choose silence. Autonomous participation can judge when to join by message count (default 15±5) or elapsed time (30±10 seconds for new schemes in current source builds). The time window is enabled for new schemes, and opportunities can wait for available capacity. Window settings and the validity period for queued replies are adjustable; replies remain valid for 10 minutes by default. When a reply is no longer valid, the interface shows its recorded reason: delivery timeout, conversation changes, delivery conditions, or content retention expiry. Older replies without a recorded reason use a neutral label. Each completed reply in a batch can enter delivery without waiting for the other targets to finish generating. Once a reply enters the delivery flow, it will not answer the same already-handled message again. When an image tool selects an invalid reference, it can self-correct within the current turn; expired content remains unreadable. Run details display both recent attempt outcomes and failure history. You can appoint several administrators for a conversation, whose requests are given priority; configure them under Conversations & bindings or Group settings, and view a scheme’s conversations from its details. Message history avoids duplicate sent messages. Autonomous-participation and idle-topic records show tasks that have started intent judgement, including decisions to remain silent. Waiting or skipped opportunities that have not been judged are no longer shown separately. Older records with unknown judgement status, messages, task queues, and technical traces remain available.
- Set initiative thresholds, quiet periods, cooldowns, active hours, and reply grouping. Autonomous participation scoring treats middle scores (4–6, baseline 5) as natural light engagement for natural, brief conversation and carries qualified intent directly into replies, while preserving legitimate silence, custom rules, and duplicate suppression when delivery status is unconfirmed. QQ replies can quote messages, mention members, or include stickers within authorized permissions. Quotes and mentions are mutually independent; stickers require scheme authorization.
- Edit scheme prompts across scene, judgement, reply, review, sticker, media, and compression roles. Multiple bindings can share schemes without sharing conversation history.
- Configure separate judgement and reply windows. Messages outside the reply window enter a buffer queue and are compressed into context packages in a background task queue; judgement does not consume these packages.
- Decouple original QQ group names from custom aliases. Custom aliases take precedence with fallback to group names; rebinding does not overwrite aliases, and group names support preloading.
- Enable or disable group participation directly from conversation cards or conversation headers. Disabled groups continue to receive and store messages while the Agent stays silent without starting model tasks.
- **Independent reply tasks**: Valid mentions and replies to the assistant run as separate tasks instead of waiting for all replies in a conversation to finish. Per-conversation mention and ordinary task limits default to 4 and 1, with a range of 1–64. Empty conversation overrides follow the scheme. Model requests have separate global and per-service limits, defaulting to 4 and 2 with a range of 1–256; both limits apply. Mention tasks take the next available slot without interrupting running work.
- **Input anti-spam**: Enabled for new schemes and kept off for existing schemes, with conversation overrides. By default, at least three image-only messages from one sender within three seconds of the first form one logical candidate; threshold (2–20 messages) and initial window (1–30 seconds) are configurable, stored separately for scheme defaults and conversation overrides. Other senders do not break the group; the sender's own text, other media, or direct request does. Grouped images and pure expressions are excluded from automatic image input but remain readable through tools. Direct mentions and valid replies are still handled, and original records are not deleted.
- **Research & media budget**: QQ research runs check capacity against each subtask's own context limit; when media or sticker outputs exceed available space, a clear budget message is returned instead of postponing failure to later turns, and genuine capacity exceedances fail clearly.

Use **New / add** at the top of the conversation list to start a web conversation, add a QQ group chat, or add a QQ private chat. For QQ, filter observed conversations by type and search known names or numbers, or enter a group/contact number manually, then explicitly select an Agent and a scheme. Enter a group number for groups and the contact’s QQ number for private chats, not the bot account signed into NapCat. A private chat targeting the bot itself is rejected with an explanation. Adding saves configuration only: it does not create a group, add a friend, send a message, or automatically enable QQ, proactive contact, or memory sharing. Existing bindings lead to management rather than being silently overwritten. Added conversations appear in the list immediately and can be opened even without messages. A directory-read failure offers a read-only retry, not another binding creation. Create and select a scheme in place without losing the target or Agent. A new scheme with no participation triggers is clearly marked; nothing is enabled automatically. QQ connection settings and a scheme’s usage page reuse the same flow.

Open **Schemes** to find shared schemes and the equally visible QQ tasks: **Conversations & bindings**, **QQ connection**, and **Data & retention**. Scheme details focus on the selected scheme and its conversations. Each task has a clear return path. Groups have **Group settings** with overrides for participation, replies, context, media, and prompts. Overrides stay with the group/Agent pair and return when switching back; per-group capability restrictions take effect immediately. Groups and private chats use the same conversation policy editor, titled Group settings or Private chat settings. Customize policy for the conversation and Agent, while other fields follow the scheme. Private chats omit group members, group-only capability restrictions, and splitting replies by group speaker. Open settings from the conversation header, its menu, or binding management. Web conversations do not use QQ schemes. Remove conversation in a QQ conversation menu removes its binding and directory entry, not the Agent, scheme, or QQ chat. Local history keeps its retention rules but is no longer accessible through that entry. Removal is refused while work is active or a send result is unknown.

#### QQ connection options and version notes

- **Version and interface differences**: When running from source, Superstring includes an integrated QQ Connection workspace with three tasks (**Connection**, **Message events**, and **Runtime settings**) alongside a local managed NapCat component. The published `v0.4.0-alpha-2` desktop installers do not include this new managed interface and provide external OneBot connection settings only. Users running the published `v0.4.0-alpha-2` installer should follow Option 2: External OneBot service connection directly. Running from source supports Option 1: Managed QQ runtime.
- **Two connection options**:
  - **Option 1 (Recommended, Windows x64 source builds)**: Use Superstring's built-in managed NapCat component, letting the app supervise the NapCat process, QR-code/quick login, and local forward WebSocket listener configuration.
  - **Option 2 (Cross-platform / External standalone / Published installers)**: Run your QQ client and OneBot 11 service (such as NapCat, LLOneBot, etc.) independently; Superstring connects strictly as a client to your specified WebSocket server.

#### Option 1: Managed QQ runtime (current source builds, Windows x64)

1. **Prepare the official runtime bundle**:
   - Managed mode supports **Windows x64** only. On macOS, Linux, or other architectures, use Option 2.
   - Obtain the official Windows.Node bundle `NapCat.Shell.Windows.Node.zip` from the `v4.18.41` Release on [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases). You must use a package specifically labeled Windows.Node; generic Shell packages or non-Node versions cannot be used. This runtime bundle is not included in Superstring installers, and the application does not provide silent background downloads; you must download it from the official upstream source.
   - **No separate QQ NT client required**: This official Node bundle embeds the QQ NT core and required runtime; you do **not need to install a separate QQ NT desktop client** on your computer.
   - Extract the downloaded package completely into a dedicated local directory (for example, `D:\NapCat`).
   - **Directory structure requirements**: The extracted root folder must contain `node.exe`, `index.js`, `wrapper.node`, `crypto.dll`, `ssl.dll`, `package.json` (where `name` is `qq-chat` and `eleArch` is `x64`), `config.json`, and the `napcat` subfolder containing `express` and `ws` dependencies. The path must point to this **extracted root directory**; do not select the unextracted `.zip` file, inner subfolders, or `launcher.bat` (Superstring executes `node.exe index.js` directly to ensure predictable process lifecycle control).
   - **Configuration initialization**: When preparing resources, Superstring records a local descriptor. If `napcat/config/webui.json` is missing, it creates a default loopback configuration (`127.0.0.1:6099` with a generated random control token; this token is used for low-level management only and is distinct from the business communication token); if an existing configuration binds to IPv6 wildcard `::`, it normalizes it to `127.0.0.1` while preserving other fields. Use a dedicated folder to avoid changing other NapCat configurations.
2. **Configure the runtime path and refresh in Superstring**:
   - Open **Schemes** in the main navigation, click the QQ task **QQ connection**, and navigate to the **Connection** view.
   - On initial setup when not yet configured, the **Runtime path** input area in the **QQ Managed Component** card is **expanded by default** (the "Path settings" toggle button is disabled). Enter or paste the absolute path to the extracted NapCat root directory directly in the expanded input box, then click **Update Path**. (To modify the path later, click "Path settings" to expand).
   - Once validated upon clicking "Update Path", the badge immediately indicates **Runtime files verified**; then click **Refresh state** in the top right of the page to read back the component status and unlock the **Enable Managed Service** checkbox.
3. **Set target OneBot connection parameters**:
   - In the **OneBot connection** group below, configure the required fields:
     - **Agent account**: Enter the QQ number of the bot account you intend to use.
     - **WebSocket address**: Enter your desired forward WebSocket loopback endpoint (e.g. `ws://127.0.0.1:3001`).
     - **Access token**: Enter a custom access token for communication security (set by you; leaving it blank keeps any previously saved token).
     - Click **Save access settings**.
   - *Note*: Explicitly set your target account, endpoint, and token in the OneBot connection settings; once started, the managed service matches and merges this listener into NapCat's configuration. If any required field is missing, the managed component indicates that network configuration is required.
4. **Enable managed mode and save**:
   - Check the **Enable Managed Service** checkbox in the QQ Managed Component card, and click **Save** in the card footer (the "Save" button in the card footer only submits the managed preference).
   - Saving will schedule starting or stopping the local managed service. Saving records configuration and triggers activation, but **saving does not mean the service is already ready (Ready)**, and the interface does not automatically update in real time.
   - Click **Refresh state** to read back the current stage. If an existing login is still valid, the core may restore directly to online; for a fresh setup, the status progresses to waiting for scan.
5. **Log in to QQ**:
   - **Mobile QR code**: When the status reaches "Waiting for scan", click **Refresh QR Code** to display the temporary login QR code in the card. Scan it with mobile QQ and confirm the login on your phone.
   - **Quick login**: Available while the service is running and in waiting for scan; if the account list has not appeared yet, click **Refresh state** first. Select a known account from the **Local Quick Login** dropdown and click **Quick Login** to initiate a login request (if switching accounts, the app saves the account first under in-flight protection). Initiating quick login acknowledges the request but **does not guarantee bypassing mobile confirmation—watch for confirmation or security verification prompts in mobile QQ**; if the state remains waiting for scan, switch to QR code login.
   - *Account list note*: The quick login list is retrieved from the current managed runtime's control interface; the app does not scan system-wide accounts. Available accounts and credential storage locations are managed by the QQ NT and NapCat runtime. A dedicated directory prevents overwriting other NapCat configurations, but this is not physical profile isolation for QQ data.
   - After completing login, click **Refresh state** to confirm whether the QQ core is online.
6. **Enable business switch and complete connection**:
   - Once the core is online, Superstring injects a forward WebSocket listener named `superstring` into NapCat's listener list; if an existing listener matches all parameters completely (including port, token, loopback host, message format, and self-reporting), it is reused read-only.
   - Check **Participate in external chats / Enable QQ** (the business master switch) at the top of the page; checking it saves automatically (no additional save button is needed: the "Save" button in the card footer only submits the managed switch, and "Save access settings" below only submits connection parameters). Wait for the save to complete, then the underlying OneBot connection and identity handshake will proceed.
   - Then click **Refresh state**. The status displays "Connected" once the managed process is healthy, the QQ core is online, the OneBot listener is verified, and "Participate in external chats" is enabled. Both switches are mutually independent.

#### Option 2: External OneBot service connection (macOS / Linux, published installers, or self-managed setups)

1. **Install and run QQ client**: Install and log into a QQ NT client. QQ must remain logged in and online. Version compatibility between QQ and the OneBot implementation follows upstream documentation ([NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases); NapCat v4.18.28 with QQ 9.9.26.44343 is a previously validated combination, not an official support list or recent verification result).
2. **Install and run an OneBot 11 implementation**: Taking the NapCat Shell package as an example: extract it on Windows, run `launcher.bat` (`launcher-win10.bat` on Windows 10), and open the WebUI panel printed in the console (other OneBot 11 implementations are not excluded, but universal compatibility is not guaranteed).
3. **Configure forward WebSocket**: In the NapCat WebUI, confirm that QQ remains logged in, enable a **forward WebSocket server**, configure an access token, and record the address and port (opening the WebUI panel does not mean QQ is online or the WebSocket server is ready).
4. **Configure connection in Superstring**: In Superstring's connection settings (under "QQ settings" in published installers, or under "QQ connection" in source builds), enter the WebSocket address (e.g. `ws://127.0.0.1:port/` for local deployment, or an accessible ws/wss address for cross-machine setups), access token, and Agent account (the bot's QQ number), and click **Save access settings** to save connection parameters. Then enable **Participate in external chats / Enable QQ** at the top of the page (in current source builds, checking it saves automatically; in published older installers, follow the interface save button). Finally, bind groups or private chats to an Agent and a scheme. External services are managed independently by the user; Superstring maintains a pure client connection without restarting or stopping existing external processes.

Operational details:
- In external connection mode, run QQ and the OneBot service independently. Superstring does not stop an existing external runtime.
- Automation is subject to platform and account policies; use a dedicated test account and protect your endpoints and credentials.
- An active connection does not guarantee message delivery. If the connection drops while QQ and NapCat remain running, the application retries periodically, but does not guarantee immediate reconnection or backfilled replies.
- **Account switching protection**: Updating or switching the bound QQ account includes safeguards before changing accounts. If historical sessions associated with either the old or new account contain tasks in progress, ongoing background work, or messages being sent or with unknown delivery results, the application refuses the switch to avoid changing account ownership while work is outstanding. Same-account updates, no-op saves, and ordinary setting edits are not blocked.
- **Message events diagnostics**: Under **Schemes → QQ connection → Message events**, a compact command-line-style event list provides low-level protocol inspection and troubleshooting. Filter by messages, notices, requests, or meta events, inspect structured details, and pause autoscroll while reviewing historical entries. Message body previews respect conversation bindings, source revisions, and retention limits; unbound or expired messages show metadata only.

### Multimodal and media processing

- **Dual-mode image input**: Choose between native multimodal input (`native`) and text description extraction (`description`). Native mode passes images directly to image-capable models; description mode extracts text descriptions using a configured vision model. Image inputs are toggled independently across decision, evaluation, and generation stages; models lacking native image support can use description mode, and explicit model rejection triggers fallback to descriptions with in-process negative caching (general network failures do not trigger fallback). Completed image descriptions are returned directly; longer descriptions can be read in further pages.
- **Image caching and preparation**: Scoped asset caches store multi-resolution variants and animated GIF frames; inbound media is loaded on demand, reducing unnecessary processing.
- **Structured reply records**: Tracks multi-part messages and structured reply quote chains with multi-level quoting. Member records distinguish group cards from personal nicknames, tracking platform wire events versus local directory sources.
- **Sticker management**: Import sticker collections, manage tags and descriptions, and authorize collections for chat schemes; supports text, sticker, or combined responses.
- **Independent text and sticker replies**: The Agent can choose text, one sticker, or a combination. Text-only replies need no extra sticker opt-out. Schemes offer low, medium, or high sticker-use guidance, defaulting to medium; groups can override it, while private chats follow the scheme. This is a soft preference, not a sending ratio or count limit.
- **Immediate sticker disable**: Turning off global or group stickers blocks unstarted sticker sends, including queued parts, without blocking valid text. Started requests are not withdrawn, and unknown delivery results are not blindly retried. Replies still allow at most one sticker. The old count control is retired without rewriting stored values.
- **Output reserves and creation defaults**: In current source builds, new assistants and schemes reserve 32768 output tokens and use automatic context allocation. Assistants retain 200 recent turns (messages for QQ). Existing settings and historical snapshots are not rewritten; each call remains limited by the selected model's capacity. Published installers keep the defaults of their release.
- **QQ data retention**: Configurable retention period (1–3650 days, default 14 days) covering message text, media reading records, assistant speech, delivery logs, and nicknames. Expired content becomes unreadable; physical deletion requires manual user preview and confirmation in the storage panel. Telemetry trace retention is configured independently under System capabilities → Execution limits.
- **Unified image settings**: All still-image categories share a long-edge setting or retain the original image; animations share frame counts and frame dimensions. Separate expression quality settings and supplement time windows have been removed. Basic settings offer automatic or on-demand input, while advanced settings retain modes, per-stage switches, and custom configurations. A new explicit request linked to a source image has its own bounded read budget. Failed reads do not retry automatically within the same request; successful results can be reused while permissions and expiry checks remain valid.

### Unified Agent core, extensions, and tools

The navigation organizes seven workspace sections across three groups: **Daily** (Conversations, Agents, Library), **Apps** (Schemes), and **System** (Model services, System capabilities, Extensions), with **Preferences** and search at the bottom; both the main navigation and the conversation list can be resized by dragging a subtle divider line.

- **Workspace tabs**: The conversation workspace integrates Messages, Runs, and Tasks tabs, switchable between conversation and global scopes. Conversation notifications update message records while preserving your position when reading history and marking new arrivals. Run records show task names by purpose, with original identifiers available in details.
- **Capability groups**: Browse related tools, skills, and MCP services under material reading, web access, QQ, execution, and external extensions. Open the existing settings or component details directly. Configure memory reading rules, candidate counts, page entries and byte allowances under Agent access rules. Legacy retrieval values are preserved, with inactive settings shown as read-only.
- **QQ group members**: Assistants can look up IDs, nicknames, group cards, and owner/admin/member roles in the current group, including their own identity. Search, filters, and individual details are available on demand. Ordinary chat needs no lookup; a roster is reused within the run, and missing fields remain unknown. Configure the global switch in System capabilities or disable it per group.
- **Extensions & MCP client**: View registered built-in and external MCP tools under Extensions → Tools; connect to external Model Context Protocol services over stdio, HTTP, and SSE; registered servers are disabled by default, with configurable timeouts and result caps; environment credentials store variable names only.
- **Skills catalog**: View installed skill documentation and six bundled system skills (evidence reading, media reading, QQ members, QQ reply, task execution, web research) under Extensions → Skills.
- **Programmatic Tool Calling (PTC)**: An optional QuickJS WASM execution mode for orchestrating and aggregating authorized read-only tool calls locally. It is disabled by default and enabled under System capabilities → Execution settings, without a per-model opt-in.
- **Web access and read-only research**: Optional web search (SearXNG and Bing) and page fetching with private network address guards; optional read-only research mode (up to 2 subtasks per run, up to 6 steps per subtask); both default to off.
- **Tool authorisation and local approvals**: In current source builds, new assistants receive assistant-level access to currently installed tools and knowledge documents. Existing assistants are not changed, services are not enabled automatically, and later resources are not granted automatically. Under Extensions → Tools, you can disable access for one assistant or restore base inheritance. Standing approval and per-call approval remain separate; tool revisions are rechecked and task calls requiring approval still need local confirmation.
- **Call and wake retries**: Configure model and read-only tool call retries under System capabilities → Execution settings (default: 3 attempts including the first, with a 2-second delay, retrying only explicit 429/503 rejections, without blind retries for writes or timeouts); configure wake retries under Schemes → QQ connection → Runtime settings (default: 3 attempts including the first, with a 15-second delay).
- **Run overview and step selection**: Run overviews focus on results and evidence, presenting model calls as vertical step cards, selecting the first step by default, and displaying its details below.
- **Technical trace and execution inspection**: Focuses on process diagnosis, using a timeline to inspect execution order, duration, and errors. Selecting a step links directly to its details below, and actual model calls under parent runs can also be inspected, eliminating redundant duplicate step listings.
- **Run detail content expansion and on-demand reading**: Outputs, inputs, and associated sources of the selected step are clearly separated with outputs shown first; all rows start collapsed and expand independently. When opening run details, all real calls for the current run are prefetched; once prefetched, switching steps or expanding sections requires no additional network requests (a loading indicator displays while prefetching; viewing inputs, outputs, and sources remains subject to access authorization and retention limits, with expired or revoked content clearly marked). Distinguishes model-generated content from platform delivery confirmation, avoiding duplicate reads for the same delivery result; full technical trace records and associated sources are preserved.
- **Model finish reasons**: Model steps in Run details directly display raw `finish_reason`, HTTP status codes, and streaming `[DONE]` markers. Multiple requests are listed separately. Missing reasons, explicit `null`, no HTTP response, and historical calls without records are shown as distinct states to help diagnose failed calls.
- **Model services & encodings**: Configure optional text token encodings (such as `cl100k_base` or `o200k_base`) for local services (e.g. LM Studio) and external providers; unconfigured models use conservative estimation. Reference help and documentation links assist verification without auto-selection. Shows actual model, capacity, and encoding usage, while preserving unsaved drafts during save conflicts.
- **Model tool call compatibility**: Tool calls apply protocol compatibility handling to function names and request structures, reducing rejections caused by format differences. An explicit malformed function-call finish can be retried once through the existing correction flow; rejected calls are not executed and completed tool actions are not repeated, while repeated failures remain explicit errors. Availability still depends on the connected model and provider.

### Memory and knowledge library

- Manage long-term memories partitioned by Agent and source, inspect references, and correct or block inaccurate content. QQ memory is isolated by conversation, and sharing with personal private chats requires explicit configuration.
- Import UTF-8 text or Markdown into the knowledge library, organize documents into categories, and grant access per Agent; importing does not grant automatic access.
- Select local or external OpenAI-compatible models for conversation, judgement, vision, memory, and organization roles. External providers maintain endpoints, encrypted credentials, model IDs, and context capacity.

Speech transcription, full-video understanding, image generation, and arbitrary unconstrained multi-agent collaboration are not available in this release.

### Requirements and installation

Download distribution assets and the checksum list (`SHA256SUMS`) from [v0.4.0-alpha-2 Releases](https://github.com/Verdspair/superstring/releases/tag/v0.4.0-alpha-2). Back up existing data before upgrading.

| Platform | Supported distribution formats | Notes |
|---|---|---|
| Windows x64 | Installer (`.exe`) | Choose an installation directory; future installers upgrade the same directory; data lives in `userdata` |
| macOS 13+, Apple Silicon or Intel | Architecture-specific DMG and ZIP | Attached to this release; packages are ad-hoc signed, not notarized (right-click Open on first launch); see [Upgrade guide](UPGRADING.md) for details |
| Linux glibc, x64 or arm64 | DEB and AppImage | Attached to this release; DEB integrates with Debian/Ubuntu; AppImage requires desktop sandbox and FUSE support |

Use files actually attached to the selected release and verify them against its checksum list (`SHA256SUMS`). macOS signing status and platform details are documented in [Upgrade guide](UPGRADING.md).

Application packages bundle their runtime. Inference requires a local server such as LM Studio or an external OpenAI-compatible provider.

1. Install and launch Superstring.
2. Open **Model services** to configure connections and available models. The default local endpoint is `http://127.0.0.1:1234/v1`. Configure task models in Agent, QQ, or knowledge settings, and the shared organization default in system execution settings. Native images are handled by the service; explicit image rejection triggers a text-description fallback and an in-process rejection cache, while ordinary network failures do not. Use description mode for models known not to accept native images. No per-model vision or code-execution switch is needed.
3. Create or select an Agent, then import and authorize necessary knowledge.
4. Start a web conversation.
5. To connect QQ: when running from source, you can use the Windows x64 managed runtime (see Option 1 under "QQ groups and private chats"); when using published installers or on macOS/Linux, run QQ and an OneBot 11 service (such as NapCat) independently with a forward WebSocket server.
6. In Schemes, configure the account under QQ connection settings (under the "QQ connection" task in source builds, or under "QQ settings" in published installers); enter the WebSocket address, access token, and Agent account (bot QQ number). Enable QQ, then bind groups or private chats to an Agent and scheme.

If LM Studio requires a token, set `LM_STUDIO_API_KEY` before starting. Provider credentials are encrypted on disk; store the profile and encryption keys together.

### Data and upgrades

On Windows, conversations and settings live under the installation's `userdata` directory; native macOS/Linux packages use system application data profiles. Closing the desktop window exits background services and processes started by Superstring. Double-click the launcher again to restart.

Fully exit the application and back up your complete data directory before upgrading. Do not open migrated databases with older versions. The current main source branch database schema version is 72 (with migrations 0055–0072; the published v0.4.0-alpha-2 installer remains on schema 54 and has not been repackaged). See [UPGRADING.md](UPGRADING.md) for version differences, data paths, and rollback procedures.

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
- [MIT license](LICENSE); third-party license and NOTICE texts accompany packaged dependencies

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）；还为开发与测试提供了算力支持。没有这份支持，项目很难走到现在。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, contributing multi-platform support (macOS/Linux source launch and native desktop distributions), discussing and shaping the project's direction during early and ongoing development (see the [pull request history](https://github.com/Verdspair/superstring/pulls)), and providing compute support for development and testing. Without this support, the project could hardly have reached its current stage.
