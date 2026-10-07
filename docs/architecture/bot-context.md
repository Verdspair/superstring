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
  Runtime --> Direct[Direct reply: first call full reply]
  Runtime --> Batch[Initiative batch: one score and intent call]
  Batch -->|threshold pass| Reply[Per-target reply tasks]
  Batch -->|malformed verdict or model failure| Failed[Whole batch visible failure]
  Direct --> Reply
  Reply --> Check[Current source and binding check]
  Check -->|new relevant input| Context
  Check -->|minimal checks| Early[Per-target early commit]
  Early --> Outbox[Output intent and delivery]
  Outbox --> Queue[Background compression queue]
  Queue --> Compress[ConversationCompressor leaf]
  Compress -->|authority check and CAS| Packages
~~~

## Behavior and configuration

Agent 可以调用动作、产出输出或停止不发言。QQ 会话有四种模式。直接回应（群 @ 或引用、私聊）进入工具可用的回复任务，首次模型调用即携带完整回复材料，没有独立意图轮；模型仍可按需调用工具，合法 `none` 仍然可能。连续交谈按稳定发言人 ID 的独立滚动窗口合并消息，窗口到期必回：合并只用于连续模式，没有评分或意图调用，他人消息不会顺延某发言人的窗口。连续交谈与自主接话在同一生效归属下互斥，开启其一自动关闭另一项；历史存量两者同真按自主接话优先生效，新显式同真配置被拒绝。
自主接话把落在配置 [X−Y, X+Y] 区间内的消息交给一次批量评分调用，一次返回每个候选目标的评分、意图描述与来源引用；宿主按配置门槛过滤，没有独立意图决策轮。判定格式错误或模型调用失败是整批可见失败并按异常记录——整批失败不会被当作低分，也不静默吞掉已观察消息；回复生成阶段的失败仍按目标隔离。批次用自己的持久观察边界计数，与全局消费序号无关；上界繁忙策略默认在并发占满时保留一个合并机会，关闭则跳过该批并记录原因。
冷场发起从会话级静默基础出发，用一次判断调用取得本会话评分与话题意图再进入回复任务；不消费连续合并窗口，也不消费自主消息计数。评分门槛与回复判定文案保持其配置角色。技能目录首轮只暴露简短 name/description 元数据，正文按需加载；加载指导不是权限授予。
The Agent can invoke an action, produce output, or stop without output. QQ conversations run in four modes. A direct reply — group @ or quote, private message — enters a tool-capable reply task whose first model call already carries full reply materials; there is no separate intent round, the model may still call tools when needed, and a legitimate `none` remains possible. Continuous conversation merges each speaker's messages on an independent rolling window keyed by the stable person ID and must reply when that window matures: merging applies only to continuous mode, there is no score or intent call, and other speakers' messages never postpone a speaker's window. Continuous and autonomous modes are mutually exclusive under one effective owner — enabling one turns the other off; legacy stored both-true configurations keep autonomous precedence, and new explicit both-true writes are rejected.
Autonomous initiative puts messages counted in the configured [X−Y, X+Y] band into one batch scoring call that returns a score, an intent description and source references for every candidate target at once; the host filters by the configured threshold and there is no separate intent-decision round. A malformed verdict or a failed model call is a visible batch failure recorded as an exception — the whole batch fails, it is not read as low scores, and it does not silently consume the observed messages; failures during reply generation stay isolated per target. The batch counts messages against its own persisted observation boundary, independent of the global consumed sequence, and an upper-bound busy policy either keeps one merged opportunity while the model concurrency cap is full (default) or skips the batch with a logged reason.
Idle topic starts from one conversation-level quiet basis and uses a single judge call for the conversation's score and topic intent before the reply task; it consumes neither the continuous merge window nor the autonomous message counts. Score thresholds and reply judgement text keep their configured roles. Skill catalogs expose short name/description metadata in the first round and load bodies on demand; loading guidance is not a permission grant.

Shared schemes remain shared configuration. Scene, judge, reply, review, sticker, media and compression text retain their roles. An unedited reply task is derived from the per-speaker setting; a saved custom task takes precedence. Review text guides the Agent after new input; it does not introduce a second fixed review loop.

拆分按模式区分：连续交谈按稳定发言人 ID 回复每个到期发言人；自主批按回复拆分设置——开启时每个达标目标各一个回复任务，关闭时整间会话一个聚合逻辑回复、完整覆盖全部达标意图而非只取最高分；冷场面向整间会话的一个逻辑目标；直接回应沿用既有按发言人设置。是否 @ 由模型决定：输出协议对每个新文本部件携带结构化 mentions 列表（不 @ 时为空数组），宿主把授权稳定 ID 编码为 `at` 段，正文中的 CQ 码按字面文本处理，伪造或未授权的成员由宿主拒绝；表情发送载荷仍由程序构造。

Disabling per-speaker replies allows one logical output for the conversation. Enabling it allows one per authorized target. A logical output can still contain transport parts. Splitting is per-mode: continuous conversation replies to each matured speaker by stable person ID, an autonomous batch follows the reply-split setting — split on creates one reply task per qualifying target, split off creates one aggregate logical reply for the room that covers every qualifying intent, never only the highest-scored one — idle topic replies to the conversation as one logical target, and direct replies follow the existing per-speaker setting. Whether to mention a recipient is the model's choice: the output protocol carries a structured mentions list per new text part (empty when none is wanted), and the host encodes authorized stable IDs into `at` segments; message bodies keep CQ codes as literal text, and forged or unauthorized members are rejected by the host. Sticker transport payloads are constructed by the host/sender, not accepted as model-authored routing.

When relevant input arrives during generation, the host exposes source-bound pending_plan data and re-observes the conversation. The Agent can retain, edit or discard the previous draft. max_recompute_count limits additional independent generate calls per target; it does not forbid inline revision or force a stale draft to be sent. The overall step budget remains separate.

批量评分失败按整批一次可见失败结算；回复阶段失败按目标隔离，不影响其他目标已提交的输出。每个目标通过最小程序化检查即提交，不等整批收口；父 run 跟踪全部目标到 prepared/committed/failed/cancelled 并在全部结算后释放生成资源；delivered/unknown 属出站层平台回执，父 run 不等待平台回执结束。中断批次用稳定键恢复并复验当前来源与绑定有效性，不重新生成也不重发已提交内容。取消、失去归属与来源撤权终止其工作；完全失败的生成是失败运行而非有意沉默，也不把输入记作已成功消费。

A batch scoring failure fails the whole batch as one visible failure; reply-stage failures stay isolated per target and need not discard another target's already-committed output. Each target commits as soon as its minimal programmatic checks pass, without waiting for the batch to settle; the parent run tracks every target to prepared, committed, failed or cancelled and releases generation resources once all targets settle; delivered and unknown outcomes belong to the outbound layer's platform receipts, so the parent run does not wait for the platform. An interrupted batch resumes with stable intent keys, re-verifying current source and binding validity instead of regenerating or resending committed work. Cancellation, lost ownership and revoked sources terminate their work. An entirely failed generation is a failed run, not intentional silence, and does not acknowledge the input as successfully consumed.

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

默认并发（整机 4、单供应商 2）是代码内调度候选，不是实测硬件最优；派发在同一准入点要求全局与目标供应商名额同时可用，显式配置值不会被静默覆盖。

WakeScheduler owns durable opportunities and leases. OneBot ingress owns protocol normalization; the host owns the current binding, targets and output transaction. Production workers use bounded cross-conversation lanes while database leases exclude concurrent activation of the same conversation. Model concurrency is limited separately: dispatch requires both the global and the target provider slot at one admission point, and the code-level defaults (four whole-machine, two per provider) are scheduling candidates, not measured hardware optima; explicit configuration values are never silently overridden. Background compression has its own cancellable single-flight queue.

The frontend groups navigation into conversations, Agents, system capabilities, schemes, the Library and Extensions, with model services and preferences as separate entries, while retaining the existing mode and configuration capabilities. Schemes are organized by application; QQ group and private conversations share the same scheme space, and connection bindings link directly to the scheme they use. Conversation history, run inspection and delivery states are separate projections. Advanced diagnostics do not turn model completion into a delivery confirmation; unknown delivery remains unresolved until reconciled.

Synthetic tests cover run decisions, source changes, media, target isolation, history restoration and delivery recovery. Legacy QQ fixtures are comparison oracles only. Real model latency/quality and real OneBot receipts require separate measurement; no exactly-once network guarantee is claimed.
