// Turning an upstream reference into bytes (ADR0018 P5j, §7.1's 取流).
//
// The connection asks the bot side for a source (`resolveMediaSource`); what comes back is a
// reference, and NapCat's references come in more than one shape: a local path to a file it
// already cached, or a data URL when it had to convert the media. Both are handled here, and a
// plain http(s) URL as well, because those are the three things the OneBot 11 side is documented
// to hand back. Which one arrived is not the model's problem — this module's only job is bytes.
//
// Nothing here decides a format: the adapter sniffs the container from the bytes, exactly as the
// sticker import does, so a `.jpg` holding a PNG is read as what it is.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { OneBotMediaSourceResult } from "./onebot-connection";
import type { QqMediaSourceFetcher } from "./qq-media-adapter";

const DataUrlSchema = z.string().regex(/^data:[^;,]+;base64,/);

/** `fetchImpl` is injected so a URL reference can be exercised without a network. */
export function createQqMediaSourceFetcher(input: {
  readonly resolveSource: (request: {
    readonly kind: "image" | "record" | "video";
    readonly sourceRef: string;
  }) => Promise<OneBotMediaSourceResult>;
  readonly fetchImpl?: typeof fetch;
}): QqMediaSourceFetcher {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async ({ kind, sourceRef }) => {
    const resolved = await input.resolveSource({ kind, sourceRef });
    if (resolved.kind !== "source") {
      throw new Error(`QQ media source unavailable: ${resolved.reason}`);
    }
    const reference = resolved.reference;
    if (DataUrlSchema.safeParse(reference).success) {
      const comma = reference.indexOf(",");
      return { bytes: new Uint8Array(Buffer.from(reference.slice(comma + 1), "base64")) };
    }
    if (/^https?:\/\//i.test(reference)) {
      const response = await fetchImpl(reference);
      if (!response.ok) throw new Error(`QQ media source fetch failed: ${response.status}`);
      return { bytes: new Uint8Array(await response.arrayBuffer()) };
    }
    // Anything else is the bot side's own file: NapCat hands back a path on this machine.
    return { bytes: new Uint8Array(readFileSync(reference)) };
  };
}
