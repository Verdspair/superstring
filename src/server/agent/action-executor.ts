import type { ExecutionMode } from "../../shared/contracts/permissions";
import { type PermissionService, unconfiguredPermissions } from "../permissions/service";
import type { ActionContext, BuiltInAction } from "./built-in-actions";
import { uniqueSources } from "./context-engine";

export class ActionExecutor {
  constructor(
    readonly permissions: PermissionService = unconfiguredPermissions,
    /** 只读调用的并行上限；函数形式＝每批重新读取（默认 3，协议每批最多 4 项不变）。 */
    private readonly readBatch: () => number = () => 3,
  ) {}
  allowed(action: BuiltInAction, context: ActionContext, mode: ExecutionMode = "direct"): boolean {
    const effect = action.description.effect ?? "write";
    return this.permissions.decide(
      action.permission,
      context.owner,
      mode,
      effect,
      action.sandboxCallable ?? effect === "read",
    ).allowed;
  }
  assert(
    action: BuiltInAction,
    context: ActionContext,
    mode: ExecutionMode = "direct",
    approvalKey?: string,
  ): void {
    context.signal.throwIfAborted();
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
    options: { mode?: ExecutionMode; assertCurrent?: () => void; approvalKey?: string } = {},
  ) {
    const check = () => {
      context.signal.throwIfAborted();
      options.assertCurrent?.();
      this.assert(action, context, options.mode, options.approvalKey);
    };
    check();
    let result: Awaited<ReturnType<BuiltInAction["execute"]>>;
    try {
      result = await action.execute(arguments_, { ...context, assertAuthority: check });
    } catch (error) {
      check();
      throw error;
    }
    check();
    return {
      ...result,
      sources: uniqueSources([
        ...result.sources,
        ...(action.permission ? [this.permissions.source(action.permission)] : []),
      ]),
    };
  }
}
