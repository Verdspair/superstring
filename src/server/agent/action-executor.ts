import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { ExecutionMode } from "../../shared/contracts/permissions";
import type { QqGroupCapability } from "../../shared/contracts/qq-group-config";
import { type PermissionService, unconfiguredPermissions } from "../permissions/service";
import type { ActionContext, BuiltInAction } from "./built-in-actions";
import { uniqueSources } from "./context-engine";

/** 本群能力停用的执行边界。结构类型：Runtime 只装配一个 guard，缺省不传＝行为不变。 */
export interface ActionGuard {
  assert(owner: RunOwner, capability: QqGroupCapability): void;
  allowed(owner: RunOwner, capability: QqGroupCapability): boolean;
  /** 能力当前启用的来源引用（含停用纪元）：非停用面＝[]，供入队等长生命周期点冻结纪元。 */
  sources(owner: RunOwner, capability: QqGroupCapability): readonly SourceRef[];
  actionAllowed(action: BuiltInAction, owner: RunOwner): boolean;
  assertAction(action: BuiltInAction, owner: RunOwner): void;
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
  ): void {
    context.signal.throwIfAborted();
    // 群能力停用即时生效：包围原权限断言，任一时刻被停用都在这里硬失败。
    this.guard?.assertAction(action, context.owner);
    const effect = action.description.effect ?? "write";
    this.permissions.assert(
      action.permission,
      context.owner,
      mode,
      effect,
      action.sandboxCallable ?? effect === "read",
      approvalKey,
    );
    this.guard?.assertAction(action, context.owner);
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
    const check = () => {
      if (authorityFailure) throw authorityFailure.error;
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
    let result: Awaited<ReturnType<BuiltInAction["execute"]>>;
    try {
      result = await action.execute(arguments_, { ...context, assertAuthority: check });
    } catch (error) {
      check();
      throw options.mapToolError ? options.mapToolError(error) : error;
    }
    check();
    // 捕获纪元的引用失效是执行边界：硬失败，不随工具错误映射。
    this.guard?.assertSources(context.owner, capSources);
    return {
      ...result,
      sources: uniqueSources([
        ...result.sources,
        ...(action.permission ? [this.permissions.source(action.permission)] : []),
        ...capSources,
      ]),
    };
  }
}
