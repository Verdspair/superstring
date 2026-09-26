import { Hono } from "hono";
import { ChatRequestSchema } from "../../shared/contracts";
import { WebChannel, type WebChannelOptions } from "../channels/web-channel";
import { createSseResponse } from "./sse";
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
    return createSseResponse(
      { requestSignal: c.req.raw.signal, onDisconnect: () => abort.abort() },
      async (stream) => {
        for await (const event of reply) {
          stream.send(event.type, event);
          if (["completed", "no_output", "failed", "cancelled", "replay"].includes(event.type))
            break;
        }
      },
    );
  });
  return router;
}
