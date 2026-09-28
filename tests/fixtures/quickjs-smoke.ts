import { CODE_RUN_DEFAULT_LIMITS } from "../../src/server/agent/code-runner";
import { createQuickJsCodeRunner } from "../../src/server/agent/quickjs-runner";

const runner = createQuickJsCodeRunner();
const result = await runner.run({
  script: `const item = await tools["fixture.read"]({id: 1});
    if (typeof process !== "undefined" || typeof fetch !== "undefined" || typeof Bun !== "undefined") throw Error("host leaked");
    return {conclusion: "total=" + item.total};`,
  bindings: { "fixture.read": async () => ({ total: 42 }) },
  limits: CODE_RUN_DEFAULT_LIMITS,
  signal: new AbortController().signal,
});
if (result.conclusion !== "total=42") throw new Error("CODE_SMOKE_FAILED");
const timeout = await runner
  .run({
    script: "while (true) {}",
    bindings: {},
    limits: { ...CODE_RUN_DEFAULT_LIMITS, timeoutMs: 200 },
    signal: new AbortController().signal,
  })
  .catch((error: unknown) => error);
if (!(timeout instanceof Error) || !("code" in timeout) || timeout.code !== "CODE_TIMEOUT")
  throw new Error("CODE_COMPILED_TIMEOUT_FAILED");
console.log(JSON.stringify({ status: "ok", ...result }));
