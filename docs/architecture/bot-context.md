# Shared Bot conversations and context

This stage replaces production use of the fixed QQ judge/reply/review chain with one OneBot host for private and group conversations. See [runtime ownership](agent-runtime.md) and [conversation persistence and delivery](conversations.md).

~~~mermaid
flowchart TD
  Input[OneBot events and media revisions] --> Journal[Source journal]
  Journal --> Wake[WakeScheduler]
  Wake --> Host[OneBotHost]
  Host --> Context[BotContextSource]
  Context --> Modules[Memory and knowledge modules]
  Context --> Compress[ConversationCompressor]
  Host --> Runtime[AgentRuntime]
  Runtime --> Action[Available actions]
  Action --> Score[speech.evaluate]
  Action --> Modules
  Runtime --> Draft[inline or generate drafts]
  Draft --> Check[Current source and binding check]
  Check -->|new relevant input| Context
  Check -->|commit| Outbox[Output intent and delivery]
~~~

## Behavior and configuration

The Agent can invoke an action, return drafts, or stop without output. Initiative paths require a current successful speech.evaluate result before committing a reply. That leaf retains the configured score prompt, threshold and judgement readout. The Agent can choose none without first invoking the score action; there is no mandatory judge call for every wake.

Shared schemes remain shared configuration. Scene, judge, review, sticker and media text retain their roles. The reply task is derived from the per-speaker setting. Review text guides the Agent after new input; it does not introduce a second fixed review loop.

Disabling per-speaker replies allows one logical output for the conversation. Enabling it allows one per authorized target. A logical output can still contain transport parts. Platform IDs, recipient mentions and sticker transport payloads are constructed by the host/sender, not accepted as model-authored routing.

When relevant input arrives during generation, the host exposes source-bound pending_plan data and re-observes the conversation. The Agent can retain, edit or discard the previous draft. max_recompute_count limits additional independent generate calls per target; it does not forbid inline revision or force a stale draft to be sent. The overall step budget remains separate.

One target's score or generation failure need not discard another target's successful output. Cancellation, lost ownership and revoked sources terminate their work. An entirely failed generation is a failed run, not intentional silence, and does not acknowledge the input as successfully consumed.

## Context and module boundaries

BotContextSource owns decision/reply projections with their separately configured windows and output reserves. ContextEngine renders those materials through the common protocol. Web retains its retry snapshot and evidence selection strategy; shared rendering does not replace every source's strategy with the same algorithm.

Memory retrieval retains the configured modes, scope isolation and manual-correction precedence. MemoryModule and KnowledgeModule return evidence with provenance; default SQLite ingestion, maintenance and storage remain module-specific. Alternate backends can provide query and source-resolution implementations through modules/composition.ts without emulating SQLite chunks.

Knowledge enablement, selected documents and budget are frozen at run start. The budget accounts for initial evidence and retained nonempty query observations, including their arguments and provenance, across subsequent decisions and re-observation. Empty-result feedback still consumes total model input capacity. Source grants remain live and can revoke previously selected evidence.

The common compressor uses a leaf Agent to summarize selected conversation material. Its output has source references and expiry and is supplemental to the current authorized input. A failed optional summary or retrieval can retain valid raw context and expose retrieval_status to the Agent. Cancellation, access revocation and a full-mode capacity violation remain failures; these are not silently converted to partial evidence.

Media reading, sticker annotation and sticker selection use the same leaf runtime. Stored contexts carry image references and metadata rather than reusable image bytes. Image acquisition, media failure gates, source expiry, sticker availability and receipt bookkeeping remain channel responsibilities.

## Scheduling and diagnostics

WakeScheduler owns durable opportunities and leases. OneBot ingress owns protocol normalization; the host owns the current binding, targets and output transaction. The default production worker is serial. A concurrency capacity setting alone does not create parallel worker execution, and slow runs can delay other Bot conversations.

The frontend groups navigation into conversations, Agents, resources, connections and preferences, while retaining the existing mode and configuration capabilities. Conversation history, run inspection and delivery states are separate projections. Advanced diagnostics do not turn model completion into a delivery confirmation; unknown delivery remains unresolved until reconciled.

Synthetic tests cover run decisions, source changes, media, target isolation, history restoration and delivery recovery. Legacy QQ fixtures are comparison oracles only. Real model latency/quality and real OneBot receipts require separate measurement; no exactly-once network guarantee is claimed.
