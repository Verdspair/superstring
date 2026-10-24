import { describe, expect, it } from "bun:test";
import path from "node:path";
import { NapCatRuntimeManager } from "../../src/server/napcat/runtime-manager";

type StartInput = {
  command: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
};

type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  shell: false;
  windowsHide: true;
};

type OwnedChild = {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(): void;
};

type FakeByteStream = {
  readonly stream: ReadableStream<Uint8Array>;
  push(value: string): void;
  close(): void;
};

type FakeChild = {
  readonly child: OwnedChild;
  readonly pid: number;
  readonly killCount: number;
  readonly stdout: FakeByteStream;
  readonly stderr: FakeByteStream;
  exit(code?: number, closeStreams?: boolean): void;
  rejectExit(): void;
};

function byteStream(): FakeByteStream {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    stream,
    push(value) {
      try {
        controller.enqueue(new TextEncoder().encode(value));
      } catch {
        // The manager may cancel a stream when its owned process exits.
      }
    },
    close() {
      try {
        controller.close();
      } catch {
        // The manager may cancel a stream when its owned process exits.
      }
    },
  };
}

function fakeChild(pid: number): FakeChild {
  let resolveExit!: (code: number) => void;
  let rejectExit!: (reason: Error) => void;
  let didExit = false;
  let didRejectExit = false;
  let kills = 0;
  const exited = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const stdout = byteStream();
  const stderr = byteStream();
  return {
    pid,
    child: {
      pid,
      exited,
      stdout: stdout.stream,
      stderr: stderr.stream,
      kill() {
        kills += 1;
      },
    },
    get killCount() {
      return kills;
    },
    stdout,
    stderr,
    exit(code = 0, closeStreams = true) {
      if (didExit || didRejectExit) return;
      didExit = true;
      resolveExit(code);
      if (closeStreams) {
        stdout.close();
        stderr.close();
      }
    },
    rejectExit() {
      if (didExit || didRejectExit) return;
      didRejectExit = true;
      rejectExit(new Error("synthetic child exit observation failed"));
    },
  };
}

function startInput(name: string): StartInput {
  return {
    command: path.resolve(import.meta.dir, "synthetic-runtime", "node"),
    cwd: path.resolve(import.meta.dir, "synthetic-runtime", name),
    args: ["index.js", "--fixture", name],
    env: { RUNTIME_MANAGER_TEST: name },
  };
}

function harness(enabled = true) {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const children: FakeChild[] = [];
  const events: unknown[] = [];
  let nextPid = 41000;
  const manager = new NapCatRuntimeManager({
    enabled,
    spawnChild(command: string, args: string[], options: SpawnOptions) {
      calls.push({ command, args: [...args], options });
      const child = fakeChild(nextPid++);
      children.push(child);
      return child.child;
    },
    onEvent(event: unknown) {
      events.push(event);
    },
  });
  return { manager, calls, children, events };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("NapCat runtime manager lifecycle", () => {
  it("does not spawn or schedule timers while disabled", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    let timeoutCalls = 0;
    let intervalCalls = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timeoutCalls += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervalCalls += 1;
      return originalSetInterval(...args);
    }) as typeof setInterval;

    const { manager, calls } = harness(false);
    try {
      await manager.start(startInput("disabled"));
      await manager.stop({ deadlineMs: 5 });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.setInterval = originalSetInterval;
    }

    expect(calls).toHaveLength(0);
    expect(timeoutCalls).toBe(0);
    expect(intervalCalls).toBe(0);
  });

  it("passes caller-owned absolute launch values without inheriting process environment", async () => {
    const { manager, calls, children } = harness();
    const input = startInput("explicit-launch");

    await manager.start(input);

    expect(calls).toEqual([
      {
        command: input.command,
        args: input.args,
        options: {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          windowsHide: true,
        },
      },
    ]);
    expect(path.isAbsolute(calls[0].command)).toBe(true);
    expect(path.isAbsolute(calls[0].options.cwd)).toBe(true);
    expect(manager.snapshot).toMatchObject({ status: "running", pid: children[0].pid });

    children[0].exit();
    await nextTurn();
  });

  it("coalesces re-entrant start calls before a child is created", async () => {
    const input = startInput("single-start");
    const child = fakeChild(42001);
    const calls: string[] = [];
    let manager!: NapCatRuntimeManager;
    let nestedStart: Promise<unknown> | undefined;
    manager = new NapCatRuntimeManager({
      enabled: true,
      spawnChild(command: string) {
        calls.push(command);
        nestedStart = manager.start(input);
        return child.child;
      },
    });

    const firstStart = manager.start(input);
    await firstStart;

    expect(nestedStart).toBe(firstStart);
    expect(calls).toEqual([input.command]);

    child.exit();
    await nextTurn();
  });

  it("coalesces concurrent stop calls and only signals the owned child", async () => {
    const { manager, calls, children } = harness();
    await manager.start(startInput("owned-only"));
    const child = children[0];

    const firstStop = manager.stop({ deadlineMs: 100 });
    const secondStop = manager.stop({ deadlineMs: 100 });

    expect(secondStop).toBe(firstStop);
    expect(child.killCount).toBe(1);
    expect(calls).toHaveLength(1);

    child.exit();
    await Promise.all([firstStop, secondStop]);
    expect(manager.snapshot).toMatchObject({ status: "stopped" });
  });

  it("does not spawn a replacement when start arrives during stop", async () => {
    const { manager, calls, children } = harness();
    await manager.start(startInput("stopping"));
    const child = children[0];
    const stopping = manager.stop({ deadlineMs: 100 });
    const duringStop = manager.start(startInput("during-stop"));

    expect(calls).toHaveLength(1);
    expect(child.killCount).toBe(1);

    child.exit();
    await Promise.allSettled([stopping, duringStop]);
    expect(calls).toHaveLength(1);
  });

  it("reports a caller-deadline stop timeout while retaining ownership until exit", async () => {
    const { manager, calls, children } = harness();
    await manager.start(startInput("bounded-stop"));
    const child = children[0];

    const result = await manager.stop({ deadlineMs: 5 });

    expect(child.killCount).toBe(1);
    expect(JSON.stringify({ result, snapshot: manager.snapshot })).toContain("stop_timeout");
    expect(manager.snapshot).toMatchObject({ status: "failed", pid: child.pid });
    await expect(manager.start(startInput("blocked-by-owned-child"))).rejects.toMatchObject({
      code: "child_still_owned",
    });
    expect(calls).toHaveLength(1);

    child.exit();
    await nextTurn();
    expect(manager.snapshot).toMatchObject({ status: "stopped" });

    await manager.start(startInput("after-owned-exit"));
    expect(calls).toHaveLength(2);
    children[1].exit();
    await nextTurn();
  });

  it("keeps ownership and drains stderr when stdout is locked before spawn returns", async () => {
    const child = fakeChild(43001);
    const externalReader = child.stdout.stream.getReader();
    const calls: string[] = [];
    const manager = new NapCatRuntimeManager({
      enabled: true,
      spawnChild(command: string) {
        calls.push(command);
        return child.child;
      },
    });

    await manager.start(startInput("locked-output"));
    child.stdout.push("locked-stdout-content");
    child.stderr.push("drainable-stderr-content");
    await nextTurn();

    expect(await externalReader.read()).toMatchObject({
      done: false,
      value: new TextEncoder().encode("locked-stdout-content"),
    });
    expect(manager.snapshot).toMatchObject({ status: "running", pid: child.pid, stdoutBytes: 0 });
    expect(manager.snapshot.stderrBytes).toBe(
      new TextEncoder().encode("drainable-stderr-content").byteLength,
    );
    await expect(manager.start(startInput("existing-owned-child"))).resolves.toMatchObject({
      status: "running",
      pid: child.pid,
    });
    expect(calls).toHaveLength(1);

    child.exit();
    await nextTurn();
    expect(manager.snapshot).toMatchObject({ status: "stopped" });
    expect(await externalReader.read()).toMatchObject({ done: true });
    externalReader.releaseLock();
  });

  it("retains ownership and continues draining output when exit observation rejects", async () => {
    const { manager, calls, children } = harness();
    await manager.start(startInput("rejected-exit-observation"));
    const child = children[0];
    child.rejectExit();
    await nextTurn();

    child.stdout.push("still-owned-after-observation-error");
    await nextTurn();
    expect(manager.snapshot).toMatchObject({ status: "failed", pid: child.pid });
    expect(manager.snapshot.stdoutBytes).toBe(
      new TextEncoder().encode("still-owned-after-observation-error").byteLength,
    );
    await expect(manager.start(startInput("not-safe-to-replace"))).rejects.toMatchObject({
      code: "child_still_owned",
    });
    expect(calls).toHaveLength(1);

    expect(manager.snapshot).toMatchObject({ status: "failed", pid: child.pid });
    expect(calls).toHaveLength(1);
    child.stdout.close();
    child.stderr.close();
    await nextTurn();
    expect(manager.snapshot).toMatchObject({ status: "failed", pid: child.pid });
    expect(calls).toHaveLength(1);
  });

  it("keeps late output from a closed generation out of the new process snapshot", async () => {
    const { manager, children, events } = harness();
    await manager.start(startInput("old-generation"));
    const oldChild = children[0];
    oldChild.exit(0, false);
    await nextTurn();

    await manager.start(startInput("new-generation"));
    const newChild = children[1];
    const eventCount = events.length;
    oldChild.stdout.push("old-generation-private-output");
    oldChild.stderr.push("old-generation-private-error");
    await nextTurn();

    expect(manager.snapshot).toMatchObject({ status: "running", pid: newChild.pid });
    expect(events.slice(eventCount)).toHaveLength(0);
    expect(JSON.stringify({ snapshot: manager.snapshot, events })).not.toContain(
      "old-generation-private",
    );

    newChild.exit();
    await nextTurn();
  });

  it("counts stdout and stderr without retaining their contents", async () => {
    const { manager, children, events } = harness();
    await manager.start(startInput("content-free-output"));
    const child = children[0];
    const stdout = "synthetic-stdout-content-must-not-be-retained";
    const stderr = "synthetic-stderr-content-must-not-be-retained";
    child.stdout.push(stdout);
    child.stderr.push(stderr);
    await nextTurn();

    expect(manager.snapshot).toMatchObject({
      status: "running",
      stdoutBytes: new TextEncoder().encode(stdout).byteLength,
      stderrBytes: new TextEncoder().encode(stderr).byteLength,
    });
    const observable = JSON.stringify({ snapshot: manager.snapshot, events });
    expect(observable).not.toContain(stdout);
    expect(observable).not.toContain(stderr);

    child.exit();
    await nextTurn();
  });
});
