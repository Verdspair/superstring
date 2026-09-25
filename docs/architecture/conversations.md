# Conversations, wake scheduling and delivery

Web and OneBot private conversations use the same conversational AgentRuntime. Group conversations retain the previous production dispatcher until stage 3. Web owns HTTP/SSE and turn leases; the private OneBot host owns platform addressing and durable wake opportunities.

~~~mermaid
flowchart LR
  Web[Web request] --> Host[ConversationHost]
  Bot[OneBot observation] --> Journal[(Source journal)]
  Journal --> Wake[(Durable wake)]
  Wake --> Host
  Host --> Agent[AgentRuntime]
  Agent --> Draft[Output drafts]
  Draft --> SSE[Web transactional message commit + SSE]
  Draft --> Intent[(OneBot output intent)]
  Intent --> Sender[Platform delivery]
  Sender --> Receipt[(Per-part receipt)]
~~~

## Data and ownership

- Migration 0040 adds conversation activations, source references and wakes. Migration 0041 adds output intents and ordered parts. Existing source tables retain canonical message bodies.
- An activation has an immutable ID, assistant binding epoch and local sequence. A wake's throughSeq belongs to that activation; a historical read cursor must never acknowledge a wake.
- Web retains client request idempotency and its generation token. Agent runs record execution; they do not introduce another independent turn lock.
- A successful local run can commit output intent before the network sends. Local completion is not confirmation of delivery.
- Unsent, failed and unknown parts remain distinct. A crash during sending becomes unknown; it is not automatically resent.
- Independent target failures remain visible without dropping successful targets. A completely failed generation is not no_output.
- A logical reply may contain several transport parts. Disabling per-speaker replies permits one logical output, not multiple independent replies.

## Stable assistant history

Read APIs expose one stable history ID per binding and assistant, using the first actual activation ID as the canonical ID. A→B→A restores A's retained timeline and run diagnostics without including B's history.

Historical event cursors concatenate sealed activation ranges. Execution continues to use the current activation ID and its own sequence. Closed activations cannot append, claim a wake or authorize delivery, even when their history becomes readable again.

If the upgrade first indexed another assistant, later switching to an assistant whose data predates the journal imports its existing source references as a consumed historical prefix. It creates no fictional old run or activation and emits no wake. Source watermarks prevent an old mention from reactivating during that recovery. Initial upgrade backfill of the currently bound assistant instead preserves valid legacy wake opportunities. Repeated backfill is idempotent.

Retention and authorization remain source-authoritative. Restoring history does not restore deleted or expired text. Historical inspection is a read permission, never authority to resume an old task or send an old draft.

## Configuration and context

The host freezes assistant and knowledge read configuration when a run starts. Enablement, selected document scope and cumulative context budget apply to the evidence supported by that stage and later query actions, within current document grants.

Changing read preferences affects the next run; actual source revocation or binding changes still invalidate current use. Empty query feedback consumes overall model context, but does not count as retained knowledge evidence.

A generation token, a job lease and a model request timeout serve different owners. A lease loss cancels its work; the channel still owns the final transaction.

## Upgrade and rollback

Before switching a running deployment:

1. Stop the old worker, intake connection and automatic restart. Finish or record the state of in-flight delivery.
2. Close the database and make a consistent backup with its version and checksum.
3. Test the migration and repeated reference backfill on a copy. Run the migration inventory checker; packaging and native acceptance must agree with the stage's schema.
4. Start the new process with external sending disabled. Inspect candidate transfer, watermarks, leases and unresolved deliveries.
5. Enable controlled live verification only under the deployment's QQ authorization.

Do not run old and new consumers for the same bindings. With forward-only schemas, rollback restores the matching old binary and database backup; the old binary must not open the upgraded database. Preserve any post-backup facts separately before rollback.

Source and synthetic integration tests cover crash/lease/unknown behavior. Actual platform receipts and native installation require environment verification; neither is implied by unit tests.
