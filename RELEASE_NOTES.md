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

- **会话记忆与资料**：每个对话默认使用当前会话的私有记忆；可另选明确授予该 Agent 的共享或公共记忆，且不因此获得原始私聊正文权限。长期记忆来自会话整理；知识库保留用户手输、粘贴或导入的外部原文及其整理内容。新建 Agent 不自动获得未分配的文档，既有文档授权和创建时工具授权保留。记忆搜索使用本地索引筛选适用的文字查询候选；搜索仍以关键词为主，不保证找回无共同词语的同义表达，未找到不等于记忆不存在。旧检索模型和提示词值保留，不再用于自动选择。
- **QQ 连接界面**：连接、消息事件和运行设置采用一致的分组、标题、按钮和间距，减少重复边框与大段说明；关键状态、开关及保存操作保持可见，登录与配置行为不变。

以下功能属于 main 源码更新，未重发 v0.4.0-alpha-2 安装包。

- **QQ 设置滚动修复**：进入连接设置后，只滚动内容区，应用顶栏与方案页签保持固定；模型建议输入框、键盘选择与未保存草稿行为保持不变。

- **QQ 账号切换保护**：在 QQ 连接设置中更换绑定的账号时提供安全检查。若原账号或新账号历史关联的会话中存在正在执行的任务、仍在处理的后台工作、正在发送或发送结果未知的消息，系统会拒绝切换，避免在未结清工作时改变账号归属；相同账号保存、无变更操作或修改普通设置不会误拦截。
- **方案导航与 QQ 引用**：方案目录直接提供会话绑定、QQ连接和数据保留入口，不再将跨任务按钮放在方案详情。连接、消息事件和运行设置分开呈现；方案与会话配置各有唯一返回，原有草稿和保存冲突处理保留。修复仅艾特并附带空白的消息被误判为正文失效、导致引用回复失败的问题，保留原有来源与过期校验。
- **QQ 托管与消息观察**：在“方案 → QQ连接 → 连接”选择本地已解压的官方 NapCat 运行目录，准备资源后启用托管。可选择该运行时已记录的账号快速登录，或获取临时二维码并用手机 QQ 扫码确认。登录后，应用配置所需的本地 WebSocket 服务，或只读复用已有的匹配配置；托管开关与 QQ 业务开关分开保存。“消息事件”任务提供紧凑的通信事件列表，可按类型筛选、展开详情，并在向上翻看时暂停自动跟随。正文预览遵守原会话绑定、来源修订与保留期限，未绑定或失效的消息只显示元数据。Windows 上自有组件随桌面启动和退出，原有外部 OneBot 连接方式保留；运行包需另行从官方获取，不包含在安装包中。
- **消息记录按需加载**：首次从服务器只读取最新 100 条，旧记录按需分页加载；新消息仍即时显示，刷新和回复完成保留已加载旧页与阅读位置，不删除保存的历史。优化消息详情、启动记录核对与权限读取中的重复工作。

- **工作区布局与字体**：管理工作区统一标题、操作区和主标签的起始位置，窄屏按钮不会挤压标题；用途说明收进可悬停、聚焦或点击查看的帮助提示，错误与权限限制仍直接显示。偏好设置新增“典雅衬线”和“可爱圆润”两套中英文字体方案，保留当前默认字体；字体随程序提供，可离线使用，代码和技术标识保持等宽显示。
- **群头像与 Agent 页面布局**：没有自定义头像的 QQ 群会话自动显示群头像，读取失败时显示群聊图标；手动上传和生成头像仍优先。Agent 配置标签共用标题和操作区布局，切换资料读取时标签栏不再上下移动。
- **能力与扩展目录**：能力目录、MCP 服务、技能和工具改用紧凑列表，介绍与组件明细默认收起，配置和查看入口保持可见。启用项目靠前、禁用项目靠后淡化显示但仍可查看，连接失败单独提示；内置工具与技能提供中英文名称和简短介绍，第三方原文与技术名称保留。Agent 配置的资料读取放在标签栏最后，窄屏换行显示，不再使用栏内滚动。
- **模型调用兼容与异常处理**：工具调用会对函数名与请求结构做协议兼容处理，减少格式差异导致的拒绝；QQ 决策遇到明确的函数调用格式异常时，可通过现有纠错流程再尝试一次；不执行异常调用、不重复已完成的工具操作，仍受原有步骤、调用额度与取消限制。持续异常、内容过滤和输出上限仍明确报错。该兼容处理不保证每个模型与服务商组合都能完成工具调用。

- **QQ会话添加与独立配置**：对话列表的“新建／添加”直达网页对话、QQ群聊和QQ私聊；添加时可原地新建并选中方案。群聊、私聊共用会话配置页，支持跟随方案或保存当前会话与Agent的独立策略；私聊不显示群专属成员、能力停用及按发言人拆分设置。群号与对方QQ号分开标识，私聊不能绑定机器人自身账号。添加成功即显示在对话列表，没有消息也可打开空会话。
- **QQ会话移除**：群聊和私聊菜单均可移除会话并解除绑定。Agent、方案与QQ平台消息不删除，本机历史按原保留规则保留但不再由旧入口访问；运行中任务或未知发送结果会阻止移除。
- **Agent导航与共享滚动条**：Agent详情突出当前配置对象，左上返回保留未保存草稿；会话列表边界更清晰。原生与组件滚动条统一，绑定列表刷新保留行并暂时禁用操作，读取失败明确提示。

- **导航与方案工作区**：七个工作区入口按日常、应用和系统分组，底部提供偏好与搜索；主导航和会话列表可拖动细线调整宽度。方案、会话与绑定、QQ 设置共用一个工作区，可查看方案的使用会话、管理绑定并进入本群配置。
- **主题、间距与滚动**：提供五套精选北欧配色与渐变樱粉，支持浅色、深色及跟随系统。移除装饰性阴影，调整文字、控件和内容分组间距，保留焦点与选中提示；修复 QQ 设置长内容被裁切、无法滚动的问题。统一界面动效并遵循减少动效偏好；关闭窗口以外的过渡略微加快：启动、最小化与从任务栏还原 250→225 毫秒，最大化与取消最大化 100→90 毫秒，常见界面过渡约缩短一成；关闭窗口保持 150 毫秒，曲线与形状不变。
- **调用与唤醒重试**：系统能力执行设置可配置模型与受信任只读工具的调用重试，默认共 3 次尝试（含首次）、间隔 2 秒，仅对明确的 HTTP 429／503 拒收重试；不盲目重放写操作、超时或结果未知的请求。QQ 设置可单独配置唤醒失败重试，默认共 3 次尝试（含首次）、间隔 15 秒。

- **自主文字与表情回复**：Agent 可选择纯文字、单张表情或图文组合。只发文字时无需额外声明不用表情。方案可设置较少使用、平衡选择或积极考虑三档表情倾向，默认平衡；群聊与私聊均可在会话配置中覆盖。这是软倾向，不是发送比例或次数限制。
- **表情关闭即时生效**：关闭全局或本群表情后，尚未开始发送的表情（含排队部件）不再发送，合法文字照常。已开始的请求不撤回，未知送达结果不盲目重发。回复仍至多一张表情，旧数量控件退役但不重写已保存值。

- **自主接话参与度校准**：自主接话兴趣评分将 4–6 分（以 5 分为基准档）定为自然轻度参与档，认可日常接梗与轻松互动的社交价值，不要求每轮必须提供重要新信息；达到方案开口门槛后直接承接意图资料组织回复，不再重复评估是否值得开口。同时保留合理沉默机制：在确实无话可说、违反本群自定义规则、引用来源失效或已有任务确认送达相同内容时保持沉默；送达状态未知时不盲目重发同一内容，独立新问题仍可回应。出厂默认门槛（6 分）与既有群设置保持不变。

- QQ 艾特与合法引用助手消息的请求可独立执行；每会话艾特／普通任务上限默认 4／1（1–64）。全局／每服务模型请求上限另行配置，默认 4／2（1–256），同时生效。
- 输入防刷屏默认对新方案开启、对已有方案关闭。同成员首条起 3 秒内至少 3 条纯图片消息按一个候选处理，他人插话不打断；自动排除的图片仍可按需读取，直接请求不受分组等待影响。
- 所有图片类别共用静图与动图规格，取消单独表情画质和补充时间窗；图片设置收敛为基本／高级，保留自定义阶段。
- 保存普通 QQ 方案设置时不再误中断正在执行的回应任务；进行中的任务保留原有配置，后续新任务采用新设置；会话暂停与权限停用仍立即生效。
- 较新回复确认后，已被完整覆盖的旧自主回复提前停止；多成员任务只跳过已覆盖成员，不同艾特任务保持独立。
- 聊天记录加载失败后重试拉取最新页，不从最早记录重新开始。
- 修正 QQ 表情回复的输出规则冲突；错误的表情写法不会发送，并可在现有步骤限制内纠正后继续回复。
- **模型编码**：在模型服务 → LM Studio 本地编码或外部服务登记模型时可选填文本编码（如 `cl100k_base`、`o200k_base`），未指定时采用保守估算；提供参考帮助与来源说明但不自动选择；用量显示实际生效的模型、容量与编码；保存发生冲突时保留当前草稿。 模型页只管理接入与基础配置；工具、视觉与沙箱不再按模型开关，知识设置和跨任务整理默认模型分别放在资料与系统执行设置中。
- **QQ 研究与工具结果**：研究模式按子任务自己的上下文检查容量；媒体或表情结果装不下时返回明确的预算提示，不把本可继续的任务拖到下一轮才失败；仍超出容量时明确失败。
- **运行概览与步骤选择**：运行概览聚焦结果与依据，采用竖列步骤卡片展示模型调用，默认选定首个步骤并在下方查看对应详情。
- **技术追踪与执行排查**：面向过程与诊断，通过时间线查看执行顺序、耗时与错误，点击步骤直接联动下方详情；父任务下的实际模型调用也可查看，消除多余的重复列表。
- **输出、输入与来源独立收起与展开**：选中步骤的输出、输入与关联来源分区呈现且输出在最前，各条目默认收起，支持按需独立展开查看完整保留内容。
- **详情预取与按需读取**：运行详情加载时自动预取当前运行的全部实际调用并在内存中共享；预取完成后，切换步骤、视图或展开内容不再发起网络请求（预取未完成前仍显示加载状态；输入、输出与来源展示仍受访问权限与保留期限制，已过保留期或已撤回内容明确标示）；区分模型生成内容与平台送达状态，同一送达结果不重复读取；完整技术追踪记录与关联来源保留。步骤详情直接展示原始 `finish_reason`、HTTP 状态码和流式 `[DONE]` 标记，多次请求分别列出，未返回原因、显式 `null`、无 HTTP 响应和历史未记录分别显示，方便排查调用失败。
- **自主任务记录精简**：自主接话与冷场任务在实际开始意图判断后显示，包括判定保持沉默的结果。不再单独展示尚未开始判断的等待或跳过记录；判断状态不明的旧记录、原有消息、直接回应、连续会话、失败取消及原始任务队列与审计保持可见。
- 当前源码数据库结构为 75（相对已发布安装包新增迁移 0055–0075）；旧安装包仍为 54。更新前完整备份，回退时恢复匹配的升级前数据与程序。

---

## English

This release focuses on QQ replies, chat history, and desktop exit behavior. Changes below compare directly with v0.4.0-alpha-1.

### QQ Autonomous Participation and Context Budget

- Added batch controls for autonomous participation: configure target message counts (default: 15 messages, with jitter of 5) and queue-on-busy options (enabled by default) to prevent frequent unnecessary evaluations in active chats.
- Corrected context estimation for batch evaluations to reduce redundant source overhead; requests that genuinely exceed model limits are still rejected before calling the model.

### Chat History and In-flight Tasks

- **On-demand message history**: Initially reads only the latest 100 records from the server and loads older records in pages on demand. New messages still appear immediately; refreshing or completing a reply retains loaded older pages and the reading position, without deleting saved history. Reduces repeated work in message details, startup history reconciliation, and permission reads.
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

- **Conversation memory and materials**: Each conversation uses its own private memories by default and can also use shared or public memories explicitly granted to that Agent, without gaining access to original private-chat text. Long-term memories are organized from conversations; the knowledge library retains user-entered, pasted, or imported external originals and their organized content. New Agents do not automatically receive unassigned documents; existing document grants and tool authorization at creation remain. Memory search uses a local index to narrow candidates for eligible text queries. Search remains keyword-based and may miss paraphrases with no shared words; no match does not mean a memory does not exist. Stored legacy retrieval model and prompt values remain but are no longer used for automatic selection.
- **QQ connection interface**: Connection, message events, and runtime settings now share consistent groups, headings, buttons, and spacing, with fewer nested borders and long descriptions. Key states, switches, and save actions remain visible; login and configuration behavior is unchanged.

These features are source updates on main. The v0.4.0-alpha-2 packages have not been reissued.

- **QQ settings scrolling**: Connection settings now scroll only within their content area, keeping the application header and scheme tabs fixed. Model suggestions, keyboard selection, and unsaved drafts keep their existing behavior.

- **QQ account switching protection**: Updating or switching the bound QQ account includes safeguards before changing accounts. If historical sessions associated with either the old or new account contain tasks in progress, ongoing background work, or messages being sent or with unknown delivery results, the switch is refused to avoid changing account ownership while work is outstanding. Same-account updates, no-op saves, and ordinary setting edits are not blocked.
- **Scheme navigation and QQ reply references**: The scheme catalog provides direct entries for bindings, QQ connection, and data retention rather than placing cross-task buttons in scheme details. Connection, message events, and runtime settings have separate views. Scheme and conversation settings have one clear return path, with existing drafts and save-conflict handling preserved. Fixed quoted replies failing when a mention followed only by whitespace was incorrectly treated as an expired body. Source and expiry checks remain in place.
- **Managed QQ and message observation**: Under **Schemes → QQ connection → Connection**, select an extracted official NapCat runtime directory, prepare its resources, and enable managed mode. Choose an account saved by that runtime for quick login, or request a temporary QR code and confirm it in mobile QQ. After login, the app configures the required local WebSocket server or reuses a matching configuration read-only. Managed mode and the QQ business switch are saved separately. The Message events task provides a compact event list with type filters, expandable details, and paused autoscroll while reading older entries. Body previews follow the original conversation binding, source revision, and retention period; unbound or invalid sources show metadata only. On Windows, app-owned components start and stop with the desktop. Existing external OneBot connections remain available. Obtain the runtime package separately from its official source; installers do not include it.
- **Immediate messages**: New messages appear one by one as they arrive in bound conversations. Messages received while older history loads or a manual refresh runs are still shown, are not dropped by an earlier read, and do not wait for the next refresh; your reading position stays in place.

- **Workspace layout and fonts**: Management workspaces align their headers, actions, and primary tabs; narrow-screen actions no longer squeeze titles. Page introductions move into help available by hover, focus, or click, while errors and permission limits stay visible. Preferences adds coordinated Chinese and Latin Elegant serif and Playful rounded font styles alongside the existing default. Fonts ship with the application for offline use; code and technical identifiers remain monospace.
- **Group avatars and Agent layout**: QQ group conversations without a custom avatar automatically show the group picture, falling back to the group icon if it cannot load. Uploaded and generated avatars still take precedence. Agent configuration tabs share the same header and action-area layout, keeping the tab strip steady when switching to Resource reading.
- **Capability and extension directories**: Capabilities, MCP services, skills, and tools use compact lists with descriptions and component details collapsed by default. Configuration and inspection actions stay visible. Enabled items appear first; disabled items move down and remain inspectable, while connection failures stay distinct. Built-in tools and skills have Chinese and English labels and short descriptions; third-party text and technical names remain unchanged. Resource reading is the last Agent tab, and narrow layouts wrap without an inner scrollbar.
- **Model call compatibility and error handling**: Tool calls apply protocol compatibility handling to function names and request structures, reducing rejections caused by format differences. QQ decisions can use the existing correction flow once after an explicit malformed function-call finish. Rejected calls are not executed, completed tool actions are not repeated, and existing step, call-budget, and cancellation limits still apply. Repeated failures, content filtering, and output limits remain explicit errors. This adaptation does not guarantee that every model and provider combination can complete tool calls.

- **QQ conversation setup and per-conversation policy**: New / add in the conversation list opens web, QQ group, or QQ private chat setup; create and select a scheme in place. Groups and private chats share one policy editor with scheme inheritance and overrides for the conversation and Agent. Private chats omit group-only member, capability-disable, and speaker-splitting settings. Group and contact numbers are clearly distinguished, and private self-bindings are rejected. Added conversations appear immediately and open even without messages.
- **QQ conversation removal**: Group and private chat menus remove the conversation and its binding. Agents, schemes, and QQ messages remain; local history retains its existing lifetime but is inaccessible through the old entry. Active work or unknown send outcomes block removal.
- **Agent navigation and shared scrollbars**: Agent details identify the configuration target and offer an upper-left return without dropping drafts. Conversation boundaries are clearer. Native and component scrollbars share one style; binding refresh retains disabled rows and reports failed reads clearly.

- **Navigation and the scheme workspace**: Seven workspace sections are grouped under Daily, Apps, and System, with Preferences and search at the bottom. Resize the navigation and conversation list by dragging their divider lines. Schemes, Conversations & bindings, and QQ settings share one workspace for viewing scheme usage, managing bindings, and opening group settings.
- **Themes, spacing, and scrolling**: Choose five curated Nordic palettes or Blossom with soft gradients, in light, dark, or system mode. Decorative shadows are removed and spacing between text, controls, and content groups is adjusted, while focus and selection indicators remain. Fixed clipped, unscrollable long content in QQ settings. Interface animations are consistent and respect reduced-motion preferences. Transitions other than closing are slightly faster: startup, minimize, and restore from the taskbar go from 250 to 225 ms, maximize and unmaximize from 100 to 90 ms, and common interface transitions are about 10% shorter. Closing stays at 150 ms, with unchanged curves and shapes.
- **Call and wake retries**: System capabilities execution settings offer retries for model calls and trusted read-only tools, defaulting to 3 attempts including the first, with a 2-second delay. Only explicit HTTP 429/503 rejections are retried; writes, timeouts, and requests with unknown outcomes are not blindly replayed. QQ settings have separate wake retry controls, defaulting to 3 attempts including the first, with a 15-second delay.

- **Independent text and sticker replies**: The Agent can choose text, one sticker, or a combination. Text-only replies need no extra sticker opt-out. Schemes offer low, medium, or high sticker-use guidance, defaulting to medium; groups and private chats can override it in conversation settings. This is a soft preference, not a sending ratio or count limit.
- **Immediate sticker disable**: Turning off global or group stickers blocks unstarted sticker sends, including queued parts, without blocking valid text. Started requests are not withdrawn, and unknown delivery results are not blindly retried. Replies still allow at most one sticker. The old count control is retired without rewriting stored values.

- **Autonomous participation calibration**: The interest scoring rubric treats 4–6 (with 5 as baseline) as a natural light-participation range that recognizes the social value of natural, brief conversation without requiring novel information each round; once a candidate passes the scheme's initiative threshold, it directly carries forward intent material to craft a response without judging the same participation decision again. Legitimate silence remains preserved: the Agent may choose not to send a message when there is genuinely nothing to say, when custom group rules forbid it, when cited sources become invalid, or when delivery of identical content is already confirmed; it does not blindly resend identical content while delivery status is unknown, while responses to independent new questions remain allowed. Default threshold (6) and existing group configurations remain unchanged.

- QQ mentions and valid replies to assistant messages run as independent tasks. Per-conversation mention and ordinary task limits default to 4 and 1 (range 1–64). Global and per-service model request limits are configured separately, default to 4 and 2 (range 1–256), and both apply.
- Input anti-spam is enabled for new schemes and kept off for existing schemes. At least three image-only messages from one sender within three seconds of the first form one candidate; other senders do not break it. Excluded images remain readable on demand, and direct requests do not wait for grouping.
- All image categories share still-image and animation settings. Separate expression quality settings and supplement time windows are removed. Basic and advanced image settings retain custom stage choices.
- Saving standard QQ scheme settings no longer mistakenly interrupts an in-flight reply task; running tasks retain their original configuration and new tasks apply updated values. Conversation pauses and permission changes still take effect immediately.
- After a newer reply is confirmed, fully covered autonomous replies stop early. Multi-member tasks skip only covered members, and separate mention tasks remain independent.
- Chat history load failures retry from the newest page instead of restarting from the earliest records.
- Fixed conflicting output rules for QQ sticker replies. Invalid sticker output is not sent and can be corrected within the existing step limit before the reply continues.
- **Model encodings**: Optionally select text token encodings (such as `cl100k_base` or `o200k_base`) when configuring LM Studio local models or external services under Model Services; falls back to conservative estimation when unspecified. Reference help and documentation links assist verification without auto-selection. Usage details show the actual effective model, capacity, and encoding, and unsaved drafts are preserved if save conflicts occur. The model page now focuses on connections and basic settings, without per-model tool, vision, or sandbox switches. Knowledge settings and the shared organization default are available under Materials and system execution settings respectively.
- **QQ research and tool results**: Research runs check capacity against each subtask's own context limit; when media or sticker results exceed the available window, a clear budget message is returned instead of postponing failures to subsequent turns, with requests that genuinely exceed capacity failing clearly.
- **Run overview and step selection**: Run overviews focus on results and evidence, presenting model calls as vertical step cards, selecting the first step by default, and displaying its details below.
- **Technical trace and execution inspection**: Focuses on process diagnosis, using a timeline to inspect execution order, duration, and errors. Selecting a step links directly to its details below, and actual model calls under parent runs can also be inspected, eliminating redundant duplicate step listings.
- **Independent output, input, and source expansion**: Outputs, inputs, and associated sources of the selected step are clearly separated with outputs shown first; all rows start collapsed and expand independently to display preserved content.
- **Run detail prefetch and on-demand reading**: When opening run details, all real calls for the current run are prefetched and shared in memory; once prefetched, switching between overview and trace, toggling steps, or expanding sections requires no additional network requests (a loading indicator is displayed while prefetching is in progress; viewing inputs, outputs, and sources remains subject to access authorization and retention limits, with expired or revoked content clearly marked). Distinguishes model-generated content from platform delivery confirmation, avoiding duplicate reads for the same delivery result; full technical trace records and associated sources are preserved. Steps directly display raw `finish_reason`, HTTP status codes, and streaming `[DONE]` markers; multiple requests are listed separately, with missing reasons, explicit `null`, no HTTP response, and historical calls without records shown as distinct states to help diagnose failed calls.
- **Autonomous task records**: Autonomous-participation and idle-topic tasks appear once intent judgement has actually started, including decisions to remain silent. Waiting or skipped opportunities that have not yet started judgement are no longer shown separately. Older records with unknown judgement status, original messages, direct responses, continuous conversations, failures, cancellations, and full task queues and audits remain available.
- Current source uses schema 75 with migrations 0055–0075 since the published installer; existing packages still use schema 54. Make a full backup before updating, and restore matching pre-upgrade data and executables when rolling back.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
