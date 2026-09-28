import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createCodeMode } from "../../src/server/agent/code-mode";
import { CODE_RUN_DEFAULT_LIMITS, type CodeRunnerLimits } from "../../src/server/agent/code-runner";
import { createQuickJsCodeRunner } from "../../src/server/agent/quickjs-runner";
import { compareCodeModes } from "../harness/code-mode";

const runner = createQuickJsCodeRunner();
const run = (
  script: string,
  options: {
    limits?: Partial<CodeRunnerLimits>;
    signal?: AbortSignal;
    bindings?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  } = {},
) =>
  runner.run({
    script,
    bindings: options.bindings ?? {},
    limits: { ...CODE_RUN_DEFAULT_LIMITS, ...options.limits },
    signal: options.signal ?? new AbortController().signal,
  });

describe("QuickJS WASM isolated runner", () => {
  it("keeps the production executable worker embedded and runs without source cwd", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const parent = path.join(root, "artifacts/validation/0.4.0/P6");
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(path.join(parent, "compiled-"));
    const output = path.join(dir, process.platform === "win32" ? "sandbox.exe" : "sandbox");
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          "--root",
          ".",
          "--define",
          "SUPERSTRING_COMPILED=true",
          "tests/fixtures/quickjs-smoke.ts",
          "src/server/agent/quickjs-worker.ts",
          "--outfile",
          output,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [, stderr, exit] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect({ exit, stderr: exit === 0 ? "" : stderr }).toEqual({ exit: 0, stderr: "" });
      const child = Bun.spawn([output], { cwd: dir, stdout: "pipe", stderr: "pipe", env: {} });
      const [text, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      expect(JSON.parse(text)).toEqual({ status: "ok", conclusion: "total=42" });
      const serviceOutput = path.join(
        dir,
        process.platform === "win32" ? "service.exe" : "service",
      );
      const serviceBuild = Bun.spawn(
        [
          process.execPath,
          "build",
          "--compile",
          "--root",
          ".",
          "--define",
          "SUPERSTRING_COMPILED=true",
          "--define",
          "SUPERSTRING_RELEASE=true",
          "--minify-syntax",
          "src/server/installed-entry.ts",
          "src/server/agent/quickjs-worker.ts",
          "--outfile",
          serviceOutput,
        ],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, serviceError, serviceExit] = await Promise.all([
        new Response(serviceBuild.stdout).text(),
        new Response(serviceBuild.stderr).text(),
        serviceBuild.exited,
      ]);
      expect({ serviceExit, serviceError: serviceExit === 0 ? "" : serviceError }).toEqual({
        serviceExit: 0,
        serviceError: "",
      });
      const binary = readFileSync(serviceOutput);
      for (const marker of ["/__dev/probe", "/__dev/ready", "0001_probe.sql"]) {
        expect(binary.includes(Buffer.from(marker))).toBe(false);
        expect(binary.includes(Buffer.from(marker, "utf16le"))).toBe(false);
      }
      for (const file of [
        "tools/installer/build-service.mjs",
        "tools/installer/build-package.mjs",
        "tools/desktop/build/cross-platform/build.mjs",
      ]) {
        const source = readFileSync(path.join(root, file), "utf8");
        expect(source).toContain("src/server/agent/quickjs-worker.ts");
        expect(source).toContain("SUPERSTRING_COMPILED=true");
        expect(source).toContain('"--root"');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
  it("compares direct and programmatic execution using the same synthetic tool data", async () => {
    const report = await compareCodeModes();
    const [direct, code] = report.modes;
    for (const mode of report.modes) {
      expect(mode.output).toBe(report.expected);
      expect(mode.conclusionSeen).toBe(true);
      expect(mode.toolCalls).toBe(3);
      expect(mode.pendingModelSteps).toBe(0);
    }
    expect(direct.rawDataInFinalModelInput).toBe(true);
    expect(code.rawDataInFinalModelInput).toBe(false);
    expect(code.modelCalls).toBeLessThan(direct.modelCalls);
    expect(code.inputUnits).toBeLessThan(direct.inputUnits);
  });
  it("executes JavaScript loops and asynchronous JSON tool calls, without exposing raw data to the caller", async () => {
    const names: string[] = [];
    const result = await run(
      `let total=0; for(const id of [1,2,3]) { total += (await tools["records.read"]({id})).count; }
      return {conclusion: "total="+total};`,
      {
        bindings: {
          "records.read": async (args) => {
            names.push(String(args.id));
            return { count: Number(args.id), private: "raw-data" };
          },
        },
      },
    );
    expect(result).toEqual({ conclusion: "total=6" });
    expect(names).toEqual(["1", "2", "3"]);
  });
  it.each([1, 2, 3, 8])(
    "bounds Promise.all tool calls to %s concurrent bindings",
    async (concurrency) => {
      const started: number[] = [];
      const released = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
      const firstBatch = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      const result = run(
        "const values=await Promise.all(Array.from({length:10},(_,id)=>tools.read({id}))); return {conclusion:JSON.stringify(values)};",
        {
          limits: { concurrency, timeoutMs: 2000 },
          bindings: {
            read: async ({ id }) => {
              const index = Number(id);
              started.push(index);
              peak = Math.max(peak, ++active);
              if (started.length === concurrency) firstBatch.resolve();
              await released[index].promise;
              active--;
              return index;
            },
          },
        },
      );
      try {
        await Promise.race([
          firstBatch.promise,
          result.then(() => {
            throw new Error("missing first batch");
          }),
        ]);
        expect(started).toEqual(Array.from({ length: concurrency }, (_, i) => i));
        for (const gate of released.toReversed()) gate.resolve();
        expect(await result).toEqual({
          conclusion: JSON.stringify(Array.from({ length: 10 }, (_, i) => i)),
        });
        expect(peak).toBe(concurrency);
        expect(active).toBe(0);
      } finally {
        for (const gate of released) gate.resolve();
      }
    },
  );

  it("keeps awaited calls sequential and does not share mutable results", async () => {
    let active = 0;
    let peak = 0;
    const data = { count: 2 };
    expect(
      await run(
        "let sum=0; for(let i=0;i<3;i++){const value=await tools.read({}); sum+=value.count; value.count=99;} return {conclusion:String(sum)};",
        {
          limits: { concurrency: 3 },
          bindings: {
            read: async () => {
              peak = Math.max(peak, ++active);
              await Bun.sleep(5);
              active--;
              return data;
            },
          },
        },
      ),
    ).toEqual({ conclusion: "6" });
    expect(peak).toBe(1);
    expect(data.count).toBe(2);
  });

  it("cancels active parallel calls without starting queued or late work", async () => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let started = 0;
    const result = run(
      'await Promise.all(Array.from({length:6},()=>tools.read({}))); return {conclusion:"late"};',
      {
        signal: controller.signal,
        limits: { concurrency: 2 },
        bindings: {
          read: async () => {
            if (++started === 2) ready.resolve();
            await release.promise;
            return "late";
          },
        },
      },
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        ready.promise,
        result.then(() => {
          throw new Error("missing parallel calls");
        }),
      ]);
      controller.abort(new Error("parallel cancelled"));
      expect(await result).toMatchObject({ message: "parallel cancelled" });
      release.resolve();
      await Bun.sleep(10);
      expect(started).toBe(2);
      expect(await run('return {conclusion:"clean"};')).toEqual({ conclusion: "clean" });
    } finally {
      release.resolve();
    }
  });

  it("matches out-of-order parallel responses to their originating calls", async () => {
    const ready = Promise.withResolvers<void>();
    const slow = Promise.withResolvers<void>();
    const done: number[] = [];
    const result = run(
      "const values=await Promise.all([tools.read({id:0}),tools.read({id:1})]); return {conclusion:JSON.stringify(values)};",
      {
        limits: { concurrency: 2 },
        bindings: {
          read: async ({ id }) => {
            if (id === 0) await slow.promise;
            else ready.resolve();
            done.push(Number(id));
            return id;
          },
        },
      },
    );
    try {
      await Promise.race([
        ready.promise,
        result.then(() => {
          throw new Error("second call never started");
        }),
      ]);
      expect(done).toEqual([1]);
      slow.resolve();
      expect(await result).toEqual({ conclusion: "[0,1]" });
      expect(done).toEqual([1, 0]);
    } finally {
      slow.resolve();
    }
  });

  it("stops queued calls after an active binding fails", async () => {
    const entered = Promise.withResolvers<void>();
    const failFirst = Promise.withResolvers<void>();
    const releaseSlow = Promise.withResolvers<void>();
    const started: number[] = [];
    const result = run(
      'await Promise.all(Array.from({length:5},(_,id)=>tools.read({id}))); return {conclusion:"unexpected"};',
      {
        limits: { concurrency: 2 },
        bindings: {
          read: async ({ id }) => {
            started.push(Number(id));
            if (started.length === 2) entered.resolve();
            if (id === 0) {
              await failFirst.promise;
              throw new Error("synthetic failure");
            }
            await releaseSlow.promise;
            return id;
          },
        },
      },
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error("missing active calls");
        }),
      ]);
      failFirst.resolve();
      expect(await result).toMatchObject({ message: "synthetic failure" });
      releaseSlow.resolve();
      await Bun.sleep(10);
      expect(started).toEqual([0, 1]);
    } finally {
      failFirst.resolve();
      releaseSlow.resolve();
    }
  });

  it("has no host globals, filesystem, network or process bridge", async () => {
    expect(
      await run(`return {conclusion: JSON.stringify([
      typeof process, typeof Bun, typeof require, typeof fetch, typeof WebSocket, typeof XMLHttpRequest,
      typeof Worker, typeof setTimeout, typeof std, typeof os, typeof WebAssembly
    ])};`),
    ).toEqual({ conclusion: JSON.stringify(Array(11).fill("undefined")) });
    expect(
      await run(
        `return {conclusion: tools.constructor === undefined ? "null prototype" : "leak"};`,
      ),
    ).toEqual({ conclusion: "null prototype" });
  });
  it.each([
    "return {conclusion: String(process.env)};",
    'return {conclusion: await Bun.file("synthetic-secret").text()};',
    'return {conclusion: String(await import("node:fs"))};',
    'await fetch("http://127.0.0.1:1/"); return {conclusion:"leak"};',
    'return {conclusion: String(await tools["read"].constructor("return process")())};',
    'await tools["unregistered"]({}); return {conclusion:"leak"};',
  ])("rejects unavailable host access: %s", async (script) => {
    await expect(run(script, { bindings: { read: async () => ({}) } })).rejects.toMatchObject({
      code: "CODE_SCRIPT_ERROR",
    });
  });
  it("does not allow guest data or prototype mutation to escape the JSON boundary", async () => {
    const data = { count: 1 };
    expect(
      await run(
        `const item = await tools.read({"__proto__": {polluted:true}});
      item.count=100; JSON.parse=()=>({count:900});
      return {conclusion:String((await tools.read({})).count)};`,
        { bindings: { read: async () => data } },
      ),
    ).toEqual({ conclusion: "1" });
    expect(data.count).toBe(1);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it("bounds memory, stack, script and transfer sizes", async () => {
    await expect(
      run(
        'const values=[]; for(let i=0;i<1000000;i++) values.push({i,s:"abc"+i}); return {conclusion:"done"};',
        { limits: { memoryBytes: 1024 * 1024 } },
      ),
    ).rejects.toMatchObject({ code: "CODE_MEMORY_LIMIT" });
    await expect(
      run("function recursive(){return recursive()+1}; return {conclusion:String(recursive())};"),
    ).rejects.toMatchObject({ code: "CODE_SCRIPT_ERROR" });
    await expect(run("x".repeat(20_001))).rejects.toMatchObject({ code: "CODE_SCRIPT_LIMIT" });
    await expect(
      run('return {conclusion:"x".repeat(2000)};', { limits: { maxTransferBytes: 1000 } }),
    ).rejects.toMatchObject({ code: "CODE_TRANSFER_LIMIT" });
    await expect(
      run('await tools.read({}); return {conclusion:"ok"};', {
        bindings: { read: async () => "x".repeat(2000) },
        limits: { maxTransferBytes: 1000 },
      }),
    ).rejects.toMatchObject({ code: "CODE_TRANSFER_LIMIT" });
  });
  it("enforces tool count even if a script catches the bridge error", async () => {
    let calls = 0;
    await expect(
      run(
        'for(let i=0;i<5;i++) { try { await tools.read({}); } catch {} } return {conclusion:"ok"};',
        {
          bindings: {
            read: async () => {
              calls++;
              return {};
            },
          },
          limits: { maxCalls: 2 },
        },
      ),
    ).rejects.toMatchObject({ code: "CODE_CALL_LIMIT" });
    expect(calls).toBe(2);
  });
  it.each(["while(true) {}", "await new Promise(()=>{});", "for(;;) await Promise.resolve();"])(
    "terminates bounded CPU or promise waits: %s",
    async (script) => {
      const started = Date.now();
      await expect(run(script, { limits: { timeoutMs: 200 } })).rejects.toMatchObject({
        code: "CODE_TIMEOUT",
      });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await run('return {conclusion:"next run"};')).toEqual({ conclusion: "next run" });
    },
  );
  it("terminates a running guest on cancellation and never executes a late call", async () => {
    const abort = new AbortController();
    const ready = Promise.withResolvers<void>();
    let calls = 0;
    const result = run("await tools.ready({}); while(true) {}", {
      signal: abort.signal,
      bindings: {
        ready: async () => {
          calls++;
          ready.resolve();
          return {};
        },
      },
    }).catch((error: unknown) => error);
    await ready.promise;
    abort.abort(new Error("cancelled"));
    expect(await result).toMatchObject({ message: "cancelled" });
    expect(calls).toBe(1);
    const already = new AbortController();
    already.abort(new Error("already"));
    await expect(run('return {conclusion:"no"};', { signal: already.signal })).rejects.toThrow(
      "already",
    );
  });
  it("refuses source revocation before returning a result or passing data to another tool", async () => {
    let valid = true,
      downstream = 0;
    const actions: BuiltInAction[] = ["read", "revoke", "downstream"].map((name) => ({
      description: { name, effect: "read", capability: "test", description: name, parameters: {} },
      async execute() {
        if (name === "revoke") valid = false;
        if (name === "downstream") downstream++;
        return {
          value: "protected-data",
          sources: name === "read" ? [{ kind: "fixture", id: "secret", revision: "1" }] : [],
        };
      },
    }));
    const mode = createCodeMode({
      actions,
      runner,
      assertSources(refs) {
        if (refs.length && !valid)
          throw Object.assign(new Error("revoked"), { code: "CONTEXT_SOURCE_INVALID" });
      },
    });
    if (!mode.action) throw new Error("missing code action");
    await expect(
      mode.action.execute(
        {
          script:
            "const secret=await tools.read({}); try { await tools.revoke({}); } catch {} await tools.downstream({secret}); return {conclusion:secret};",
        },
        {
          owner: { kind: "test", id: "one" },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(downstream).toBe(0);
  });
  it("rejects a conclusion if guest work is still calling tools and discards late binding results", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const result = run('tools.read({}); return {conclusion:"premature"};', {
      bindings: {
        read: async () => {
          entered.resolve();
          await release.promise;
          return "late";
        },
      },
    }).catch((error: unknown) => error);
    await entered.promise;
    expect(await result).toMatchObject({ code: "CODE_PENDING_CALLS" });
    release.resolve();
  });

  it("retains consumed tool availability checks after the sandbox returns", async () => {
    let current = true;
    const mode = createCodeMode({
      runner,
      actions: [
        {
          description: {
            name: "read",
            description: "read",
            capability: "read",
            effect: "read",
            parameters: {},
          },
          assertAvailable() {
            if (!current)
              throw Object.assign(new Error("changed"), { code: "PERMISSION_REVISION_CHANGED" });
          },
          async execute() {
            return { value: "data", sources: [] };
          },
        },
      ],
    });
    if (!mode.action) throw new Error("missing code action");
    await mode.action.execute(
      { script: "return {conclusion:await tools.read({})};" },
      {
        owner: { kind: "test", id: "one" },
        signal: new AbortController().signal,
      },
    );
    current = false;
    expect(() => mode.action?.assertAvailable?.()).toThrow("changed");
  });

  it("checks every packaged QuickJS license against the installed upstream text", () => {
    const root = path.resolve(import.meta.dir, "../..");
    const notices = readFileSync(
      path.join(root, "tools/installer/licenses/production-NOTICES.txt"),
      "utf8",
    );
    for (const name of [
      "quickjs-emscripten-core",
      "@jitl/quickjs-ffi-types",
      "@jitl/quickjs-singlefile-browser-release-sync",
    ]) {
      expect(notices).toContain(`${name}@0.32.0`);
      expect(notices).toContain(
        readFileSync(path.join(root, "node_modules", name, "LICENSE"), "utf8").trim(),
      );
    }
  });

  it("bounds queued transfer messages before a slow tool can drain them", async () => {
    const release = Promise.withResolvers<void>();
    const result = run(
      'await Promise.all(Array.from({length:4},()=>tools.read({value:"x".repeat(600)}))); return {conclusion:"done"};',
      {
        limits: { maxTransferBytes: 1000 },
        bindings: {
          read: async () => {
            await release.promise;
            return {};
          },
        },
      },
    ).catch((error: unknown) => error);
    try {
      expect(await result).toMatchObject({ code: "CODE_TRANSFER_LIMIT" });
    } finally {
      release.resolve();
    }
  });

  it("validates the conclusion shape and handles concurrent independent guests", async () => {
    await expect(run('return "not an object";')).rejects.toMatchObject({
      code: "CODE_INVALID_RESULT",
    });
    await expect(
      run('return {conclusion:"x".repeat(10)};', { limits: { maxConclusionChars: 3 } }),
    ).rejects.toMatchObject({ code: "CODE_CONCLUSION_TOO_LARGE" });
    expect(
      await Promise.all(
        [1, 2].map((id) =>
          run(`globalThis.privateValue=${id}; return {conclusion:String(privateValue)};`),
        ),
      ),
    ).toEqual([{ conclusion: "1" }, { conclusion: "2" }]);
  });
});
