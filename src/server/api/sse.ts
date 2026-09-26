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
  send(event: string, data: Record<string, unknown>): void;
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
  const cleanup = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    options.requestSignal.removeEventListener("abort", disconnect);
  };
  const disconnect = () => {
    if (cancelled) return;
    cancelled = true;
    cleanup();
    options.onDisconnect();
  };
  options.requestSignal.addEventListener("abort", disconnect, { once: true });
  if (options.requestSignal.aborted) disconnect();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (bytes: Uint8Array) => {
        if (!cancelled && !finished) controller.enqueue(bytes);
      };
      if (!cancelled)
        timer = setInterval(
          () => write(keepalive),
          options.keepaliveIntervalMs ?? SSE_KEEPALIVE_INTERVAL_MS,
        );
      // Returning immediately lets reader.cancel interrupt an awaiting producer.
      pump = (async () => {
        try {
          await produce({
            get cancelled() {
              return cancelled;
            },
            send: (event, data) => write(encoder.encode(encodeSse(event, data))),
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
    async cancel() {
      readerCancelled = true;
      disconnect();
      await pump;
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

export interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Parse a concatenated SSE payload back into `{event, data}` pairs. Used by the
 * tests to assert the wire contract; the server never needs to parse its own
 * output.
 */
export function parseSseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim();
    if (trimmed === "") continue;
    let event = "";
    let dataLine = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (event === "" && dataLine === "") continue;
    frames.push({ event, data: dataLine === "" ? null : JSON.parse(dataLine) });
  }
  return frames;
}
