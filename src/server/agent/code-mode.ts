import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  resolveAgentTraceScope,
  startAgentTrace,
  traceErrorCode,
} from "../observability/agent-tracing";
import type { RuntimeTelemetry } from "../observability/runtime-telemetry";
import { PermissionError } from "../permissions/service";
import { ActionExecutor } from "./action-executor";
import type { BuiltInAction } from "./built-in-actions";
import {
  CODE_RUN_DEFAULT_LIMITS,
  type CodeRunner,
  type CodeRunnerLimits,
  CodeToolError,
} from "./code-runner";
import { uniqueSources } from "./context-engine";
import { createToolCatalog, type ToolCatalog } from "./tool-catalog";

export interface CodeModeOptions {
  readonly actions: readonly BuiltInAction[];
  readonly runner: CodeRunner;
  readonly executor?: ActionExecutor;
  readonly telemetry?: RuntimeTelemetry;
  readonly limits?: Partial<CodeRunnerLimits>;
  readonly assertCurrent?: () => void;
  readonly assertSources?: (sources: readonly SourceRef[]) => void;
}
export interface CodeMode {
  readonly action: BuiltInAction | null;
  readonly catalog: ToolCatalog;
}
const RunSchema = z.strictObject({ script: z.string().min(1).max(20_000) });

function recoverToolError(error: unknown): CodeToolError {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (
    error instanceof PermissionError ||
    /^(?:PERMISSION|CONTEXT|CODE|AGENT|TASK|MCP)_/.test(code) ||
    /_(?:DENIED|REVOKED|CHANGED|EXPIRED|LIMIT|TOO_LARGE|PROTOCOL_ERROR|BUDGET_EXCEEDED)$/.test(
      code,
    ) ||
    (error instanceof Error && error.name === "AbortError")
  )
    throw error;
  return new CodeToolError(error);
}

export function createCodeMode(options: CodeModeOptions): CodeMode {
  const catalog = createToolCatalog(options.actions);
  if (!options.runner.available) return { action: null, catalog };
  const executor = options.executor ?? new ActionExecutor();
  const limits: CodeRunnerLimits = { ...CODE_RUN_DEFAULT_LIMITS, ...options.limits };
  const byName = new Map(options.actions.map((action) => [action.description.name, action]));
  const consumed = new Set<BuiltInAction>();
  const action: BuiltInAction = {
    sandboxCallable: false,
    assertAvailable: () => {
      for (const target of consumed) target.assertAvailable?.();
    },
    description: {
      name: "code.run",
      capability: "code.execute",
      effect: "write",
      description: `Run an async JavaScript function body in an isolated sandbox. Call await tools["name"]({arguments}) using only: ${catalog
        .sandboxable()
        .map((tool) => tool.name)
        .join(
          ", ",
        )}. Independent calls may use Promise.all, bounded to ${limits.concurrency} concurrent calls. Ordinary tool exceptions reject with an error.code and may be caught or retried within the same limits; permission, source, cancellation and resource failures terminate execution. Unavailable result envelopes remain data to inspect. Return {conclusion: "short factual conclusion", refs?: []}; do not return raw tool data. No filesystem, network, imports, process or timers are available.`,

      parameters: z.toJSONSchema(RunSchema),
    },
    async execute(arguments_, context) {
      context.signal.throwIfAborted();
      const input = RunSchema.parse(arguments_);
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      const lifetime = new AbortController();
      const signal = AbortSignal.any([context.signal, timeout, lifetime.signal]);
      const sources: SourceRef[] = [];
      const calls: string[] = [];
      const used = new Set<BuiltInAction>();
      let attempts = 0;
      let failedCalls = 0;
      let ended = false;
      let authorityFailure: { error: unknown } | undefined;
      const started = Date.now();
      const failAuthority = (error: unknown): never => {
        authorityFailure ??= { error };
        lifetime.abort(error);
        throw error;
      };
      const check = () => {
        signal.throwIfAborted();
        options.assertCurrent?.();
        options.assertSources?.(sources);
        for (const target of used) executor.assert(target, { ...context, signal }, "sandbox");
      };
      const bindings = Object.create(null) as Record<
        string,
        (args: Record<string, unknown>) => Promise<unknown>
      >;
      for (const descriptor of catalog.sandboxable()) {
        const target = byName.get(descriptor.name);
        if (!target || !executor.allowed(target, context, "sandbox")) continue;
        bindings[descriptor.name] = async (args) => {
          signal.throwIfAborted();
          if (ended) throw new PermissionError("CODE_RUN_CLOSED");
          if (++attempts > limits.maxCalls) throw new PermissionError("CODE_CALL_LIMIT");
          try {
            const result = await executor.execute(
              target,
              args,
              { ...context, signal },
              { mode: "sandbox", assertCurrent: check, mapToolError: recoverToolError },
            );
            check();
            calls.push(descriptor.name);
            used.add(target);
            consumed.add(target);
            sources.push(...result.sources);
            options.assertSources?.(sources);
            return result.value;
          } catch (error) {
            if (!(error instanceof CodeToolError)) return failAuthority(error);
            try {
              check();
              executor.assert(target, { ...context, signal }, "sandbox");
              if (target.permission) sources.push(executor.permissions.source(target.permission));
              used.add(target);
              consumed.add(target);
              options.assertSources?.(sources);
              failedCalls++;
            } catch (failure) {
              return failAuthority(failure);
            }
            throw error;
          }
        };
      }
      const trace = startAgentTrace(options.telemetry, "agent.code", (telemetry) => ({
        ...resolveAgentTraceScope(telemetry, context.owner),
        runId: context.runId,
        stage: "action",
        sources: context.sources,
        details: {
          orchestration: "code",
          bindings: Object.keys(bindings).join(","),
          timeoutMs: limits.timeoutMs,
          concurrency: limits.concurrency,
          memoryBytes: limits.memoryBytes,
          maxTransferBytes: limits.maxTransferBytes,
        },
      }));
      let traceCode = "CODE_COMPLETED";
      let traceStatus: "completed" | "failed" | "cancelled" = "completed";
      const unavailable = (code: string) => {
        traceStatus = "failed";
        traceCode = code;
        return {
          value: {
            status: "unavailable",
            code,
            calls: calls.length,
            ...(failedCalls ? { failedCalls } : {}),
            tools: calls,
            bindings: Object.keys(bindings),
            durationMs: Date.now() - started,
          },
          sources: uniqueSources(sources),
        };
      };
      let onAbort = () => {};
      try {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const result = await Promise.race([
          options.runner.run({ script: input.script, bindings, limits, signal }),
          aborted,
        ]);
        if (authorityFailure) throw authorityFailure.error;
        if (attempts > limits.maxCalls) return unavailable("CODE_CALL_LIMIT");
        check();
        if (typeof result.conclusion !== "string" || !result.conclusion.trim())
          return unavailable("CODE_INVALID_RESULT");
        if ([...result.conclusion].length > limits.maxConclusionChars)
          return unavailable("CODE_CONCLUSION_TOO_LARGE");
        const refs = result.refs ?? [];
        if (
          refs.some(
            (ref) =>
              !sources.some(
                (source) =>
                  source.kind === ref.kind &&
                  source.id === ref.id &&
                  source.revision === ref.revision,
              ),
          )
        )
          return unavailable("CODE_REFERENCE_INVALID");
        return {
          value: {
            status: "ok",
            conclusion: result.conclusion,
            calls: calls.length,
            ...(failedCalls ? { failedCalls } : {}),
            tools: calls,
            bindings: Object.keys(bindings),
            refs: refs.length,
            durationMs: Date.now() - started,
          },
          sources: uniqueSources(sources),
        };
      } catch (error) {
        traceStatus = context.signal.aborted ? "cancelled" : "failed";
        traceCode = traceErrorCode(error);
        context.signal.throwIfAborted();
        if (timeout.aborted) return unavailable("CODE_TIMEOUT");
        if (
          authorityFailure ||
          (error instanceof PermissionError && error.code.startsWith("PERMISSION_"))
        )
          throw authorityFailure ? authorityFailure.error : error;
        check();
        return unavailable(
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "CODE_RUNNER_FAILED",
        );
      } finally {
        ended = true;
        trace?.update({
          sources: uniqueSources([...(context.sources ?? []), ...sources]),
          details: {
            toolCalls: attempts,
            completedToolCalls: calls.length,
            failedToolCalls: failedCalls,
            tools: calls.join(","),
          },
        });
        trace?.end(traceStatus, traceCode);
        signal.removeEventListener("abort", onAbort);
        lifetime.abort(new PermissionError("CODE_RUN_CLOSED"));
      }
    },
  };
  return { action, catalog };
}
