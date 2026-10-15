// SSE wire-contract test parser: mirrors the exact framing produced by
// production encodeSse (src/server/api/sse.ts). Test-side only.

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
