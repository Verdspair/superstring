import { expect, it } from "bun:test";
import http from "node:http";
import { createModelPort } from "../../src/server/agent/model-port";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

it("reports the model actually requested after fallback for completion and streaming", async () => {
  const received: string[] = [];
  const reported: string[] = [];
  let finishReason = "stop";
  const server = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "loaded-model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push(body.model);
    // Resolution is reported before the request reaches the provider.
    expect(reported.at(-1)).toBe(body.model);
    if (body.stream) {
      response.setHeader("content-type", "text/event-stream");
      response.end('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n');
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: finishReason, message: { content: "answer" } }],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const port = createModelPort({
      gateway: createLmStudioClient({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "configured-but-unloaded",
        timeoutSeconds: 5,
      }),
    });
    const request = {
      messages: [{ role: "user" as const, content: [{ kind: "text" as const, text: "hello" }] }],
      onModelResolved: (model: string) => reported.push(model),
    };
    expect(await port.complete(request)).toBe("answer");
    let streamed = "";
    for await (const text of port.streamText(request)) streamed += text;
    expect(streamed).toBe("answer");
    expect(received).toEqual(["loaded-model", "loaded-model"]);
    expect(reported).toEqual(received);
    expect(port.defaultModel).toBe("configured-but-unloaded");

    // A diagnostic sink failure must not turn a valid inference into a failed run.
    expect(
      await port.complete({
        ...request,
        onModelResolved: () => {
          throw new Error("fixture diagnostic unavailable");
        },
      }),
    ).toBe("answer");
    expect(received).toHaveLength(3);
    for (const [reason, code] of [
      ["length", "MODEL_OUTPUT_LIMIT"],
      ["content_filter", "MODEL_FINISH_UNSUPPORTED"],
    ]) {
      finishReason = reason;
      const captured: { text: string; complete: boolean }[] = [];
      await expect(
        port.complete({
          ...request,
          onResponseText: (text, complete) => captured.push({ text, complete }),
        }),
      ).rejects.toMatchObject({ code });
      expect(captured).toEqual([{ text: "answer", complete: false }]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
