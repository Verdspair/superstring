# Shared Bot conversations and context

This stage replaces production use of the fixed QQ judge/reply/review chain with one OneBot host for private and group conversations. See [runtime ownership](agent-runtime.md) and [conversation persistence and delivery](conversations.md).

~~~mermaid
flowchart TD
  Input[OneBot events and media revisions] --> Journal[Source journal]
  Journal --> Wake[WakeScheduler]
  Wake --> Host[OneBotHost]
  Host --> Context[BotContextSource]
  Context --> Modules[Memory and knowledge modules]
  Context --> Packages[Committed summary packages]
  Host --> Runtime[AgentRuntime]
  Runtime --> Action[Available actions]
  Action --> Modules
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

BotContextSource owns decision/reply projections with their separately configured windows and output reserves. ContextEngine renders those materials through the common protocol. Web retains its retry snapshot and evidence selection strategy; shared rendering does not replace every source's strategy with the same algorithm.

Memory retrieval retains the configured modes, scope isolation and manual-correction precedence. MemoryModule and KnowledgeModule return evidence with provenance; default SQLite ingestion, maintenance and storage remain module-specific. Alternate backends can provide query and source-resolution implementations through modules/composition.ts without emulating SQLite chunks.

Knowledge enablement, selected documents and budget are frozen at run start. The budget accounts for initial evidence and retained nonempty query observations, including their arguments and provenance, across subsequent decisions and re-observation. Empty-result feedback still consumes total model input capacity. Source grants remain live and can revoke previously selected evidence.

The common compressor uses a leaf Agent to summarize selected conversation material. The reply projection reads committed packages and prepares a bounded background job; the host queues it only after the foreground run commits. The worker dispatches replies before starting background compression, without waiting for the summary. Jobs recheck current authority and sources, and an atomic compare-and-swap prevents late results from replacing newer packages. Empty, failed or oversized summaries leave watermarks unchanged. Shutdown cancels and drains the queue.

Backlog reads follow journal sequence, including count/budget-trimmed messages and delivered assistant text. Packages retain source references, checked again when reused; invalid packages are excluded with diagnostics rather than blocking fresh authorized input indefinitely. After interruption, the next reply projection reconstructs work from the stored watermark; in-flight model streams are not resumable. Compression still shares the model concurrency limit. Optional retrieval failures are visible to the Agent; revocation is not reported as an empty search.

Media reading, sticker annotation and sticker selection use the same leaf runtime. Stored contexts carry image references and metadata rather than reusable image bytes. Image acquisition, media failure gates, source expiry, sticker availability and receipt bookkeeping remain channel responsibilities.

The reading adapter declares which media kinds it can actually read. In this version that is images only: voice and video are refused before any attempt is spent, so "not readable here" stays distinct from "a read we tried and failed". An identical source reference already described inside the same conversation is reused without another model call, keeping the original attribution. A document, an unread picture and an unsupported voice message are three different facts in the timeline.

## Scheduling and diagnostics

WakeScheduler owns durable opportunities and leases. OneBot ingress owns protocol normalization; the host owns the current binding, targets and output transaction. Production workers use bounded cross-conversation lanes while database leases exclude concurrent activation of the same conversation. Model concurrency is limited separately; background compression has its own cancellable single-flight queue.

The frontend groups navigation into conversations, Agents, resources, connections and preferences, while retaining the existing mode and configuration capabilities. Conversation history, run inspection and delivery states are separate projections. Advanced diagnostics do not turn model completion into a delivery confirmation; unknown delivery remains unresolved until reconciled.

Synthetic tests cover run decisions, source changes, media, target isolation, history restoration and delivery recovery. Legacy QQ fixtures are comparison oracles only. Real model latency/quality and real OneBot receipts require separate measurement; no exactly-once network guarantee is claimed.
