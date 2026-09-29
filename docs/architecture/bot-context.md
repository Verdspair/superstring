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

The Agent can invoke an action, propose a response, or stop without output. For initiative paths the host evaluates the intent before independent body generation, retaining the configured score prompt, threshold and judgement projection. A denied or unreadable permission ends silently. The Agent can choose none without a score call; scoring is host-triggered rather than an advertised action.

Shared schemes remain shared configuration. Scene, judge, reply, review, sticker, media and compression text retain their roles. An unedited reply task is derived from the per-speaker setting; a saved custom task takes precedence. Review text guides the Agent after new input; it does not introduce a second fixed review loop.

Disabling per-speaker replies allows one logical output for the conversation. Enabling it allows one per authorized target. A logical output can still contain transport parts. Platform IDs, recipient mentions and sticker transport payloads are constructed by the host/sender, not accepted as model-authored routing.

When relevant input arrives during generation, the host exposes source-bound pending_plan data and re-observes the conversation. The Agent can retain, edit or discard the previous draft. max_recompute_count limits additional independent generate calls per target; it does not forbid inline revision or force a stale draft to be sent. The overall step budget remains separate.

One target's score or generation failure need not discard another target's successful output. Cancellation, lost ownership and revoked sources terminate their work. An entirely failed generation is a failed run, not intentional silence, and does not acknowledge the input as successfully consumed.

## Context and module boundaries

BotContextSource owns decision/reply projections with their separately configured windows and output reserves. ContextEngine renders those materials through the common protocol. Recent conversation windows, pending input and background compression remain host-managed; memory and knowledge are not automatically prefetched into either projection.

MemoryModule and KnowledgeModule expose bounded query/read operations with source provenance. The main Agent decides whether to browse, search or read another page; no independent selector runs behind a query. Memory off disables memory tools, and the other presets bound scans, page entries and cumulative result units while preserving scope isolation and manual-correction precedence. Default SQLite ingestion, maintenance and storage remain module-specific. Alternate backends can provide query and source-resolution implementations through modules/composition.ts without emulating SQLite chunks.

Knowledge enablement, selected documents and budget are frozen at run start. Query/read envelopes, including arguments, provenance and continuation metadata, consume the cumulative allowance across decisions and re-observation; all feedback also consumes total model input capacity. Domain allowances and shared in-flight reservations prevent parallel reads from independently claiming the same remaining space. Source grants remain live and can revoke previously selected evidence.

BotContextSource 保留分别配置的判断/回复窗口与输出预留；近期原文、本轮输入和后台压缩仍由宿主控制，记忆与知识不再自动预取到任一档。主 Agent 通过有界 query/read 决定是否检索和续读，没有隐藏选择模型；记忆关闭禁用对应工具，其余档位约束扫描、每页条数与累计结果额度，范围隔离和人工纠正优先级不变。

知识开关、选定文档和额度在本轮开始时冻结，查询/正文信封的参数、来源和续读信息跨决策及重观察累计计费；所有反馈同时占用模型上下文。资料域额度与同批预留共同约束并发读取，不能各自重复占用同一余量；已消费资料的授权仍实时复验。

The common compressor uses a leaf Agent to summarize selected conversation material. The reply projection reads committed packages and prepares a bounded background job; the host queues it only after the foreground run commits. The worker dispatches replies before starting background compression, without waiting for the summary. Jobs recheck current authority and sources, and an atomic compare-and-swap prevents late results from replacing newer packages. Empty, failed or oversized summaries leave watermarks unchanged. Shutdown cancels and drains the queue.

Backlog reads follow journal sequence, including count/budget-trimmed messages and delivered assistant text. Packages retain source references, checked again when reused; invalid packages are excluded with diagnostics rather than blocking fresh authorized input indefinitely. After interruption, the next reply projection reconstructs work from the stored watermark; in-flight model streams are not resumable. Compression still shares the model concurrency limit. Optional retrieval failures are visible to the Agent; revocation is not reported as an empty search.

Media understanding is explicit. Ingress records media without starting vision work. The main Agent uses `media.list` to discover conversation-scoped image IDs, `media.note.read` to page through existing descriptions, and `media.describe` when a description is missing. The last action calls a vision leaf and writes a cache, so it is a serialized write action and cannot be bound in the read-only sandbox. Recent windows report media presence without injecting cached descriptions. Stored descriptions retain model attribution and source revisions; image transport references are not exposed to the Agent.

The reading adapter supports images and sampled animation frames, not voice transcription or full-video understanding. Reuse is confined to the same account, conversation and Agent. Each image retains its two-attempt ceiling; a repeated tool call cannot spend a second attempt in the same run, and retry eligibility requires a later addressed supplement from the journal. Cancellation prevents cache publication. Initiative media-failure gates, source expiry and final publication checks remain host responsibilities.

Stickers use `sticker.search` followed by an explicit `stickerIds: [id]` or `stickerIds: []` in a final output. IDs must have been disclosed in the current run and must remain usable with the same revision. There is no post-response selector model. When usable candidates exist, an omitted or null choice produces bounded output feedback before scoring or generation; with no candidates or the module paused, it means no sticker. Sticker-only replies remain possible; transport construction and receipt bookkeeping stay with the host.

媒体理解改为显式调用：入站只记录，不启动视觉。主 Agent 先用 `media.list` 获取本会话图片 ID，已有描述通过 `media.note.read` 分页读取，缺失时调用 `media.describe`。后者调用视觉叶子并写缓存，因此按串行写动作处理，不进入只读沙箱；近期窗口只提示媒体存在，不注入缓存描述，取流地址不交给模型。

缓存只在相同账号、会话和助手内复用，描述保留模型归属与来源修订。每项图片最多两次尝试，同run重复调用不消耗第二次；重试资格来自日志中更晚的被叫到补充消息，不能由模型传布尔值授予。取消禁止写缓存，主动发言媒体闸、过期和发布前复验仍由宿主控制；语音转写和完整视频理解不开放。

表情由 `sticker.search` 后明确填写 `stickerIds: [id]` 或 `[]`，只认本轮披露且当前修订仍可用的候选，不再回复后调用独立选图模型。有候选而省略/null时先反馈纠正，不先评分或生成；关闭或无候选时归一为空。仅发表情仍可用，发送载荷与回执仍由程序处理。

## Scheduling and diagnostics

WakeScheduler owns durable opportunities and leases. OneBot ingress owns protocol normalization; the host owns the current binding, targets and output transaction. Production workers use bounded cross-conversation lanes while database leases exclude concurrent activation of the same conversation. Model concurrency is limited separately; background compression has its own cancellable single-flight queue.

The frontend groups navigation into conversations, Agents, resources, connections and preferences, while retaining the existing mode and configuration capabilities. Conversation history, run inspection and delivery states are separate projections. Advanced diagnostics do not turn model completion into a delivery confirmation; unknown delivery remains unresolved until reconciled.

Synthetic tests cover run decisions, source changes, media, target isolation, history restoration and delivery recovery. Legacy QQ fixtures are comparison oracles only. Real model latency/quality and real OneBot receipts require separate measurement; no exactly-once network guarantee is claimed.
