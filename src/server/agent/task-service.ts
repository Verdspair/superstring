import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  ReadTaskSchema,
  TASK_READ_DESCRIPTION,
  taskStartDescription,
} from "../../shared/contracts/agent-action-descriptions";
import type { RunOwner } from "../../shared/contracts/agent-run";
import {
  type AgentTask,
  type TaskBodyPage,
  type TaskCall,
  type TaskDetail,
  type TaskFilters,
  type TaskList,
  TaskPlanSchema,
} from "../../shared/contracts/agent-task";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  type ExecutionPolicy,
  ExecutionPolicySchema,
  toolExecutionEnabled,
} from "../../shared/contracts/permissions";
import type { AgentTaskRepository } from "../db/agent-task-repository";
import { memoryBodiesByScopeKeys } from "../db/context-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { stableStringify } from "../db/json-text";
import { readQqBinding } from "../db/qq-binding-repository";
import { readQqOwnerIdentity } from "../db/qq-owner-repository";
import { DEFAULT_USER_ID, type Orm } from "../db/repositories";
import type { ModuleSourceResolver } from "../modules/composition";
import { resolveAgentTraceScope, startAgentTrace } from "../observability/agent-tracing";
import type { RuntimeTelemetry } from "../observability/runtime-telemetry";
import { PermissionError } from "../permissions/service";
import { qqMemoryScopeKeyset } from "../services/memory-scope";
import { resolveQqMemoryAccess } from "../services/qq-binding-contract";
import type { ActionExecutor } from "./action-executor";
import type { BuiltInAction } from "./built-in-actions";
import { sourceAccess } from "./context-access";
import { uniqueSources } from "./context-engine";
import { visibleConversation } from "./conversation-access";

const terminal = new Set<AgentTask["status"]>(["completed", "failed", "cancelled", "unknown"]);
const taskError = (code: string) => Object.assign(new Error(code), { code });
const taskFailureCode = (error: unknown): string =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "TASK_FAILED";
/** 任务的有效限额（P7-c 起由统一执行配置给出；这里是缺省值）。 */
export interface TaskLimits {
  /** 本进程同时执行的工具任务数（同会话恒为 1，由数据库租约保证）。 */
  concurrency: number;
  /** 从入队起算的最长有效期（含排队与审批等待）。 */
  retentionMs: number;
  leaseMs: number;
  /** worker 轮询间隔；每次巡检后按最新值重新安排。 */
  pollMs: number;
}
export const DEFAULT_TASK_LIMITS: TaskLimits = {
  concurrency: 2,
  retentionMs: 86_400_000,
  leaseMs: 30_000,
  pollMs: 500,
};

export class AgentTaskService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Set<Promise<boolean>>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    private readonly options: {
      repository: AgentTaskRepository;
      orm: Orm;
      executor: ActionExecutor;
      actions(): readonly BuiltInAction[];
      execution?: () => ExecutionPolicy;
      resolveSource?: ModuleSourceResolver;
      now?: () => string;
      /** 有效限额：每次领取/巡检重新读取，改配置对新任务与新轮次生效。 */
      limits?: () => TaskLimits;
      /** 任务 worker 的追踪（B06）：领取/调用/等待/终态都留痕，父 span 可用时接上原运行。 */
      telemetry?: RuntimeTelemetry;
    },
  ) {}
  private limits(): TaskLimits {
    return this.options.limits?.() ?? DEFAULT_TASK_LIMITS;
  }
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private owner(task: Pick<AgentTask, "conversationId" | "agentId">): RunOwner {
    return {
      kind: "conversation",
      id: task.conversationId,
      agentId: task.agentId,
      userId: DEFAULT_USER_ID,
    };
  }
  private assertCurrent(
    task: Pick<AgentTask, "conversationId" | "agentId" | "sources" | "expiresAt">,
    execution = true,
  ): void {
    const db = this.options.repository.db;
    const row = db
      .query(`SELECT c.closed_at,c.channel,c.source_id,a.is_active FROM conversations c
      JOIN agents a ON a.id=c.agent_id WHERE c.id=? AND c.agent_id=?`)
      .get(task.conversationId, task.agentId) as {
      closed_at: string | null;
      channel: string;
      source_id: string;
      is_active: number;
    } | null;
    if (!row || row.closed_at || (execution && row.is_active !== 1))
      throw taskError("TASK_AUTHORITY_CHANGED");
    if (row.channel === "onebot11") {
      const binding = db
        .query(`SELECT b.paused,s.enabled FROM qq_bindings b CROSS JOIN qq_settings s
        WHERE b.id=? AND b.agent_id=? AND b.account_id=s.account_id`)
        .get(row.source_id, task.agentId) as { paused: number; enabled: number } | null;
      if (!binding || (execution && (binding.paused || !binding.enabled)))
        throw taskError("TASK_AUTHORITY_CHANGED");
    }
    // 系统能力「任务」本群停用：领取、调用、结果提交与巡检都经此，停用即时生效（ADR0019 §13.3 D/H）。
    // execution=false＝元数据管理读取（inspect/approve/readBody），不当模型动作对齐。
    // 入队冻结的能力纪元引用只在执行面强制复验：queued+inflight 期间关闭恢复即硬失败（H）；
    // 元数据读取不因此改写既有任务的台账状态（复验撤权走 sourceAccess，见下）。
    if (execution) {
      this.options.executor.guard?.assert(this.owner(task), "tasks");
      this.options.executor.guard?.assertSources(this.owner(task), task.sources);
    }
    // guard 只认领 `qq_group_capability` kind；这类来源的复验归 guard（上面执行面已断言），
    // 不进下面的通用来源链，避免注入解析器或兜底把能力纪元误判为不可用。
    const guardOwned = (source: SourceRef) =>
      this.options.executor.guard !== undefined && source.kind === "qq_group_capability";
    if (task.expiresAt <= this.now()) throw taskError("TASK_EXPIRED");
    const memories = task.sources.filter(
      (source) =>
        source.kind === "memory" &&
        this.options.resolveSource?.(source, this.owner(task), this.now()) === undefined,
    );
    if (memories.length) {
      let scopes: readonly string[] | null = null;
      if (row.channel === "onebot11") {
        const binding = readQqBinding(this.options.orm, row.source_id);
        if (!binding) throw taskError("TASK_AUTHORITY_CHANGED");
        const access = resolveQqMemoryAccess(binding, readQqOwnerIdentity(this.options.orm));
        if (access.kind !== "resolved") throw taskError("TASK_SOURCE_INVALID");
        scopes = qqMemoryScopeKeyset(access.access).read;
      }
      const current = memoryBodiesByScopeKeys(
        this.options.orm,
        task.agentId,
        memories.map((ref) => ref.id),
        scopes,
      );
      if (
        memories.some(
          (ref) => !current.some((item) => item.id === ref.id && item.revision === ref.revision),
        )
      )
        throw taskError("TASK_SOURCE_INVALID");
    }
    for (const source of task.sources.filter((source) => !guardOwned(source))) {
      const access =
        this.sourceAccess(source, this.owner(task)) ??
        this.options.executor.permissions.sourceAccess(source, this.owner(task)) ??
        this.options.resolveSource?.(source, this.owner(task), this.now()) ??
        sourceAccess(db, source, this.owner(task), { userId: DEFAULT_USER_ID }, this.now());
      if (access !== "available") throw taskError("TASK_SOURCE_INVALID");
    }
  }
  private resultRevision(task: AgentTask): string {
    return createHash("sha256")
      .update(stableStringify([task.status, task.calls, task.sources]))
      .digest("hex");
  }
  sourceAccess(
    source: SourceRef,
    owner: RunOwner,
  ): "available" | "revoked" | "expired" | undefined {
    if (source.kind !== "agent_task") return undefined;
    const task = this.options.repository.get(source.id);
    if (!task || task.agentId !== owner.agentId || this.resultRevision(task) !== source.revision)
      return "revoked";
    if (task.expiresAt <= this.now()) return "expired";
    if (owner.kind === "conversation" && owner.id !== task.conversationId) return "revoked";
    if (owner.kind === "web_turn") {
      const sourceId = new ConversationEventRepository(this.options.repository.db).row(
        task.conversationId,
      )?.source_id;
      if (
        !this.options.repository.db
          .query("SELECT 1 FROM turns WHERE id=? AND session_id=?")
          .get(owner.id, sourceId ?? "")
      )
        return "revoked";
    }
    // 复验任务来源也要过「任务」能力：所在群停用后，已发出的任务来源即刻失效（不依赖执行期断言）。
    if (!(this.options.executor.guard?.allowed(this.owner(task), "tasks") ?? true))
      return "revoked";
    try {
      this.options.executor.guard?.assertSources(this.owner(task), task.sources);
      this.assertCurrent(task, false);
      if (task.calls.some((call) => call.arguments === null)) return "revoked";
      return "available";
    } catch {
      return "revoked";
    }
  }
  private resolve(call: {
    name: string;
    revision?: string;
  }): BuiltInAction & { permission: NonNullable<BuiltInAction["permission"]> } {
    const action = this.options.actions().find((entry) => entry.description.name === call.name);
    if (!action?.permission) throw taskError("TASK_ACTION_UNAVAILABLE");
    if (call.revision !== undefined && call.revision !== action.permission.revision)
      throw taskError("PERMISSION_REVISION_CHANGED");
    action.assertAvailable?.();
    return { ...action, permission: action.permission };
  }
  enqueue(
    conversationId: string,
    plan: z.infer<typeof TaskPlanSchema>,
    context: {
      owner: RunOwner;
      runId?: string;
      requestId?: string;
      sources?: readonly SourceRef[];
    },
  ): AgentTask {
    plan = TaskPlanSchema.parse(plan);
    if (JSON.stringify(plan).length > 64_000) throw taskError("TASK_PLAN_TOO_LARGE");
    const repository = this.options.repository;
    const conversation = new ConversationEventRepository(repository.db).row(conversationId);
    if (
      !conversation ||
      conversation.closed_at ||
      conversation.agent_id !== context.owner.agentId ||
      (context.owner.userId !== undefined && conversation.user_id !== context.owner.userId) ||
      (context.owner.kind === "conversation" && context.owner.id !== conversationId)
    )
      throw taskError("TASK_AUTHORITY_CHANGED");
    if (
      context.owner.kind === "web_turn" &&
      !repository.db
        .query("SELECT 1 FROM turns WHERE id=? AND session_id=?")
        .get(context.owner.id, conversation.source_id)
    )
      throw taskError("TASK_AUTHORITY_CHANGED");
    const owner = {
      kind: "conversation",
      id: conversationId,
      userId: DEFAULT_USER_ID,
      agentId: conversation.agent_id,
    };
    const calls = plan.calls.map((call) => {
      const action = this.resolve(call);
      const requirement = action.permission;
      const decision = this.options.executor.permissions.decide(
        requirement,
        owner,
        "direct",
        action.description.effect ?? "write",
        false,
      );
      if (!decision.allowed) {
        if (decision.code !== "PERMISSION_APPROVAL_REQUIRED")
          throw new PermissionError(decision.code);
        this.options.executor.permissions.assert(
          requirement,
          owner,
          "direct",
          action.description.effect ?? "write",
          false,
          this.options.executor.permissions.approvalKey(requirement, owner),
        );
      }
      return {
        ...call,
        revision: requirement.revision,
        effect: action.description.effect ?? ("write" as const),
      };
    });
    const enqueueOwner = this.owner({ conversationId, agentId: conversation.agent_id });
    // 入队时刻冻结「任务」能力纪元：queued+inflight 期间的关闭恢复不得重用（off→on 不复活）。
    const capSources = this.options.executor.guard?.sources(enqueueOwner, "tasks") ?? [];
    const sources = uniqueSources([
      ...capSources,
      ...(context.sources ?? []),
      ...calls.map((call) =>
        this.options.executor.permissions.source(this.resolve(call).permission),
      ),
    ]);
    const at = this.now();
    const expiresAt = [
      new Date(Date.parse(at) + this.limits().retentionMs).toISOString(),
      ...sources.flatMap((s) => (s.expiresAt ? [s.expiresAt] : [])),
    ].sort()[0];
    const key = createHash("sha256")
      .update(
        stableStringify([
          conversationId,
          context.requestId ?? context.runId ?? context.owner.id,
          calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
        ]),
      )
      .digest("hex");
    this.assertCurrent({ conversationId, agentId: conversation.agent_id, sources, expiresAt });
    const task = repository.enqueue({
      conversationId,
      agentId: conversation.agent_id,
      originRunId: context.runId,
      dedupeKey: key,
      sources,
      at,
      expiresAt,
      calls,
    });
    this.assertCurrent(task);
    return task;
  }
  inspect(id: string, conversationId?: string): AgentTask | null {
    const task = this.options.repository.get(id);
    if (!task || (conversationId && task.conversationId !== conversationId)) return null;
    const db = this.options.repository.db;
    if (
      !visibleConversation(
        db,
        new ConversationEventRepository(db),
        task.conversationId,
        { userId: DEFAULT_USER_ID },
        true,
      )
    )
      return null;
    try {
      this.assertCurrent(task, false);
      for (const call of task.calls) {
        const action = this.options.actions().find((entry) => entry.description.name === call.name);
        if (action && action.permission?.revision !== call.revision)
          throw taskError("PERMISSION_REVISION_CHANGED");
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        ![
          "TASK_AUTHORITY_CHANGED",
          "TASK_EXPIRED",
          "TASK_SOURCE_INVALID",
          "CONTEXT_SOURCE_INVALID",
          "PERMISSION_REVISION_CHANGED",
        ].includes(String(error.code))
      )
        throw error;
      this.options.repository.redact(id, this.now(), taskFailureCode(error));
      this.controllers.get(id)?.abort(error);
      return this.options.repository.get(id);
    }
    return task;
  }
  list(filters: TaskFilters): TaskList {
    return this.options.repository.page(filters, DEFAULT_USER_ID);
  }
  private managed(id: string): AgentTask | null {
    const task = this.inspect(id);
    if (!task) return null;
    const conversation = new ConversationEventRepository(this.options.repository.db).row(
      task.conversationId,
    );
    return conversation && !conversation.closed_at && conversation.agent_id === task.agentId
      ? task
      : null;
  }
  private dataStatus(task: AgentTask): TaskDetail["dataStatus"] {
    if (task.expiresAt <= this.now()) return "expired";
    return task.calls.some((call) => call.arguments === null) ? "revoked" : "available";
  }
  private bodyPage(
    task: AgentTask,
    call: TaskCall,
    field: "arguments" | "result",
    query: { offset: number; limit: number },
  ): TaskBodyPage {
    const access = this.dataStatus(task);
    const status =
      access !== "available"
        ? access
        : field === "arguments" || call.status === "completed"
          ? "available"
          : ["pending", "approved", "running", "waiting_approval"].includes(call.status)
            ? "pending"
            : "unavailable";
    if (status !== "available")
      return { status, text: null, offset: query.offset, total: null, nextOffset: null };
    const text = [...JSON.stringify(call[field])];
    const end = Math.min(text.length, query.offset + query.limit);
    return {
      status,
      text: text.slice(query.offset, end).join(""),
      offset: query.offset,
      total: text.length,
      nextOffset: end < text.length ? end : null,
    };
  }
  detail(id: string): TaskDetail | null {
    const task = this.managed(id);
    if (!task) return null;
    const dataStatus = this.dataStatus(task);
    return {
      id: task.id,
      conversationId: task.conversationId,
      agentId: task.agentId,
      originRunId: task.originRunId,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      expiresAt: task.expiresAt,
      errorCode: task.errorCode,
      callCount: task.calls.length,
      completedCallCount: task.calls.filter((call) => call.status === "completed").length,
      waitingOrdinal:
        task.calls.find((call) => ["running", "waiting_approval"].includes(call.status))?.ordinal ??
        null,
      waitingReason:
        task.status === "waiting_tool"
          ? "tool"
          : task.status === "waiting_approval"
            ? "approval"
            : null,
      dataStatus,
      calls: task.calls.map((call) => ({
        ordinal: call.ordinal,
        name: call.name,
        revision: call.revision,
        effect: call.effect,
        status: call.status,
        approvalRevision:
          dataStatus === "available" && call.status === "waiting_approval"
            ? call.approvalRevision
            : null,
        errorCode: call.errorCode,
        argumentsPreview: this.bodyPage(task, call, "arguments", { offset: 0, limit: 512 }),
        resultStatus:
          dataStatus !== "available"
            ? dataStatus
            : call.status === "completed"
              ? "available"
              : ["pending", "approved", "running", "waiting_approval"].includes(call.status)
                ? "pending"
                : "unavailable",
      })),
    };
  }
  readBody(
    id: string,
    ordinal: number,
    field: "arguments" | "result",
    query: { offset: number; limit: number },
  ): TaskBodyPage | null {
    const task = this.managed(id);
    if (!task) return null;
    const call = task.calls[ordinal];
    if (!call) throw taskError("TASK_CALL_NOT_FOUND");
    return this.bodyPage(task, call, field, query);
  }
  private approval(task: AgentTask, ordinal: number): string {
    const call = task.calls[ordinal];
    const action = this.resolve(call);
    return createHash("sha256")
      .update(
        stableStringify([
          task.id,
          ordinal,
          call.arguments,
          this.options.executor.permissions.approvalKey(action.permission, this.owner(task)),
        ]),
      )
      .digest("hex");
  }
  approve(id: string, ordinal: number, expected: string, approved = true): boolean {
    const task = this.inspect(id);
    const call = task?.calls[ordinal];
    if (!task || call?.status !== "waiting_approval" || task.status !== "waiting_approval")
      return false;
    this.assertCurrent(task, false);
    if (this.approval(task, ordinal) !== expected) throw taskError("PERMISSION_REVISION_CHANGED");
    return approved
      ? this.options.repository.approve(id, ordinal, expected, this.now())
      : this.cancel(id);
  }
  cancel(id: string): boolean {
    const task = this.inspect(id);
    if (!task || terminal.has(task.status)) return false;
    this.options.repository.interrupt(id, this.now(), "cancelled", "TASK_CANCELLED");
    this.controllers.get(id)?.abort(taskError("TASK_CANCELLED"));
    return true;
  }
  conversationActions(conversationId: string): BuiltInAction[] {
    const execution = this.options.execution?.() ?? ExecutionPolicySchema.parse({});
    return [
      ...this.options
        .actions()
        .filter(
          (action) =>
            toolExecutionEnabled(execution, action.description.name) &&
            (execution.modules.tasks || action.description.effect === "read" || !action.permission),
        )
        .map((action): BuiltInAction => {
          if (action.description.effect === "read" || !action.permission) return action;
          return {
            ...action,
            permission: { ...action.permission, approvalRequired: false },
            description: {
              ...action.description,
              description: `${action.description.description} Execution is queued as a durable task; use task.read for status. A queued task is not a successful tool result.`,
            },
            execute: async (args, context) => {
              const task = this.enqueue(
                conversationId,
                { calls: [{ name: action.description.name, arguments: args }] },
                context,
              );
              return { value: { taskId: task.id, status: task.status }, sources: [] };
            },
          };
        }),
      ...this.actions(conversationId, execution),
    ];
  }
  actions(
    conversationId: string,
    execution = this.options.execution?.() ?? ExecutionPolicySchema.parse({}),
  ): BuiltInAction[] {
    const conversation = new ConversationEventRepository(this.options.repository.db).row(
      conversationId,
    );
    if (!conversation) return [];
    const owner = this.owner({ conversationId, agentId: conversation.agent_id });
    const available = this.options.actions().filter((action) => {
      if (!action.permission || !toolExecutionEnabled(execution, action.description.name))
        return false;
      const decision = this.options.executor.permissions.decide(
        action.permission,
        owner,
        "direct",
        action.description.effect ?? "write",
        false,
      );
      return decision.allowed || decision.code === "PERMISSION_APPROVAL_REQUIRED";
    });
    if (!available.length && !this.options.repository.list(conversationId).length) return [];
    const actions: BuiltInAction[] = [
      {
        sandboxCallable: false,
        description: taskStartDescription(available.map((a) => a.description.name)),
        execute: async (args, context) => {
          const plan = TaskPlanSchema.parse(args);
          if (
            plan.calls.some(
              (call) => !available.some((action) => action.description.name === call.name),
            )
          )
            throw taskError("TASK_ACTION_UNAVAILABLE");
          const task = this.enqueue(conversationId, plan, context);
          return { value: { taskId: task.id, status: task.status }, sources: [] };
        },
      },
      {
        sandboxCallable: false,
        description: TASK_READ_DESCRIPTION,
        execute: async (args) => {
          const input = ReadTaskSchema.parse(args);
          const task = this.inspect(input.taskId, conversationId);
          if (!task) throw taskError("TASK_NOT_FOUND");
          if (input.ordinal !== undefined && !task.calls[input.ordinal])
            throw taskError("TASK_CALL_NOT_FOUND");
          this.assertCurrent(task);
          const text =
            input.ordinal === undefined
              ? null
              : [...JSON.stringify(task.calls[input.ordinal].result)];
          const end = text === null ? 0 : Math.min(text.length, input.offset + input.limit);
          return {
            value: {
              taskId: task.id,
              status: task.status,
              calls: task.calls.map(({ ordinal, name, status, errorCode }) => ({
                ordinal,
                name,
                status,
                errorCode,
              })),
              ...(text === null
                ? {}
                : {
                    result: {
                      text: text.slice(input.offset, end).join(""),
                      offset: input.offset,
                      total: text.length,
                      nextOffset: end < text.length ? end : null,
                    },
                  }),
            },
            sources: [
              ...task.sources,
              {
                kind: "agent_task",
                id: task.id,
                revision: this.resultRevision(task),
                expiresAt: task.expiresAt,
              },
            ],
          };
        },
      },
    ];
    return execution.modules.tasks
      ? actions
      : actions.filter((action) => action.description.name !== "task.start");
  }
  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    this.options.repository.expire(this.now());
    const execution = this.options.execution?.() ?? ExecutionPolicySchema.parse({});
    if (!execution.modules.tasks || this.active.size >= this.limits().concurrency)
      return Promise.resolve(false);
    const pausedNames = this.options
      .actions()
      .filter((action) => !toolExecutionEnabled(execution, action.description.name))
      .map((action) => action.description.name);
    const pausedPrefixes = [
      ...(!execution.modules.mcp ? ["mcp."] : []),
      ...(!execution.modules.skills ? ["skill."] : []),
    ];
    const run = this.runClaimed(
      [...new Set([...execution.pausedTools, ...pausedNames])],
      pausedPrefixes,
    );
    this.active.add(run);
    void run.finally(() => this.active.delete(run)).catch(() => {});
    return run;
  }
  private async runClaimed(
    pausedNames: readonly string[],
    pausedPrefixes: readonly string[],
  ): Promise<boolean> {
    const { repository, executor } = this.options;
    // 领取时读取有效租约：在飞的任务沿捕获值续租，不因改配置缩短已有租期。
    const leaseMs = this.limits().leaseMs;
    const claimed = repository.claim(this.now(), leaseMs, pausedNames, pausedPrefixes);
    if (!claimed?.leaseToken) return false;
    let task: AgentTask = claimed;
    const token = claimed.leaseToken;
    const id = task.id;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const check = () => {
      controller.signal.throwIfAborted();
      repository.assertOwned(id, token, this.now());
      this.assertCurrent(task);
    };
    const renewal = setInterval(
      () => {
        try {
          check();
          if (!repository.renew(id, token, this.now(), leaseMs)) throw taskError("TASK_LEASE_LOST");
        } catch (error) {
          controller.abort(error);
        }
      },
      Math.max(1, Math.floor(leaseMs / 3)),
    );
    const originRunId = task.originRunId;
    const trace = startAgentTrace(this.options.telemetry, "task.run", (telemetry) => {
      const parent = originRunId ? telemetry.parentFor("run_id", originRunId) : null;
      return {
        ...resolveAgentTraceScope(telemetry, this.owner(task)),
        ...(originRunId ? { runId: originRunId } : {}),
        ...(parent ? { parent } : {}),
        stage: "action",
        sources: task.sources,
        details: {
          taskId: id,
          attempt: "claim",
          originRunId,
          // 原运行的记录已过期时明确写"接不上"，不假装完整树。
          parentLinked: parent !== null,
        },
      };
    });
    const execute = async () => {
      try {
        check();
        for (const call of task.calls) this.resolve(call);
        for (const call of task.calls) {
          check();
          if (call.status === "completed") continue;
          const action = this.resolve(call);
          const context = { owner: this.owner(task), signal: controller.signal };
          const approval =
            call.status === "approved" &&
            call.approvalRevision === this.approval(task, call.ordinal)
              ? executor.permissions.approvalKey(action.permission, context.owner)
              : undefined;
          const decision = executor.permissions.decide(
            action.permission,
            context.owner,
            "direct",
            call.effect,
            false,
            approval,
          );
          if (!decision.allowed) {
            if (decision.code !== "PERMISSION_APPROVAL_REQUIRED")
              throw new PermissionError(decision.code);
            repository.waitApproval(
              id,
              token,
              call.ordinal,
              this.approval(task, call.ordinal),
              this.now(),
            );
            trace?.update({ details: { waitingOrdinal: call.ordinal, waitingReason: "approval" } });
            trace?.end("deferred", "TASK_WAITING_APPROVAL");
            return;
          }
          executor.assert(action, context, "direct", approval);
          if (call.arguments === null) throw taskError("TASK_SOURCE_INVALID");
          repository.beginCall(id, token, call.ordinal, this.now());
          const callTrace = startAgentTrace(this.options.telemetry, "task.call", (telemetry) => ({
            ...resolveAgentTraceScope(telemetry, this.owner(task)),
            stage: "action",
            sources: task.sources,
            details: {
              taskId: id,
              ordinal: call.ordinal,
              name: call.name,
              effect: call.effect,
              revision: call.revision,
            },
          }));
          let result: Awaited<ReturnType<ActionExecutor["execute"]>>;
          try {
            result = await executor.execute(action, call.arguments, context, {
              assertCurrent: check,
              approvalKey: approval,
            });
            callTrace?.end("completed", "TASK_CALL_COMPLETED");
          } catch (error) {
            callTrace?.end("failed", taskFailureCode(error));
            throw error;
          }
          check();
          if (JSON.stringify(result.value).length > 64_000)
            throw taskError("TASK_RESULT_TOO_LARGE");
          const value = result.value as { status?: string; code?: unknown } | null;
          if (value?.status === "unavailable")
            throw taskError(
              call.effect === "write"
                ? "TASK_OUTCOME_UNKNOWN"
                : typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
                  ? value.code
                  : "TASK_TOOL_FAILED",
            );
          const sources = uniqueSources([...task.sources, ...result.sources]);
          this.assertCurrent({ ...task, sources });
          repository.completeCall(id, token, call.ordinal, result.value, sources, this.now());
          task = { ...task, sources };
        }
        check();
        repository.settle(id, "completed", this.now());
        trace?.end("completed", "TASK_COMPLETED");
      } catch (error) {
        if (repository.owns(id, token, this.now()))
          repository.interrupt(
            id,
            this.now(),
            controller.signal.aborted ? "cancelled" : "failed",
            taskFailureCode(error),
          );
        trace?.end(controller.signal.aborted ? "cancelled" : "failed", taskFailureCode(error));
      } finally {
        clearInterval(renewal);
        this.controllers.delete(id);
      }
    };
    await (trace ? trace.within(execute) : execute());
    return true;
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      void this.runOnce().catch(() => {
        console.warn("task worker cycle failed");
      });
      if (this.stopped) return;
      let pollMs = DEFAULT_TASK_LIMITS.pollMs;
      try {
        pollMs = this.limits().pollMs;
      } catch {
        // Invalid external configuration stops execution, not the recovery clock.
      }
      this.timer = setTimeout(tick, pollMs);
      this.timer.unref();
    };
    tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const controller of this.controllers.values()) controller.abort(taskError("TASK_STOPPED"));
    await Promise.allSettled([...this.active]);
  }
}
