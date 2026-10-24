import path from "node:path";

export interface NapCatRuntimeChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(): void;
}

export interface NapCatRuntimeSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly windowsHide: true;
}

export type NapCatRuntimeOutputEvent = {
  readonly type: "stdout_bytes" | "stderr_bytes";
  readonly pid: number;
  readonly bytes: number;
};

export type NapCatRuntimeManagerErrorCode =
  | "invalid_launch"
  | "spawn_failed"
  | "stop_in_progress"
  | "child_still_owned"
  | "stop_timeout"
  | "stop_failed"
  | "child_exit_unknown";

export class NapCatRuntimeManagerError extends Error {
  constructor(readonly code: NapCatRuntimeManagerErrorCode) {
    super(`NapCat runtime manager failed: ${code}`);
    this.name = "NapCatRuntimeManagerError";
  }
}

export interface NapCatRuntimeSnapshot {
  readonly status: "disabled" | "stopped" | "starting" | "running" | "stopping" | "failed";
  readonly pid?: number;
  readonly code?: NapCatRuntimeManagerErrorCode;
  readonly exitCode?: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface NapCatRuntimeManagerOptions {
  readonly enabled: boolean;
  readonly spawnChild: (
    command: string,
    args: string[],
    options: NapCatRuntimeSpawnOptions,
  ) => NapCatRuntimeChild;
  readonly onEvent?: (event: NapCatRuntimeOutputEvent) => void;
}

export interface NapCatRuntimeStartInput {
  readonly command: string;
  readonly cwd: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export type NapCatRuntimeStopResult =
  | { readonly status: "stopped" }
  | { readonly status: "disabled" }
  | {
      readonly status: "failed";
      readonly code: "stop_timeout" | "stop_failed" | "child_exit_unknown" | "spawn_failed";
    };

type OutputKind = "stdout" | "stderr";
type ChildReader = ReadableStreamDefaultReader<Uint8Array>;
type StopResolution = (result: NapCatRuntimeStopResult) => void;
type ActiveStop = {
  readonly child: NapCatRuntimeChild;
  readonly generation: number;
  readonly resolve: StopResolution;
};

export class NapCatRuntimeManager {
  readonly #enabled: boolean;
  readonly #spawnChild: NapCatRuntimeManagerOptions["spawnChild"];
  readonly #onEvent: NapCatRuntimeManagerOptions["onEvent"];
  #snapshot: NapCatRuntimeSnapshot;
  #child: NapCatRuntimeChild | null = null;
  #generation = 0;
  #startPromise: Promise<NapCatRuntimeSnapshot> | null = null;
  #stopPromise: Promise<NapCatRuntimeStopResult> | null = null;
  #activeStop: ActiveStop | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: NapCatRuntimeManagerOptions) {
    this.#enabled = options.enabled;
    this.#spawnChild = options.spawnChild;
    this.#onEvent = options.onEvent;
    this.#snapshot = {
      status: options.enabled ? "stopped" : "disabled",
      stdoutBytes: 0,
      stderrBytes: 0,
    };
  }

  get snapshot(): NapCatRuntimeSnapshot {
    return { ...this.#snapshot };
  }

  start(input: NapCatRuntimeStartInput): Promise<NapCatRuntimeSnapshot> {
    if (!this.#enabled) return Promise.resolve(this.snapshot);
    if (this.#stopPromise) {
      return Promise.reject(new NapCatRuntimeManagerError("stop_in_progress"));
    }
    if (this.#startPromise) return this.#startPromise;
    if (this.#child) {
      if (this.#snapshot.status === "running") return Promise.resolve(this.snapshot);
      return Promise.reject(new NapCatRuntimeManagerError("child_still_owned"));
    }
    if (!path.isAbsolute(input.command) || !path.isAbsolute(input.cwd)) {
      return Promise.reject(new NapCatRuntimeManagerError("invalid_launch"));
    }

    const generation = ++this.#generation;
    this.#snapshot = {
      status: "starting",
      stdoutBytes: 0,
      stderrBytes: 0,
    };

    const operation = Promise.resolve()
      .then(() => {
        const child = this.#spawnChild(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          windowsHide: true,
        });
        this.#child = child;
        this.#snapshot = {
          status: "running",
          pid: child.pid,
          stdoutBytes: 0,
          stderrBytes: 0,
        };

        const readers: ChildReader[] = [];
        // Observe exit first: either stream may already be locked by its creator.
        void child.exited.then(
          (exitCode) => this.#handleExit(child, generation, exitCode, readers),
          () => this.#handleExitFailure(child, generation),
        );
        this.#observeOutput(child.stdout, "stdout", generation, child.pid, readers);
        this.#observeOutput(child.stderr, "stderr", generation, child.pid, readers);
        return this.snapshot;
      })
      .catch(() => {
        if (generation === this.#generation && this.#child === null) {
          this.#snapshot = {
            status: "failed",
            code: "spawn_failed",
            stdoutBytes: 0,
            stderrBytes: 0,
          };
        }
        throw new NapCatRuntimeManagerError("spawn_failed");
      });

    let tracked: Promise<NapCatRuntimeSnapshot>;
    tracked = operation.finally(() => {
      if (this.#startPromise === tracked) this.#startPromise = null;
    });
    this.#startPromise = tracked;
    return tracked;
  }

  stop(input: { readonly deadlineMs: number }): Promise<NapCatRuntimeStopResult> {
    if (!this.#enabled) return Promise.resolve({ status: "disabled" });
    if (this.#stopPromise) return this.#stopPromise;
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 0) {
      return Promise.reject(new NapCatRuntimeManagerError("stop_failed"));
    }
    if (!this.#child && !this.#startPromise) return Promise.resolve({ status: "stopped" });

    let resolveBase!: StopResolution;
    const base = new Promise<NapCatRuntimeStopResult>((resolve) => {
      resolveBase = resolve;
    });
    let tracked: Promise<NapCatRuntimeStopResult>;
    tracked = base.finally(() => {
      if (this.#stopPromise === tracked) this.#stopPromise = null;
    });
    this.#stopPromise = tracked;

    const begin = () => this.#beginStop(input.deadlineMs, resolveBase);
    const startPromise = this.#startPromise;
    if (startPromise) {
      void startPromise.then(begin, () => resolveBase({ status: "failed", code: "spawn_failed" }));
    } else {
      begin();
    }
    return tracked;
  }

  #beginStop(deadlineMs: number, resolve: StopResolution): void {
    const child = this.#child;
    if (!child) {
      resolve({ status: "stopped" });
      return;
    }

    const generation = this.#generation;
    this.#snapshot = { ...this.#snapshot, status: "stopping", code: undefined };
    this.#activeStop = { child, generation, resolve };
    this.#stopTimer = setTimeout(() => {
      if (!this.#isActiveStop(child, generation)) return;
      this.#snapshot = {
        ...this.#snapshot,
        status: "failed",
        code: "stop_timeout",
      };
      this.#finishStop({ status: "failed", code: "stop_timeout" });
    }, deadlineMs);

    try {
      child.kill();
    } catch {
      if (!this.#isActiveStop(child, generation)) return;
      this.#snapshot = {
        ...this.#snapshot,
        status: "failed",
        code: "stop_failed",
      };
      this.#finishStop({ status: "failed", code: "stop_failed" });
    }
  }

  #observeOutput(
    stream: ReadableStream<Uint8Array> | null,
    kind: OutputKind,
    generation: number,
    pid: number,
    readers: ChildReader[],
  ): void {
    if (!stream) return;
    let reader: ChildReader;
    try {
      reader = stream.getReader();
    } catch {
      return;
    }
    readers.push(reader);
    void (async () => {
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          if (!result.value || generation !== this.#generation || this.#child?.pid !== pid)
            continue;
          const bytes = result.value.byteLength;
          if (bytes === 0) continue;
          const field = kind === "stdout" ? "stdoutBytes" : "stderrBytes";
          this.#snapshot = { ...this.#snapshot, [field]: this.#snapshot[field] + bytes };
          try {
            this.#onEvent?.({ type: `${kind}_bytes`, pid, bytes });
          } catch {
            // Consumer callbacks cannot change process ownership or state.
          }
        }
      } catch {
        // Stream content and stream errors are intentionally not retained.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // A cancelled stream may already have released its reader.
        }
      }
    })();
  }

  #handleExit(
    child: NapCatRuntimeChild,
    generation: number,
    exitCode: number,
    readers: ChildReader[],
  ): void {
    this.#cancelReaders(readers);
    if (this.#child !== child || this.#generation !== generation) return;
    this.#child = null;
    this.#snapshot = {
      status: "stopped",
      exitCode,
      stdoutBytes: this.#snapshot.stdoutBytes,
      stderrBytes: this.#snapshot.stderrBytes,
    };
    if (this.#isActiveStop(child, generation)) this.#finishStop({ status: "stopped" });
  }

  #handleExitFailure(child: NapCatRuntimeChild, generation: number): void {
    if (this.#child !== child || this.#generation !== generation) return;
    this.#snapshot = {
      ...this.#snapshot,
      status: "failed",
      code: "child_exit_unknown",
    };
    if (this.#isActiveStop(child, generation)) {
      this.#finishStop({ status: "failed", code: "child_exit_unknown" });
    }
  }

  #cancelReaders(readers: ChildReader[]): void {
    for (const reader of readers) {
      void reader.cancel().catch(() => {});
    }
  }

  #isActiveStop(child: NapCatRuntimeChild, generation: number): boolean {
    return this.#activeStop?.child === child && this.#activeStop.generation === generation;
  }

  #finishStop(result: NapCatRuntimeStopResult): void {
    const active = this.#activeStop;
    if (!active) return;
    this.#activeStop = null;
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    active.resolve(result);
  }
}
