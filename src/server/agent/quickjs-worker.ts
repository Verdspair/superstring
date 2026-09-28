import { parentPort, workerData } from "node:worker_threads";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import type { CodeRunnerLimits } from "./code-runner";

export interface SandboxInput {
  script: string;
  names: string[];
  limits: CodeRunnerLimits;
  deadline: number;
}
export type SandboxResponse = { id: number; json: string };
export type SandboxMessage =
  | { type: "call"; id: number; name: string; json: string }
  | { type: "result"; json: string }
  | { type: "error"; code: string };

const port = parentPort;
if (!port) throw new Error("CODE_WORKER_REQUIRED");
const input = workerData as SandboxInput;
const fail = (code: string) => Object.assign(new Error(code), { code });
const responses: SandboxResponse[] = [];
let wake: (() => void) | undefined;
port.on("message", (response: SandboxResponse) => {
  responses.push(response);
  wake?.();
  wake = undefined;
});

async function execute(): Promise<string> {
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(input.limits.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= input.deadline);
  const vm = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  const handles: QuickJSHandle[] = [];
  let calls = 0;
  let bridgeFailure: string | undefined;
  const boundedString = (handle: QuickJSHandle): string => {
    if (vm.typeof(handle) !== "string") throw fail("CODE_INVALID_RESULT");
    const length = vm.getProp(handle, "length");
    try {
      if (vm.getNumber(length) > input.limits.maxTransferBytes) throw fail("CODE_TRANSFER_LIMIT");
    } finally {
      length.dispose();
    }
    return vm.getString(handle);
  };
  const guestFailure = (error: QuickJSHandle): Error => {
    if (Date.now() >= input.deadline) return fail("CODE_TIMEOUT");
    const message = vm.getProp(error, "message");
    try {
      const text = vm.typeof(message) === "string" ? boundedString(message) : "";
      return fail(text === "out of memory" ? "CODE_MEMORY_LIMIT" : "CODE_SCRIPT_ERROR");
    } finally {
      message.dispose();
    }
  };
  const take = (result: ReturnType<typeof vm.evalCode>): QuickJSHandle => {
    if (result.error) {
      try {
        throw guestFailure(result.error);
      } finally {
        result.error.dispose();
      }
    }
    handles.push(result.value);
    return result.value;
  };
  try {
    const bridge = vm.newFunction("toolBridge", (name, json) => {
      try {
        const tool = boundedString(name);
        const args = boundedString(json);
        if (!input.names.includes(tool)) throw fail("CODE_TOOL_DENIED");
        if (++calls > input.limits.maxCalls) throw fail("CODE_CALL_LIMIT");
        const deferred = vm.newPromise();
        pending.set(calls, deferred);
        port?.postMessage({
          type: "call",
          id: calls,
          name: tool,
          json: args,
        } satisfies SandboxMessage);
        return deferred.handle.dup();
      } catch (error) {
        bridgeFailure =
          error instanceof Error && "code" in error ? String(error.code) : "CODE_INVALID_ARGUMENTS";
        return { error: vm.newError(bridgeFailure) };
      }
    });
    handles.push(bridge);
    const bootstrap = take(
      vm.evalCode(`(bridge => {
      const stringify = JSON.stringify, parse = JSON.parse;
      const tools = Object.create(null);
      for (const name of ${JSON.stringify(input.names)})
        tools[name] = async args => parse(await bridge(name, stringify(args)));
      return { tools: Object.freeze(tools), encode: value => stringify(value) };
    })`),
    );
    const setup = take(vm.callFunction(bootstrap, vm.undefined, bridge));
    const tools = vm.getProp(setup, "tools");
    const encode = vm.getProp(setup, "encode");
    handles.push(tools, encode);
    const script = take(
      vm.evalCode(`(async function(tools) { "use strict";\n${input.script}\n})`, "sandbox.js"),
    );
    const promise = take(vm.callFunction(script, vm.undefined, tools));
    for (;;) {
      if (Date.now() >= input.deadline) throw fail("CODE_TIMEOUT");
      for (const response of responses.splice(0)) {
        const deferred = pending.get(response.id);
        if (!deferred) throw fail("CODE_PROTOCOL_ERROR");
        const value = vm.newString(response.json);
        deferred.resolve(value);
        value.dispose();
        deferred.dispose();
        pending.delete(response.id);
      }
      const jobs = runtime.executePendingJobs(64);
      if (jobs.error) {
        try {
          throw guestFailure(jobs.error);
        } finally {
          jobs.error.dispose();
        }
      }
      if (bridgeFailure) throw fail(bridgeFailure);
      const state = vm.getPromiseState(promise);
      if (state.type === "rejected") {
        try {
          throw guestFailure(state.error);
        } finally {
          state.error.dispose();
        }
      }
      if (state.type === "fulfilled") {
        handles.push(state.value);
        if (pending.size) throw fail("CODE_PENDING_CALLS");
        return boundedString(take(vm.callFunction(encode, vm.undefined, state.value)));
      }
      if (runtime.hasPendingJob()) await new Promise<void>((resolve) => setImmediate(resolve));
      else if (!responses.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    for (const deferred of pending.values()) deferred.dispose();
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

void execute()
  .then(
    (json) => port.postMessage({ type: "result", json } satisfies SandboxMessage),
    (error: unknown) =>
      port.postMessage({
        type: "error",
        code:
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          /^CODE_[A-Z_]+$/.test(error.code)
            ? error.code
            : "CODE_SCRIPT_ERROR",
      } satisfies SandboxMessage),
  )
  .finally(() => port.close());
