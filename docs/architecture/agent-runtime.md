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

The catalog binds each unique name to both its public description and executable action. Constructor, run-scoped and orchestration-extension collisions are rejected; the Agent specification selects names and capabilities but cannot substitute input schemas or effect declarations. Unbound tools are not advertised. Source resolution checks task ownership and tool permissions before connector-specific resolvers, including when no grants are configured.

工具目录将唯一名称同时绑定到公开描述与执行动作；构造、本轮注册及编排扩展的重名一律拒绝。Agent 配置只选择名称和能力，不能替换参数 schema 或副作用声明；没有执行实现的工具不向模型广告。来源解析先检查任务所有权与工具权限，再调用连接器解析器；没有授权配置时同样默认拒绝权限来源。

MCP registration contains connection settings and an explicit, default-off trust setting for server read-only annotations. Tool grants and script approvals share a local `permissions.json` policy, a `PermissionService` and an `ActionExecutor`; adapters describe requirements instead of implementing separate allowlists. Policies may narrow access by Agent and declared directory, and approvals for side-effecting tools bind to a resource revision. The same executor checks direct calls and sandbox bindings before execution and after success or failure. Captured actions cannot survive revocation, and runs revalidate consumed actions before further inference and publication.

Permission fingerprints are source references resolved by the existing inspection and delivery boundaries. Knowledge and memory retain their domain-specific ownership and scope checks rather than becoming global tool grants. The local same-origin management API is separate from model-visible actions; instructions cannot approve themselves. Policy writes use revision checks and atomic replacement.

MCP supports multiple enabled servers. Changed or invalid configuration disables captured actions; connection shutdown drains in-flight setup. Credentials should be referenced through environment variables; children receive only necessary and explicitly configured environment values. Local configuration remains protected data and may be included in local backups, so it is not a secret-exclusion guarantee.

The MCP adapter uses the official TypeScript client with 2026-07-28-first negotiation and legacy transport compatibility. JSON Schema 2020-12 and draft-07 validation never fetches network references. Structured results retain their JSON values and share the text result limit. Catalog notifications invalidate captured tools before rediscovery; stream cancellation and request deadlines remain owned by the adapter. Read-only annotations affect execution only for explicitly trusted servers; grants are still required. Optional sampling, elicitation, roots and interactive OAuth are not advertised by this application.

MCP 适配使用官方 TypeScript 客户端，优先协商 2026-07-28 并兼容旧传输。JSON Schema 2020-12 与 draft-07 校验不读取网络引用；结构化结果保留原 JSON 值，并和文本共同受结果上限约束。目录变化先使已捕获工具失效再重新发现，取消与请求期限由适配层管理。只有显式信任的服务，其只读提示才影响执行方式，统一授权仍必需；应用不声明可选的模型采样、信息征询和根目录能力，也不提供交互式 OAuth 登录。

Skills use the Agent Skills document format: each directory contains `SKILL.md` with YAML frontmatter. The name matches its directory, names and descriptions follow the format limits, and license, compatibility, string metadata and the experimental `allowed-tools` declaration are preserved. The application exposes a metadata catalog, loads the complete document on demand as task guidance (always subordinate to the system prompt and permissions), and reads text resources inside the skill directory as paged plain text; resources travel as material, not instructions. It does not consume `skill.json` or execute bundled scripts, and `allowed-tools` is descriptive only — it cannot approve a tool. Document and resource revisions travel as source references and are re-verified at every checkpoint. Duplicate YAML keys, unsafe paths, binary resources and oversized files are rejected by the host; file-size limits are application safeguards, not the specification's recommended token or line counts.

Skills 使用 Agent Skills 文档格式：每个目录包含带 YAML frontmatter 的 `SKILL.md`，名称须匹配目录并遵守格式长度与字符规则，保留许可证、兼容性、字符串元数据及实验性 `allowed-tools` 声明。应用提供元数据目录；按需把完整文档作为任务指导读入（始终服从系统提示与权限），并按分页纯文本读取技能目录内的文本资源；资源是材料、不是指令。不读取 `skill.json`、不执行附带脚本，`allowed-tools` 只作声明、不能批准工具。文档与资源的修订随来源引用出行，并在每个检查点复验。宿主拒绝重复 YAML 键、越界路径、二进制资源及超大文件；文件大小限制是应用保护，不是规范建议的 token 或行数上限。

Revocation and expiry are re-verified at execution checkpoints and at the commit boundary; text already streamed to a client cannot be recalled, so a mid-stream revocation stops the run at the next checkpoint instead of retracting output.

撤权与过期在执行检查点和提交边界复验；已经流出的文本无法收回——中途撤权会让运行在下一个检查点停止，而不是撤回已发出的内容。

## Durable tool plans and optional execution

External writes are queued through `AgentTaskService`; a queued response is not a successful tool result. `AgentTaskRepository` stores bounded plans, per-call checkpoints and leases, while `ActionExecutor` remains the only execution boundary. Approval waits release the task lease and do not retain a foreground conversation lease. Single-use approvals bind to the task, call ordinal, arguments, tool revision, actor and permission fingerprint; they do not alter persistent grants. Interrupted tasks settle into a terminal status with their outcome evidence kept; an interrupted external write with an uncertain outcome remains `unknown` and is not replayed. Interrupted reads can be reclaimed after lease expiry, and completed checkpoints are skipped.

Task results belong to the originating conversation and are read on demand. They cannot publish messages. Source checks reuse domain memory scopes and knowledge grants; revocation or expiry clears stored arguments and results. Task retention is at most one day and shortens with source expiry; expiry clears stored payloads without deleting the task identity. Pause prevents execution without deleting otherwise authorized checkpoints.

Optional research uses the same Runtime with a read-only subset of the parent's advertised tools, one nesting level and at most two child calls. Children have no channel commit callback, inherit cancellation and the shared budget, and return bounded conclusions with source references. Research and code execution switches default to off in the common permission policy. Code mode additionally requires a model explicitly opted into local execution (`codeExecution`) and an available runner; this setting does not claim provider-hosted PTC support. The application supplies QuickJS WebAssembly in a separate Worker; disabled mode creates no Worker and loads no interpreter. Native skill processes are not code sandboxes.

## 持久工具计划与可选执行

外部写操作通过 `AgentTaskService` 排队，排队回执不代表执行成功。`AgentTaskRepository` 保存有界计划、逐调用检查点与租约，实际执行仍只有 `ActionExecutor` 一个入口。审批等待释放任务租约，不占前台会话租约；单次批准绑定任务、调用序号、参数、工具修订、主体和权限指纹，不改变持久授权。中断后结果未知的写调用保持 `unknown`，不重放；只读调用可在租约到期后恢复，已完成检查点跳过。

任务结果归原会话，按需读取而不直接发言；来源复验沿用领域记忆范围和知识授权，撤权或过期清空已存参数与结果。最长保留一天，并随最早来源到期缩短。暂停阻止执行，但不删除仍有权读取的检查点。

可选研究沿用同一 Runtime，只能使用父级已广告工具中的只读子集，最多一层、两个子调用；没有通道提交回调，共享取消和预算，返回有界结论与来源。研究和代码执行开关统一保存在权限策略中，默认关闭；代码模式还要求为模型开启本地执行许可（`codeExecution`）且 runner 可用，该设置不表示供应商提供托管 PTC；应用提供独立 Worker 内的 QuickJS WebAssembly 实现，关闭时不创建 Worker、不加载解释器。文档技能不会因此获得原生脚本执行能力。

## JavaScript sandbox

`quickjs-runner.ts` owns the Worker, JSON bridge, deadline and termination; `quickjs-worker.ts` owns the QuickJS guest. The guest has no host filesystem, network, environment, process or module loader. Only authorized read-only bindings cross the boundary as JSON. A script is an async JavaScript function body using `await tools["name"]({...})` and returns `{conclusion, refs?}`. Authorized host tools retain their own resource access; the absence of guest network APIs does not remove a remote tool's network access.

Default limits are 20 seconds, 32 MiB of guest allocations, a 256 KiB guest stack, 1 MiB of cumulative JSON transfers, 32 tool calls and 4,000 conclusion characters. Each script has a configurable tool concurrency limit (default 3, range 1–8); excess calls queue, sequential awaits remain sequential, and parallel results retain their originating call IDs. Cancellation stops the queue and discards late results. The allocation bound is not a process-wide RSS limit. Cancellation terminates the Worker even while guest code loops or awaits an unresolved promise. Results with outstanding tool calls are rejected; late callbacks cannot reopen closed bindings. Every result retains source checks and permission checks. The protected context stores scripts and conclusions; the `agent.code` span records mode, bindings, call counts, duration and failure code without duplicating raw tool data.

Ordinary tool exceptions reach the guest as rejected promises carrying a bounded code and generic message, after the shared executor revalidates authority. Scripts may catch them and retry within the original call, time and transfer budgets; there is no automatic retry. Permission, source, cancellation, budget and protocol failures stop execution and cancel sibling work. Caught failure observations retain grant provenance, and traces count failed calls without copying host exception details.

Compiled services explicitly embed the worker entrypoint with a fixed project root and compile-time path selection. The WebAssembly variant embeds its bytes, so no runtime download or interpreter file lookup is required.

## JavaScript 沙箱

`quickjs-runner.ts` 管理 Worker、JSON 桥、截止时间与终止；`quickjs-worker.ts` 管理 QuickJS guest。guest 没有主机文件系统、网络、环境、进程或模块加载接口，只有获准的只读工具通过 JSON 交互。脚本是异步 JavaScript 函数体，使用 `await tools["name"]({...})`，返回 `{conclusion, refs?}`。宿主工具保留自身授权范围内的资源访问，guest 没有网络接口不代表远程工具不联网。

默认限制为20秒、32 MiB guest分配、256 KiB guest栈、1 MiB累计JSON传输、32次工具调用和4000字符结论。每段脚本的工具并发上限可配（默认3、范围1–8），超出排队，逐次await保持串行，并发结果按原调用ID匹配；取消停止排队并丢弃迟到结果。分配限制不是整个应用的RSS上限。取消会终止Worker，可打断忙循环和未决Promise；有未完成工具调用时拒绝结论，迟到回调不能重新开放绑定。权限与来源仍逐次复验。脚本和结论保存在受保护上下文中，`agent.code`跨度仅保存模式、绑定表、次数、耗时和失败码，不复制原始工具数据。

普通工具异常经统一执行器复验授权后，以带有限长度错误码和通用消息的Promise拒绝返回guest。脚本可捕获并在原调用次数、时间与传输预算内重试，系统不自动重试；权限、来源、取消、预算及协议错误终止执行并取消并发工作。捕获失败得到的观测仍携带授权来源，追踪记录失败次数，不复制宿主异常详情。

编译服务显式嵌入Worker入口并固定项目根与编译期路径；WASM字节包含在变体内，不在运行时下载或寻找外部解释器文件。

## Context and retention

Evidence and action observations carry source identity, revision and expiry. Context snapshots retain the actual rendered text, with layout and hashes for inspection. Images retain references and metadata, not image bytes. Inspection checks owner access and source validity.

Deleting or revoking a source invalidates derived exact snapshots. Expiry follows the earliest source expiry. Runtime trace retention defaults to 14 days with a 1–3650 range and is configured via the runtime data retention setting under execution settings: a new trace reads and freezes its expiry at start, later changes do not affect traces already written, and the effective expiry remains the minimum of that written expiry and the earliest source TTL. The existing 60-second sweep keeps clearing expired context text, delivery housekeeping and telemetry automatically; manual cleanup only clears expired copies left behind, under the same rules. Cleanup clears copied fields only: context snapshots lose their protected bodies while keeping run/step/source references and layout, and terminal tasks lose stored payloads while keeping their identity. Traces still in progress and traces with an unknown outcome are kept. Metadata may remain for diagnosis; this is application-level retention, not a claim of immediate physical disk erasure.

删除或撤权来源会使派生的精确快照失效；到期不晚于最早来源期限。运行追踪保留天数默认 14、范围 1–3650，通过执行设置中的运行数据保留配置：新 trace 在开始时读取并冻结到期，之后修改不影响已写入的 trace；实际到期取「已写入到期」与「最早来源 TTL」的最小值。既有 60 秒扫描继续自动清除到期上下文正文、投递清理与追踪记录；手动清理只清仍留在原地的到期副本，口径与自动路径一致。清理只清副本字段：上下文快照清除受保护正文、保留 run/step/来源引用与布局；终态任务清除载荷、保留任务身份。进行中的 trace 与结果未知的 trace 继续保留。元数据可为诊断保留；这是应用层保留，不等于立即物理擦除磁盘数据。

Model capacity, an auxiliary call timeout and a business job deadline are different budgets. An optional Agent deadline does not replace the existing task deadlines. Streaming cancellation must propagate to the underlying request. Nested text and vision leaves automatically inherit the active task tree's call and input budget; unrelated concurrent runs have separate ledgers. Deferred compression explicitly retains its originating ledger. Waiting for a model slot is cancellable, and releasing a slot transfers ownership directly to the next waiter.

Memory and knowledge are read on demand through query/read tools, not automatically inserted before the first decision. Queries scan bounded authorized batches and return previews, opaque run-local body references and continuation cursors. The main Agent chooses which bodies to read; there is no hidden selection-model call. Unicode text pages and catalog envelopes, including provenance and continuation metadata, share the configured domain allowance and the actual remaining context budget. References never grant access, and authority and source revisions are revalidated at each checkpoint.

记忆与知识通过 query/read 工具按需读取，不在首次决策前自动注入。查询扫描有界的授权批次，返回预览、当前运行内的不透明正文引用和续查游标；主 Agent 决定读取哪些正文，不再隐藏调用独立选择模型。Unicode 正文分页和目录信封连同来源与续读信息，共用该资料域的配置额度并受真实上下文余量约束；引用不是授权，每个检查点重新验证权限与来源修订。

Memory tools preserve the off setting and Agent/conversation scopes. Conservative, standard and broad presets bound scanned candidates, page entries and cumulative result units. Stored legacy full modes use the broad preset rather than an unbounded preload. Existing data remains parseable; visiting settings does not rewrite it. Retired corrections and invalid sources cannot be selected back into context, while retained history keeps its correction constraints.

记忆工具保留关闭设置与助手/会话隔离；保守、标准和广泛预设分别约束候选扫描、每页条数与累计结果额度。已存旧全量模式按广泛额度执行，不再全量预载；已有数据保持可解析，打开设置不会自动改写配置。已退役纠正与无效来源不能重新被选入上下文，保留的历史仍受人工纠正约束。

Historical conversation messages and already-stored summaries use the same query/read envelope, scoped to the current conversation. They do not create summaries or advance compression watermarks. QQ judgement projections do not install summary tools. Web history freezes whether correction reading is enabled, so memory off cannot be bypassed through historical evidence. Source revisions include the scope and stored content; execution, task use and inspection recheck the durable source before external resolvers can claim it. Completed runs release temporary references and cursors, and Web generation-token-bound cleanup releases retained context checkpoints without deleting stored history.

历史会话消息和已存摘要复用同一 query/read 信封，仅能读取当前会话，不创建摘要或推进压缩水位；QQ 判断档不安装摘要工具。Web 历史固定本轮是否允许读取纠正，不能绕过记忆关闭设置。来源修订包含范围与存储内容，执行、任务和检查先从持久来源复验，再考虑外部解析器。运行结束释放临时引用与游标；Web 按生成令牌清理上下文检查点，不删除已存历史。

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
