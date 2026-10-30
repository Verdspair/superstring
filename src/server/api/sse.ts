// SSE frame encoding
// The exact bytes matter to the browser's EventSource parser, so three details
// are preserved:
// 1. Non-ASCII text is emitted as UTF-8, not \uXXXX.
// 2. Compact JSON: no spaces after `:` or `,`.
// 3. Frame layout is `event: <name>\ndata: <json>\n\n` — a blank line ends it.

export function encodeSse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Headers set on the streaming response. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

/** Transport traffic, independent of run events and model/request deadlines. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export interface SseWriter {
  readonly cancelled: boolean;
  send(event: string, data: Record<string, unknown>): Promise<void>;
  readonly writable: boolean;
  trySendBatch(frames: readonly { event: string; data: Record<string, unknown> }[]): boolean;
}

/**
 * Own the HTTP stream lifecycle once for both event contracts. Comment frames keep
 * a quiet model request alive without inventing a business event or sequence.
 * Preparation errors still belong before this function opens the response.
 */
export function createSseResponse(
  options: {
    requestSignal: AbortSignal;
    onDisconnect: () => void;
    keepaliveIntervalMs?: number;
    onWritable?: () => void;
  },
  produce: (writer: SseWriter) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const keepalive = encoder.encode(": keepalive\n\n");
  let cancelled = false;
  let readerCancelled = false;
  let finished = false;
  let errored = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pump: Promise<void> | undefined;
  let resume: (() => void) | undefined;
  let sending = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    options.requestSignal.removeEventListener("abort", disconnect);
  };
  const disconnect = () => {
    if (cancelled) return;
    cancelled = true;
    resume?.();
    resume = undefined;
    cleanup();
    options.onDisconnect();
  };
  options.requestSignal.addEventListener("abort", disconnect, { once: true });
  if (options.requestSignal.aborted) disconnect();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      const send = async (event: string, data: Record<string, unknown>) => {
        if (cancelled || finished) return;
        if (sending) throw new Error("SSE business sends must be awaited sequentially");
        sending = true;
        try {
          while (!cancelled && (controller.desiredSize ?? 0) <= 0)
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          if (!cancelled && !finished) controller.enqueue(encoder.encode(encodeSse(event, data)));
        } finally {
          sending = false;
        }
      };
      if (!cancelled)
        timer = setInterval(() => {
          if (!cancelled && !finished && !sending && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(keepalive);
        }, options.keepaliveIntervalMs ?? SSE_KEEPALIVE_INTERVAL_MS);
      // Returning immediately lets reader.cancel interrupt an awaiting producer.
      pump = (async () => {
        try {
          await produce({
            get cancelled() {
              return cancelled;
            },
            send,
            get writable() {
              return !cancelled && !finished && !sending && (controller.desiredSize ?? 0) > 0;
            },
            trySendBatch(frames) {
              if (cancelled || finished || sending || (controller.desiredSize ?? 0) <= 0)
                return false;
              if (frames.length)
                controller.enqueue(
                  encoder.encode(
                    frames.map((frame) => encodeSse(frame.event, frame.data)).join(""),
                  ),
                );
              return true;
            },
          });
        } catch (error) {
          // The route owns business error events. An unhandled producer failure
          // remains an incomplete stream for the client's existing reconciliation.
          if (!cancelled) {
            errored = true;
            controller.error(error);
          }
        } finally {
          finished = true;
          cleanup();
          if (!readerCancelled && !errored) controller.close();
        }
      })();
    },
    pull() {
      const ready = resume;
      resume = undefined;
      ready?.();
      if (!cancelled && !finished && (streamController?.desiredSize ?? 0) > 0)
        options.onWritable?.();
    },
    async cancel() {
      readerCancelled = true;
      disconnect();
      await pump;
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
