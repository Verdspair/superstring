# Shared Bot conversations and context

This stage replaces production use of the fixed QQ judge/reply/review chain with one OneBot host for private and group conversations. See [runtime ownership](agent-runtime.md) and [conversation persistence and delivery](conversations.md).

~~~mermaid
flowchart TD
  Input[OneBot events and media revisions] --> Journal[Source journal]
  Journal --> Wake[WakeScheduler]
  Wake --> Host[OneBotHost]
  Host --> Context[BotContextSource]
  Context --> Packages[Committed summary packages]
  Host --> Runtime[AgentRuntime]
  Runtime --> Action[Available actions]
  Action --> Modules[Memory and knowledge query/read modules]
  Runtime --> Draft[Response intent or direct draft]
  Draft --> Permit[Host-triggered initiative permission]
  Permit --> Body[Authorized response body]
  Body --> Check[Current source and binding check]
  Check -->|new relevant input| Context
  Check -->|commit| Outbox[Output intent and delivery]
  Outbox --> Queue[Background compression queue]
  Queue --> Compress[ConversationCompressor leaf]
  Compress -->|authority check and CAS| Packages
~~~

## Behavior and configuration

The Agent can invoke an action, propose a response, or stop without output. For initiative paths the host evaluates the intent before independent body generation, retaining the configured score prompt, threshold and judgement projection. A denied permission ends silently; an unreadable judgement verdict fails the round as a visible failure instead of being reported as silence. The Agent can choose none without a score call; scoring is host-triggered rather than an advertised action.

Shared schemes remain shared configuration. Scene, judge, reply, review, sticker, media and compression text retain their roles. An unedited reply task is derived from the per-speaker setting; a saved custom task takes precedence. Review text guides the Agent after new input; it does not introduce a second fixed review loop.

Disabling per-speaker replies allows one logical output for the conversation. Enabling it allows one per authorized target. A logical output can still contain transport parts. Platform IDs, recipient mentions and sticker transport payloads are constructed by the host/sender, not accepted as model-authored routing.

When relevant input arrives during generation, the host exposes source-bound pending_plan data and re-observes the conversation. The Agent can retain, edit or discard the previous draft. max_recompute_count limits additional independent generate calls per target; it does not forbid inline revision or force a stale draft to be sent. The overall step budget remains separate.

One target's score or generation failure need not discard another target's successful output. Cancellation, lost ownership and revoked sources terminate their work. An entirely failed generation is a failed run, not intentional silence, and does not acknowledge the input as successfully consumed.

## Group enablement and group-scoped values

A group binding carries an enable/disable switch and an optional per-group configuration scoped to the binding × Agent pair. A disabled group still receives and stores messages but produces no speech and starts no new model work; summaries and memory organisation already running may complete under the existing pause boundary. The switch never changes the global QQ switch, an Agent's own state or other groups, and blocking reasons are reported as they are.

Group-scoped values either follow the base scheme — including later updates to it — or hold a group-only value; the whole record is saved and replaced under compare-and-swap across the binding, the current Agent, the base scheme and the group record. Overrides belong to the binding × Agent pair: rebinding does not inherit them and switching back restores them, and changing the base scheme previews the change and requires an explicit keep-or-reset choice that does not reset capability disables. Ordinary parameter values apply to the next new round; retrying an existing turn reuses its frozen snapshot while re-checking current disables and source validity. System capabilities offer only follow or disabled-in-this-group: a disable can only narrow what other layers already allow, constrains later calls and not-yet-committed results, and advances a monotonic revision, so a disable/re-enable does not revive a reference captured before the flip. Application-level settings such as retention and model choice have no group override.

## 本群启停与本群配置

一条群绑定带启停开关与可选的「本群配置」，作用域为绑定 × Agent。停用后本群消息照常接收保存，但不发言、不新增模型任务；已在运行的摘要与记忆整理可按既有暂停边界完成。群启停不改变 QQ 总开关、Agent 自身状态与其他群，阻止原因如实展示。

本群值要么跟随基础方案（含之后的基础方案更新），要么保存本群值；整份记录在绑定、当前 Agent、基础方案与群配置的比较交换（CAS）下保存与替换。差异按绑定 × Agent 归属：改绑不继承、切回恢复；更换基础方案先预览并显式选择保留或重置，能力停用不随换方案重置。普通参数下一新轮生效；失败/取消后重试沿用冻结快照，并按当前停用状态与来源有效性复验。系统能力只有「跟随上层 / 本群停用」：停用只能收窄其他层已允许的范围，立即约束后续调用与未提交结果，并推进单调修订——停用再恢复不会让翻转前捕获的引用复活。数据保留、模型选择等应用级设置没有本群覆盖。

## Context and module boundaries

BotContextSource owns decision/reply projections with their separately configured windows and output reserves; the reply projection's message-count bound follows the bound assistant's recent-turns setting rather than the scheme's reply count, while its time window and budget come from the reply group and the judgement projection keeps the scheme's judgement group. ContextEngine renders those materials through the common protocol. Recent conversation windows, pending input and background compression remain host-managed; memory and knowledge are not automatically prefetched into either projection.

MemoryModule and KnowledgeModule expose bounded query/read operations with source provenance. The main Agent decides whether to browse, search or read another page; no independent selector runs behind a query. Memory off disables memory tools, and the other presets bound scans, page entries and cumulative result units while preserving scope isolation and manual-correction precedence. Default SQLite ingestion, maintenance and storage remain module-specific. Alternate backends can provide query and source-resolution implementations through modules/composition.ts without emulating SQLite chunks.

Knowledge enablement, selected documents and budget are frozen at run start. Query/read envelopes, including arguments, provenance and continuation metadata, consume the cumulative allowance across decisions and re-observation; all feedback also consumes total model input capacity. Domain allowances and shared in-flight reservations prevent parallel reads from independently claiming the same remaining space. Source grants remain live and can revoke previously selected evidence.

BotContextSource 保留分别配置的判断/回复窗口与输出预留——回复档条数取绑定助手的近期保留轮数（方案该栏不再生效），分钟与预算取回复档，判断档仍取方案的判断组；近期原文、本轮输入和后台压缩仍由宿主控制，记忆与知识不再自动预取到任一档。主 Agent 通过有界 query/read 决定是否检索和续读，没有隐藏选择模型；记忆关闭禁用对应工具，其余档位约束扫描、每页条数与累计结果额度，范围隔离和人工纠正优先级不变。

知识开关、选定文档和额度在本轮开始时冻结，查询/正文信封的参数、来源和续读信息跨决策及重观察累计计费；所有反馈同时占用模型上下文。资料域额度与同批预留共同约束并发读取，不能各自重复占用同一余量；已消费资料的授权仍实时复验。

The common compressor uses a leaf Agent to summarize selected conversation material. The reply projection reads committed packages and prepares a bounded background job; the host queues it only after the foreground run commits. The worker dispatches replies before starting background compression, without waiting for the summary. Jobs recheck current authority and sources, and an atomic compare-and-swap prevents late results from replacing newer packages. Empty, failed or oversized summaries leave watermarks unchanged. Two monotonic watermarks advance only forward: the historical watermark covers contiguous backlog outside the window, and the covered watermark also includes trimmed window content. Backlog accumulates until a configured trigger is reached, then a bounded package job is created; packages are capped and the oldest whole package is evicted first, and assembly keeps a configured redundancy headroom against the reply tier's output reserve. Shutdown cancels and drains the queue.

Backlog reads follow journal sequence, including count/budget-trimmed messages and delivered assistant text. Packages retain source references, checked again when reused; invalid packages are excluded with diagnostics rather than blocking fresh authorized input indefinitely. After interruption, the next reply projection reconstructs work from the stored watermark; in-flight model streams are not resumable. Compression still shares the model concurrency limit. Optional retrieval failures are visible to the Agent; revocation is not reported as an empty search.

Media understanding is explicit. Ingress records media without starting vision work. The main Agent uses `media.list` to discover conversation-scoped image IDs, `media.read` to attach one listed image as native picture input for the next step, `media.note.read` to page through existing descriptions, and `media.describe` when a description is missing. `media.describe` calls a vision leaf and writes a cache, so it is a serialized write action and cannot be bound in the read-only sandbox; `media.read` is read-only, and a prepared picture or cache hit is not yet real consumption or understanding. When a question asks for higher detail, `media.read` or `media.describe` may carry `questionMessageId`, a pointer to a genuinely recorded question message in this conversation that the host re-verifies; on demand it only supplements the associated higher detail for that question. Recent windows report media presence without injecting cached descriptions. Stored descriptions retain model attribution and source revisions; image transport references are not exposed to the Agent.

The reading adapter supports images and sampled animation frames, not voice transcription or full-video understanding. Reuse is confined to the same account, conversation and Agent. Baseline and higher-detail are separate read tasks, each capped at two attempts for its own purpose; a repeated tool call cannot spend a second attempt in the same run, and retry eligibility requires a later addressed supplement from the journal. Cancellation prevents cache publication. Host authorization can still disable media reading entirely and source isolation still holds; initiative media-failure gates, source expiry and final publication checks remain host responsibilities.

Stickers use `sticker.search` followed by an explicit `stickerIds: [id]` or `stickerIds: []` in a final output. IDs must have been disclosed in the current run and must remain usable with the same revision. There is no post-response selector model. When usable candidates exist, an omitted or null choice produces bounded output feedback before scoring or generation; with no candidates or the module paused, it means no sticker. Sticker-only replies remain possible; transport construction and receipt bookkeeping stay with the host.

媒体理解改为显式调用：入站只记录，不启动视觉。主 Agent 先用 `media.list` 获取本会话图片 ID，`media.read` 把列表中的图片作为原生图片输入下一步，已有描述通过 `media.note.read` 分页读取，缺失时调用 `media.describe`。后者调用视觉叶子并写缓存，因此按串行写动作处理，不进入只读沙箱；`media.read` 为只读，图片已备入缓存或命中缓存不等于真实消费与理解。问题需要更高细节时，`media.read` 或 `media.describe` 可携带 `questionMessageId`——指向本会话中已真实记录的问题消息，由宿主复验；按需只为该问题补充关联的高细节；问题指针本身不授予新的读取次数。近期窗口只提示媒体存在，不注入缓存描述，取流地址不交给模型。

缓存只在相同账号、会话和助手内复用，描述保留模型归属与来源修订。baseline 与高细节是各自独立的读取任务，各自以两次尝试为上限，同run重复调用不消耗第二次；重试资格来自日志中更晚的被叫到补充消息，不能由模型传布尔值授予。取消禁止写缓存，宿主授权仍可整体停用媒体读取、来源隔离保持不变，主动发言媒体闸、过期和发布前复验仍由宿主控制；语音转写和完整视频理解不开放。

表情由 `sticker.search` 后明确填写 `stickerIds: [id]` 或 `[]`，只认本轮披露且当前修订仍可用的候选，不再回复后调用独立选图模型。有候选而省略/null时先反馈纠正，不先评分或生成；关闭或无候选时归一为空。仅发表情仍可用，发送载荷与回执仍由程序处理。

## Scheduling and diagnostics

WakeScheduler owns durable opportunities and leases. OneBot ingress owns protocol normalization; the host owns the current binding, targets and output transaction. Production workers use bounded cross-conversation lanes while database leases exclude concurrent activation of the same conversation. Model concurrency is limited separately; background compression has its own cancellable single-flight queue.

The frontend groups navigation into conversations, Agents, system capabilities, schemes, the Library and Extensions, with model services and preferences as separate entries, while retaining the existing mode and configuration capabilities. Schemes are organized by application; QQ group and private conversations share the same scheme space, and connection bindings link directly to the scheme they use. Conversation history, run inspection and delivery states are separate projections. Advanced diagnostics do not turn model completion into a delivery confirmation; unknown delivery remains unresolved until reconciled.

Synthetic tests cover run decisions, source changes, media, target isolation, history restoration and delivery recovery. Legacy QQ fixtures are comparison oracles only. Real model latency/quality and real OneBot receipts require separate measurement; no exactly-once network guarantee is claimed.
