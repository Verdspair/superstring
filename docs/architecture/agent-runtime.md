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

Output drafts are not network sends. The channel host owns authorization, current state and output commit.

## Tools, external servers and orchestration

A single tool catalog is the only source of truth: each action declares its parameters, its side-effect class and whether a code sandbox may bind it. Direct model-issued calls and programmatic (script) execution read the same catalog, so the two can never disagree about what exists or what is allowed. Sandbox bindings, wall-clock/call/result limits and the host re-check around every tool call are enforced by the runtime; the sandbox is a replaceable port. Application assembly supplies a QuickJS WebAssembly implementation, while the policy switch defaults to off and an explicit model capability is still required.

MCP registration contains connection settings and an explicit, default-off trust setting for server read-only annotations. Tool grants and script approvals share a local `permissions.json` policy, a `PermissionService` and an `ActionExecutor`; adapters describe requirements instead of implementing separate allowlists. Policies may narrow access by Agent and declared directory, and approvals for side-effecting tools bind to a resource revision. The same executor checks direct calls and sandbox bindings before execution and after success or failure. Captured actions cannot survive revocation, and runs revalidate consumed actions before further inference and publication.

Permission fingerprints are source references resolved by the existing inspection and delivery boundaries. Knowledge and memory retain their domain-specific ownership and scope checks rather than becoming global tool grants. The local same-origin management API is separate from model-visible actions; instructions cannot approve themselves. Policy writes use revision checks and atomic replacement.

MCP supports multiple enabled servers. Changed or invalid configuration disables captured actions; connection shutdown drains in-flight setup. Credentials should be referenced through environment variables; children receive only necessary and explicitly configured environment values. Local configuration remains protected data and may be included in local backups, so it is not a secret-exclusion guarantee.

The MCP adapter uses the official TypeScript client with 2026-07-28-first negotiation and legacy transport compatibility. JSON Schema 2020-12 and draft-07 validation never fetches network references. Structured results retain their JSON values and share the text result limit. Catalog notifications invalidate captured tools before rediscovery; stream cancellation and request deadlines remain owned by the adapter. Read-only annotations affect execution only for explicitly trusted servers; grants are still required. Optional sampling, elicitation, roots and interactive OAuth are not advertised by this application.

MCP 适配使用官方 TypeScript 客户端，优先协商 2026-07-28 并兼容旧传输。JSON Schema 2020-12 与 draft-07 校验不读取网络引用；结构化结果保留原 JSON 值，并和文本共同受结果上限约束。目录变化先使已捕获工具失效再重新发现，取消与请求期限由适配层管理。只有显式信任的服务，其只读提示才影响执行方式，统一授权仍必需；应用不声明可选的模型采样、信息征询和根目录能力，也不提供交互式 OAuth 登录。

Skills expose a metadata catalog and on-demand instructions. Explicitly approved scripts run through a native-process adapter with an explicit interpreter, timeout, output limits and entry-path checks. Script approval is bound to the manifest, instructions and declared entry files; modified content requires approval again. Extra directory grants describe consent, not an operating-system sandbox; native scripts run with the application's privileges and network access. Transitive dependencies and descendant-process isolation require a trusted installation or a real sandbox.

## Durable tool plans and optional execution

External writes are queued through `AgentTaskService`; a queued response is not a successful tool result. `AgentTaskRepository` stores bounded plans, per-call checkpoints and leases, while `ActionExecutor` remains the only execution boundary. Approval waits release the task lease and do not retain a foreground conversation lease. Single-use approvals bind to the task, call ordinal, arguments, tool revision, actor and permission fingerprint; they do not alter persistent grants. Interrupted writes with an uncertain outcome remain `unknown` and are not replayed. Interrupted reads can be reclaimed after lease expiry, and completed checkpoints are skipped.

Task results belong to the originating conversation and are read on demand. They cannot publish messages. Source checks reuse domain memory scopes and knowledge grants; revocation or expiry clears stored arguments and results. Task retention is at most one day and shortens with source expiry. Pause prevents execution without deleting otherwise authorized checkpoints.

Optional research uses the same Runtime with a read-only subset of the parent's advertised tools, one nesting level and at most two child calls. Children have no channel commit callback, inherit cancellation and the shared budget, and return bounded conclusions with source references. Research and code execution switches default to off in the common permission policy. Code mode additionally requires a model explicitly opted into local execution (`codeExecution`) and an available runner; this setting does not claim provider-hosted PTC support. The application supplies QuickJS WebAssembly in a separate Worker; disabled mode creates no Worker and loads no interpreter. Native skill processes are not code sandboxes.

## 持久工具计划与可选执行

外部写操作通过 `AgentTaskService` 排队，排队回执不代表执行成功。`AgentTaskRepository` 保存有界计划、逐调用检查点与租约，实际执行仍只有 `ActionExecutor` 一个入口。审批等待释放任务租约，不占前台会话租约；单次批准绑定任务、调用序号、参数、工具修订、主体和权限指纹，不改变持久授权。中断后结果未知的写调用保持 `unknown`，不重放；只读调用可在租约到期后恢复，已完成检查点跳过。

任务结果归原会话，按需读取而不直接发言；来源复验沿用领域记忆范围和知识授权，撤权或过期清空已存参数与结果。最长保留一天，并随最早来源到期缩短。暂停阻止执行，但不删除仍有权读取的检查点。

可选研究沿用同一 Runtime，只能使用父级已广告工具中的只读子集，最多一层、两个子调用；没有通道提交回调，共享取消和预算，返回有界结论与来源。研究和代码执行开关统一保存在权限策略中，默认关闭；代码模式还要求为模型开启本地执行许可（`codeExecution`）且 runner 可用，该设置不表示供应商提供托管 PTC；应用提供独立 Worker 内的 QuickJS WebAssembly 实现，关闭时不创建 Worker、不加载解释器。原生技能进程不等同代码沙箱。

## JavaScript sandbox

`quickjs-runner.ts` owns the Worker, JSON bridge, deadline and termination; `quickjs-worker.ts` owns the QuickJS guest. The guest has no host filesystem, network, environment, process or module loader. Only authorized read-only bindings cross the boundary as JSON. A script is an async JavaScript function body using `await tools["name"]({...})` and returns `{conclusion, refs?}`. Authorized host tools retain their own resource access; the absence of guest network APIs does not remove a remote tool's network access.

Default limits are 20 seconds, 32 MiB of guest allocations, a 256 KiB guest stack, 1 MiB of cumulative JSON transfers, 32 tool calls and 4,000 conclusion characters. Each script has a configurable tool concurrency limit (default 3, range 1–8); excess calls queue, sequential awaits remain sequential, and parallel results retain their originating call IDs. Cancellation stops the queue and discards late results. The allocation bound is not a process-wide RSS limit. Cancellation terminates the Worker even while guest code loops or awaits an unresolved promise. Results with outstanding tool calls are rejected; late callbacks cannot reopen closed bindings. Every result retains source checks and permission checks. The protected context stores scripts and conclusions; the `agent.code` span records mode, bindings, call counts, duration and failure code without duplicating raw tool data.

Compiled services explicitly embed the worker entrypoint with a fixed project root and compile-time path selection. The WebAssembly variant embeds its bytes, so no runtime download or interpreter file lookup is required.

## JavaScript 沙箱

`quickjs-runner.ts` 管理 Worker、JSON 桥、截止时间与终止；`quickjs-worker.ts` 管理 QuickJS guest。guest 没有主机文件系统、网络、环境、进程或模块加载接口，只有获准的只读工具通过 JSON 交互。脚本是异步 JavaScript 函数体，使用 `await tools["name"]({...})`，返回 `{conclusion, refs?}`。宿主工具保留自身授权范围内的资源访问，guest 没有网络接口不代表远程工具不联网。

默认限制为20秒、32 MiB guest分配、256 KiB guest栈、1 MiB累计JSON传输、32次工具调用和4000字符结论。每段脚本的工具并发上限可配（默认3、范围1–8），超出排队，逐次await保持串行，并发结果按原调用ID匹配；取消停止排队并丢弃迟到结果。分配限制不是整个应用的RSS上限。取消会终止Worker，可打断忙循环和未决Promise；有未完成工具调用时拒绝结论，迟到回调不能重新开放绑定。权限与来源仍逐次复验。脚本和结论保存在受保护上下文中，`agent.code`跨度仅保存模式、绑定表、次数、耗时和失败码，不复制原始工具数据。

编译服务显式嵌入Worker入口并固定项目根与编译期路径；WASM字节包含在变体内，不在运行时下载或寻找外部解释器文件。

## Context and retention

Evidence and action observations carry source identity, revision and expiry. Context snapshots retain the actual rendered text, with layout and hashes for inspection. Images retain references and metadata, not image bytes. Inspection checks owner access and source validity.

Deleting or revoking a source invalidates derived exact snapshots. Expiry follows the earliest source expiry; the runtime periodically clears expired text. Metadata may remain for diagnosis. This is application-level retention, not a claim of immediate physical disk erasure.

Model capacity, an auxiliary call timeout and a business job deadline are different budgets. An optional Agent deadline does not replace the existing task deadlines. Streaming cancellation must propagate to the underlying request. Nested text and vision leaves automatically inherit the active task tree's call and input budget; unrelated concurrent runs have separate ledgers. Deferred compression explicitly retains its originating ledger. Waiting for a model slot is cancellable, and releasing a slot transfers ownership directly to the next waiter.

Supplemental memory and knowledge queries disclose catalog entries with module-supplied previews and run-local body references. Paged reads reuse the selected body without another selector call, but revalidate authority and source revision on every access. Hosts fit the actual catalog or page envelope, including provenance, against available capacity; a reference is never a grant of access.

Memory recall is two explicit stages: retrieval reads the authorized catalog with keyword scoring, boundaries and no model call; reranking spends a selector model call and may only prune the retrieved candidates. Retired or corrected rows leave the catalog entirely, so a stale selection cannot bring old text back — an out-of-candidate selection is refused and that read yields no memory, with a diagnostic.

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
