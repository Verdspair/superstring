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
