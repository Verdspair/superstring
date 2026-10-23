import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { ExecutionMode } from "../../shared/contracts/permissions";
import type { QqGroupCapability } from "../../shared/contracts/qq-group-config";
import { type PermissionService, unconfiguredPermissions } from "../permissions/service";
import { type ActionContext, type BuiltInAction, ReadRetryDeadlineError } from "./built-in-actions";
import { type ActionObservation, uniqueSources } from "./context-engine";

/** 本群能力停用的执行边界。结构类型：Runtime 只装配一个 guard，缺省不传＝行为不变。 */
export interface ActionGuard {
  assert(owner: RunOwner, capability: QqGroupCapability): void;
  allowed(owner: RunOwner, capability: QqGroupCapability): boolean;
  /** 能力当前启用的来源引用（含停用纪元）：非停用面＝[]，供入队等长生命周期点冻结纪元。 */
  sources(owner: RunOwner, capability: QqGroupCapability): readonly SourceRef[];
  actionAllowed(action: BuiltInAction, owner: RunOwner): boolean;
  assertAction(
    action: BuiltInAction,
    owner: RunOwner,
    options?: { readonly retainedCarrierObservation?: Pick<ActionObservation, "name" | "sources"> },
  ): void;
  actionSources(action: BuiltInAction, owner: RunOwner): readonly SourceRef[];
  assertSources(owner: RunOwner, sources: readonly SourceRef[]): void;
}

export class ActionExecutor {
  constructor(
    readonly permissions: PermissionService = unconfiguredPermissions,
    /** 只读调用的并行上限；函数形式＝每批重新读取（默认 3，协议每批最多 4 项不变）。 */
    private readonly readBatch: () => number = () => 3,
    /** 本群能力 guard；缺省＝不做本群判定（非 QQ 通道与既有测试）。 */
    readonly guard?: ActionGuard,
  ) {}
  allowed(action: BuiltInAction, context: ActionContext, mode: ExecutionMode = "direct"): boolean {
    const effect = action.description.effect ?? "write";
    if (
      !this.permissions.decide(
        action.permission,
        context.owner,
        mode,
        effect,
        action.sandboxCallable ?? effect === "read",
      ).allowed
    )
      return false;
    return this.guard?.actionAllowed(action, context.owner) ?? true;
  }
  assert(
    action: BuiltInAction,
    context: ActionContext,
    mode: ExecutionMode = "direct",
    approvalKey?: string,
    options?: { readonly retainedCarrierObservation?: Pick<ActionObservation, "name" | "sources"> },
  ): void {
    context.signal.throwIfAborted();
    // 入场边界＝群能力与权限各查一次；生产 FilePermissionStore 的读取不回写库，
    // 同帧再查同一事实没有新信息。飞行期间的撤权由 execute() 跨 await 的 check() 复验。
    this.guard?.assertAction(action, context.owner, options);
    const effect = action.description.effect ?? "write";
    this.permissions.assert(
      action.permission,
      context.owner,
      mode,
      effect,
      action.sandboxCallable ?? effect === "read",
      approvalKey,
    );
    action.assertAvailable?.();
  }
  async executeBatch(
    calls: readonly { action: BuiltInAction; arguments: Record<string, unknown> }[],
    context: ActionContext,
    options: { mode?: ExecutionMode; assertCurrent?: () => void } = {},
  ) {
    options.assertCurrent?.();
    for (const { action } of calls) this.assert(action, context, options.mode);
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const results: Awaited<ReturnType<ActionExecutor["execute"]>>[] = [];
    const execute = async (index: number) => {
      const call = calls[index];
      try {
        results[index] = await this.execute(
          call.action,
          call.arguments,
          { ...context, signal },
          options,
        );
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };
    const reads = calls.flatMap((call, index) =>
      call.action.description.effect === "read" ? [index] : [],
    );
    const batch = Math.max(1, Math.floor(this.readBatch()));
    for (let index = 0; index < reads.length; index += batch) {
      await Promise.allSettled(reads.slice(index, index + batch).map(execute));
      signal.throwIfAborted();
    }
    for (const [index, call] of calls.entries()) {
      if (call.action.description.effect !== "read") await execute(index);
    }
    return results;
  }
  async execute(
    action: BuiltInAction,
    arguments_: Record<string, unknown>,
    context: ActionContext,
    options: {
      mode?: ExecutionMode;
      assertCurrent?: () => void;
      approvalKey?: string;
      mapToolError?: (error: unknown) => unknown;
    } = {},
  ) {
    // An action cannot swallow a failed checkpoint and turn it into a recoverable tool error.
    let authorityFailure: { error: unknown } | undefined;
    let guardFailure: { error: unknown } | undefined;
    const check = () => {
      if (authorityFailure) throw authorityFailure.error;
      if (guardFailure) throw guardFailure.error;
      try {
        context.signal.throwIfAborted();
        options.assertCurrent?.();
        this.assert(action, context, options.mode, options.approvalKey);
      } catch (error) {
        authorityFailure = { error };
        throw error;
      }
    };
    check();
    // 引用按动作开始时的纪元签发：飞行期间 off→on，未提交的旧结果也不得按新纪元复活。
    const capSources = this.guard?.actionSources(action, context.owner) ?? [];
    // 来源纪元复验：每次复试前与结果提交前 live 执行；失败缓存并经 check() 硬传播，
    // 不被适配层折成工具信封。
    const assertSources = () => {
      if (guardFailure) throw guardFailure.error;
      try {
        this.guard?.assertSources(context.owner, capSources);
        context.assertSources?.(capSources);
      } catch (error) {
        guardFailure = { error };
        throw error;
      }
    };
    const executeContext: ActionContext = {
      ...context,
      assertAuthority: check,
      runReadWithRetry: async (input) => {
        if (action.description.effect !== "read" || context.retryOrigin !== "system")
          return input.operation(context.signal, input.timeoutMs);
        // 策略快照由属主在 run 起点复制一次（Runtime / TaskService 领取）；本循环只消费，不再读配置。
        const policy = context.retryPolicy;
        if (!policy || policy.maxAttempts <= 1)
          return input.operation(context.signal, input.timeoutMs);
        const deadline = Date.now() + input.timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new ReadRetryDeadlineError()),
          input.timeoutMs,
        );
        const signal = AbortSignal.any([context.signal, controller.signal]);
        const attempt = (remainingMs: number) => {
          signal.throwIfAborted();
          check();
          return input.operation(signal, remainingMs);
        };
        try {
          for (let number = 1; ; number += 1) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new ReadRetryDeadlineError();
            try {
              return await attempt(remaining);
            } catch (error) {
              if (context.signal.aborted) context.signal.throwIfAborted();
              if (signal.aborted) throw signal.reason ?? new ReadRetryDeadlineError();
              if (number >= policy.maxAttempts || !input.isRetryableRejection(error)) throw error;
              const waitMs = Math.min(policy.retryDelayMs, deadline - Date.now());
              if (waitMs <= 0) throw new ReadRetryDeadlineError();
              await new Promise<void>((resolve, reject) => {
                const finish = (failure?: unknown) => {
                  clearTimeout(wait);
                  signal.removeEventListener("abort", onAbort);
                  failure === undefined ? resolve() : reject(failure);
                };
                const onAbort = () => finish(signal.reason ?? new ReadRetryDeadlineError());
                const wait = setTimeout(() => finish(), waitMs);
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
              });
              signal.throwIfAborted();
              check();
              // 复试前 live 复验来源纪元：期间 off→on（停用纪元变化）即硬失败，不复活旧结果。
              assertSources();
            }
          }
        } finally {
          clearTimeout(timer);
        }
      },
    };
    let result: Awaited<ReturnType<BuiltInAction["execute"]>>;
    try {
      result = await action.execute(arguments_, executeContext);
    } catch (error) {
      check();
      // 总时限守卫失败是硬失败：不得经工具错误映射变成可恢复的工具信封。
      if (error instanceof ReadRetryDeadlineError) throw error;
      throw options.mapToolError ? options.mapToolError(error) : error;
    }
    check();
    // 捕获纪元的引用失效是执行边界：硬失败，不随工具错误映射。
    assertSources();
    const sources = uniqueSources([
      ...result.sources,
      ...(action.permission ? [this.permissions.source(action.permission)] : []),
      ...capSources,
    ]);
    if (action.description.effect === "read" && action.fitResult) {
      const value = await action.fitResult(result.value, sources, arguments_, executeContext);
      check();
      assertSources();
      return { ...result, value, sources };
    }
    return { ...result, sources };
  }
}
