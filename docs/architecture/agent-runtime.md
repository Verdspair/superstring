# Unified Agent runtime

The refactor converges model execution on AgentRuntime. Background tasks can use a one-step leaf Agent; conversational Agents can inspect context, invoke an available action, produce output drafts, or stop without output.

Compatibility with old workflows is transitional. The architecture permits better retrieval and Agent-directed behavior; important capabilities, effective configuration, source authorization and delivery correctness must remain intact.

## Ownership

| Module | Responsibility |
| --- | --- |
| agent/agent-runtime.ts | Model attempts, action observations, steps, cancellation and run records. |
| agent/model-port.ts | Text, streaming and multimodal inference adapter. The initial adapter retains existing provider routing and structured-output fallback. |
| agent/context-engine.ts | Render explicit context material and observations; expose the exact source-bound input used for a step. |
| modules/ | Memory and knowledge query contracts and default SQLite implementations. Backend-specific storage and maintenance stay in their modules. |
| services/memory-service.ts, knowledge-organizer.ts | Business job leases, versions, retry policy and publication transactions. A model attempt does not own the maintenance transaction. |
| db/agent-run-repository.ts | Run/step/context persistence. These records do not replace business ownership tokens. |

A leaf receives explicit messages and source references and calls ModelPort once. It does not recursively build conversation context. A maintenance retry creates another attempt under the same business job; Runtime does not independently retry the job's writes.

A conversational step returns invoke, final, or none. Only advertised actions and authorized targets are usable. JSON must satisfy the strict decision schema; a complete outer JSON code fence is accepted without extracting instructions from surrounding prose. Parse failure remains visible, not synthetic silence.

Output drafts are not network sends. The channel host owns authorization, current state and output commit. Future tools and Skills can use these action/context seams; no external tools, MCP or Skill provider framework is included.

## Context and retention

Evidence and action observations carry source identity, revision and expiry. Context snapshots retain the actual rendered text, with layout and hashes for inspection. Images retain references and metadata, not image bytes. Inspection checks owner access and source validity.

Deleting or revoking a source invalidates derived exact snapshots. Expiry follows the earliest source expiry; the runtime periodically clears expired text. Metadata may remain for diagnosis. This is application-level retention, not a claim of immediate physical disk erasure.

Model capacity, an auxiliary call timeout and a business job deadline are different budgets. An optional Agent deadline does not replace the existing task deadlines. Streaming cancellation must propagate to the underlying request.

## Staged migration

1. Runtime, leaf consumers, module boundaries and run inspection; migration 0039. Existing channel loops still serve conversations in this stage.
2. Web and OneBot private conversations, source journal, durable wakes/outbox; migrations 0040 and 0041.
3. Shared/group conversations and one Bot context/host; retire production use of the fixed QQ pipeline.

Each stage has its own build and migration checks. Tests under fixtures/legacy-qq, once introduced in stage 3, preserve baseline behavior as comparison oracles; they are not evidence that the new production host has executed those paths.

## Verification

Run from the repository root:

~~~sh
bun install --frozen-lockfile
bun run typecheck
bun run check
bun tools/verify/verify-migration-inventory.mjs
bun test tests/integration tests/contracts
bun run test:web
bun run build
~~~

Deterministic tests use synthetic models and transports. Live model quality/latency, actual OneBot delivery and native installation remain separate environment checks. Local screenshots, run logs and temporary browser fixtures are not source deliverables.
