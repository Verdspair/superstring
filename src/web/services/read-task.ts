import { Effect, Fiber } from "effect";

export interface ReadTask {
  cancel(): void;
}

/** Owns one read, including adapters that resolve after abort. Never caches the result. */
export function startRead<A>(
  request: (signal: AbortSignal) => Promise<A>,
  callbacks: {
    success(value: A): void;
    failure(cause: unknown): void;
    settled?(): void;
  },
): ReadTask {
  const controller = new AbortController();
  const read = Effect.tryPromise({
    try: (signal) => {
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      return request(controller.signal).finally(() => signal.removeEventListener("abort", abort));
    },
    catch: (cause) => cause,
  });
  const fiber = Effect.runFork(
    Effect.ensuring(
      Effect.match(read, {
        onSuccess: (value) => {
          if (!controller.signal.aborted) callbacks.success(value);
        },
        onFailure: (cause) => {
          if (!controller.signal.aborted) callbacks.failure(cause);
        },
      }),
      Effect.sync(() => {
        if (!controller.signal.aborted) callbacks.settled?.();
      }),
    ),
  );
  return {
    cancel() {
      // Synchronous transport abort plus fiber interruption: late adapters cannot publish.
      controller.abort();
      Effect.runFork(Fiber.interrupt(fiber));
    },
  };
}

/** The caller decides eligibility (foreground, paused, pending); disposal stops the clock. */
export function startReadPolling(tick: () => void, intervalMs: number): ReadTask {
  const fiber = Effect.runFork(
    Effect.forever(Effect.zipRight(Effect.sleep(intervalMs), Effect.sync(tick))),
  );
  return {
    cancel: () => {
      Effect.runFork(Fiber.interrupt(fiber));
    },
  };
}
