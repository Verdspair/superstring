# Runtime observability

The **Agent → Runtime observability** page searches execution metadata across Web,
OneBot, memory and knowledge work. A conversation's **Observability** tab uses the
same explorer with the conversation filter fixed. The conversation header reads
live connection, wake queue and delivery state separately from historical counts.

## Investigating a missing reply

1. Open the conversation and inspect the connection state and next wake deadline.
2. Open Observability, choose the time range and inspect ingress and wake records.
   A skipped/deferred wake is different from a model call that started and failed.
3. Open a Trace to follow parent/child stages. Inspect the reason code, source
   sequence, Run ID, Wake ID and Output ID. Run details link to the existing
   authorized context inspector; delivery details show each part's outcome.
4. For background work or cross-conversation diagnosis, use the global page.
   Filter by channel, stage, status, model, time, agent, conversation, run or trace.

Search covers the complete retained, authorized result set on the server, not
only the currently displayed page. It searches names, reason codes, model names,
correlation IDs and scalar metadata. It does not search message or prompt bodies.
Counters describe matching **stages**, not the number of conversations or runs.
`unknown` delivery remains a reconciliation outcome; reading a trace never sends
or retries a message.

## Trace model

OpenTelemetry supplies trace/span IDs, parent context and async context
propagation. Each application runtime owns its provider and context manager; it
does not register a process-global provider or send telemetry to an external
collector. A local SQLite processor records the start of a span immediately so
an unfinished model call remains visible. Terminal records add status and elapsed
time. Persisted wake/run/output references reconnect asynchronous queue work.

Business modules retain ownership of transactions, leases, source validation and
retries. Tracing failures do not convert successful external actions into retries.
On application restart, previously unfinished spans become `unknown` with reason
`PROCESS_INTERRUPTED`; this does not decide the business operation's recovery.

Records contain metadata only. Prompt snapshots and attachment bytes remain in
their existing source-owned stores. Existing conversation/assistant ownership is
checked on every read, including trace drilldown and aggregate counts. Records
expire after at most 14 days and earlier when an input source expires; the earliest
source lifetime applies to the complete trace. Conversation, agent, user and run
deletion cascades through their associated metadata. Old activity is not fabricated
as new telemetry during upgrade.

## Read APIs

- `GET /v2/observability/spans`
- `GET /v2/observability/traces/:traceId`
- `GET /v2/conversations/:id/status`

Span query parameters: `q`, `channel`, `stage`, `status`, `model`, `from`, `to`,
`conversationId`, `agentId`, `runId`, `traceId`, `beforeId`, `limit`. Times use ISO
UTC strings, the model filter is exact, and `beforeId` is an exclusive descending
cursor. `summary` applies all filters except the pagination cursor. Trace detail
is also paginated and subject to the same authorization and retention rules.
Responses are `Cache-Control: no-store`.

History supports `direction=latest|before|after`, `beforeSeq`, `afterSeq` and
`limit`. Items within a history page remain chronological. Clients open the latest
page at its end, prepend older pages without losing the current message anchor,
and only follow incoming messages automatically while the reader is at the bottom.
The cursor is the stable read-history sequence across restored assistant bindings,
not the execution acknowledgment cursor.
