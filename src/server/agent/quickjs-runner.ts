import { Worker } from "node:worker_threads";
import { z } from "zod";
import { SourceRefSchema } from "../../shared/contracts/evidence";
import { type CodeRunner, type CodeRunResult, CodeToolError } from "./code-runner";
import type { SandboxInput, SandboxMessage, SandboxResponse } from "./quickjs-worker";

const ResultSchema = z.strictObject({
  conclusion: z.string(),
  refs: z.array(SourceRefSchema).max(256).optional(),
});
const fail = (code: string) => Object.assign(new Error(code), { code });
declare const SUPERSTRING_COMPILED: boolean;
const workerUrl =
  typeof SUPERSTRING_COMPILED !== "undefined" && SUPERSTRING_COMPILED
    ? new URL("./src/server/agent/quickjs-worker.js", import.meta.url)
    : new URL("./quickjs-worker.ts", import.meta.url);

export function createQuickJsCodeRunner(): CodeRunner {
  return {
    available: true,
    async run(input): Promise<CodeRunResult> {
      input.signal.throwIfAborted();
      if (!input.script.trim() || input.script.length > 20_000) throw fail("CODE_SCRIPT_LIMIT");
      for (const limit of Object.values(input.limits))
        if (!Number.isSafeInteger(limit) || limit <= 0) throw fail("CODE_LIMIT_INVALID");
      const deadline = Date.now() + input.limits.timeoutMs;
      const worker = new Worker(workerUrl, {
        env: {},
        workerData: {
          script: input.script,
          names: Object.keys(input.bindings),
          limits: input.limits,
          deadline,
        } satisfies SandboxInput,
      });
      const outcome = Promise.withResolvers<CodeRunResult>();
      let closed = false;
      let calls = 0;
      let bytes = 0;
      const finish = (error: unknown, result?: CodeRunResult) => {
        if (closed) return;
        closed = true;
        if (result) outcome.resolve(result);
        else outcome.reject(error);
      };
      const count = (text: string) => {
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > input.limits.maxTransferBytes) throw fail("CODE_TRANSFER_LIMIT");
      };
      const abort = () => finish(input.signal.reason);
      const timer = setTimeout(() => finish(fail("CODE_TIMEOUT")), input.limits.timeoutMs);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const queue: { id: number; name: string; args: Record<string, unknown> }[] = [];
      let active = 0;
      const drain = () => {
        while (!closed && active < input.limits.concurrency && queue.length) {
          const call = queue.shift();
          if (!call) break;
          active++;
          void (async () => {
            input.signal.throwIfAborted();
            if (Date.now() >= deadline) throw fail("CODE_TIMEOUT");
            let result: unknown;
            try {
              result = await input.bindings[call.name](call.args);
            } catch (error) {
              if (!(error instanceof CodeToolError)) throw error;
              if (closed) return;
              input.signal.throwIfAborted();
              if (Date.now() >= deadline) throw fail("CODE_TIMEOUT");
              const detail = { code: error.code, message: error.message };
              count(JSON.stringify(detail));
              worker.postMessage({ id: call.id, error: detail } satisfies SandboxResponse);
              return;
            }
            if (closed) return;
            input.signal.throwIfAborted();
            const json = JSON.stringify(result);
            if (json === undefined) throw fail("CODE_INVALID_RESULT");
            count(json);
            worker.postMessage({ id: call.id, json } satisfies SandboxResponse);
          })()
            .catch((error: unknown) => finish(error))
            .finally(() => {
              active--;
              drain();
            });
        }
      };
      worker.on("message", (message: SandboxMessage) => {
        if (closed) return;
        if (message.type === "error") {
          finish(fail(message.code));
          return;
        }
        try {
          input.signal.throwIfAborted();
          if (Date.now() >= deadline) throw fail("CODE_TIMEOUT");
          count(message.json);
          if (message.type === "result") {
            if (active || queue.length) throw fail("CODE_PENDING_CALLS");
            const parsed = ResultSchema.safeParse(JSON.parse(message.json));
            if (!parsed.success || !parsed.data.conclusion.trim())
              throw fail("CODE_INVALID_RESULT");
            if ([...parsed.data.conclusion].length > input.limits.maxConclusionChars)
              throw fail("CODE_CONCLUSION_TOO_LARGE");
            finish(undefined, parsed.data);
            return;
          }
          if (++calls > input.limits.maxCalls) throw fail("CODE_CALL_LIMIT");
          if (!Object.hasOwn(input.bindings, message.name)) throw fail("CODE_TOOL_DENIED");
          const args: unknown = JSON.parse(message.json);
          if (args === null || typeof args !== "object" || Array.isArray(args))
            throw fail("CODE_INVALID_ARGUMENTS");
          queue.push({ id: message.id, name: message.name, args: args as Record<string, unknown> });
          drain();
        } catch (error) {
          finish(error);
        }
      });
      worker.on("error", (error) =>
        finish(Object.assign(fail("CODE_WORKER_FAILED"), { cause: error })),
      );
      worker.on("exit", () => {
        if (!closed) finish(fail("CODE_WORKER_EXITED"));
      });
      try {
        return await outcome.promise;
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        closed = true;
        queue.length = 0;
        await worker.terminate();
      }
    },
  };
}
