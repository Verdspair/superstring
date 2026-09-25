import { Hono } from "hono";
import { ChatRequestSchema } from "../../shared/contracts";
import { WebChannel, type WebChannelOptions } from "../channels/web-channel";
import { encodeSse, SSE_HEADERS } from "./sse";
import { parseBody, readJsonBody } from "./validation";

/** v2 streams the persisted run event vocabulary plus legacy completed-turn replay. */
export function chatV2Routes(options: WebChannelOptions): Hono {
  const router = new Hono();
  const channel = new WebChannel(options);
  router.post("/v2/chat", async (c) => {
    const body = parseBody(ChatRequestSchema, await readJsonBody(c.req.raw));
    const abort = new AbortController();
    const reply = await channel.openReply({
      sessionId: body.session_id,
      message: body.message,
      clientRequestId: body.client_request_id,
      signal: abort.signal,
    });
    let cancelled = false,
      pump: Promise<void> | undefined;
    const disconnect = () => {
      cancelled = true;
      abort.abort();
    };
    c.req.raw.signal.addEventListener("abort", disconnect, { once: true });
    if (c.req.raw.signal.aborted) disconnect();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pump = (async () => {
          try {
            for await (const event of reply) {
              if (!cancelled)
                controller.enqueue(new TextEncoder().encode(encodeSse(event.type, event)));
              if (["completed", "no_output", "failed", "cancelled", "replay"].includes(event.type))
                break;
            }
          } catch (error) {
            // A crash without a durable terminal is an incomplete stream; the client reconciles
            // through by-request run lookup. Inventing a seq/event would corrupt that history.
            if (!cancelled) {
              controller.error(error);
              cancelled = true;
            }
          } finally {
            c.req.raw.signal.removeEventListener("abort", disconnect);
            if (!cancelled) controller.close();
          }
        })();
      },
      async cancel() {
        disconnect();
        await pump;
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  });
  return router;
}
