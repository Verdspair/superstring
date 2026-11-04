import { afterEach, expect, it } from "bun:test";
import http, { type Server } from "node:http";
import { eq } from "drizzle-orm";
import { createModelPort } from "../../src/server/agent/model-port";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { readQqBinding, saveQqBinding } from "../../src/server/db/qq-binding-repository";
import * as schema from "../../src/server/db/schema";
import { type ChatMessage, createLmStudioClient } from "../../src/server/llm/model-gateway";
import { createAgent } from "../../src/server/services/agent-service";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { updateQqBinding } from "../../src/server/services/qq-binding-contract";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

interface WireBody {
  messages: ChatMessage[];
  response_format?: { json_schema?: { schema?: Record<string, unknown> } };
}
interface Observation {
  name: string;
  value: {
    status?: string;
    mediaId?: string;
    items?: { id: string; eventKey: string }[];
    images?: { sourceId: string; sha256: string }[];
  };
}

function observations(body: WireBody, name: string): Observation[] {
  return body.messages.flatMap((message) => {
    const texts =
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    return texts.flatMap((text) => {
      try {
        const parsed = JSON.parse(text) as { kind?: string; value?: Observation };
        return parsed.kind === "action_observation" && parsed.value?.name === name
          ? [parsed.value]
          : [];
      } catch {
        return [];
      }
    });
  });
}

function imageUrls(body: WireBody): string[] {
  return body.messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) => (part.type === "image_url" ? [part.image_url.url] : [])),
  );
}

function decisionReply(body: WireBody, decision: Record<string, unknown>): string {
  const properties = body.response_format?.json_schema?.schema?.properties;
  const envelope =
    properties !== null && typeof properties === "object" && "decision" in properties;
  return JSON.stringify(envelope ? { decision, media: [] } : decision);
}

async function captureGateway(reply: (body: WireBody, index: number) => string) {
  const bodies: WireBody[] = [];
  const failures: string[] = [];
  const server: Server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "reply-model" }] }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [
            {
              type: "llm",
              key: "reply-model",
              loaded_instances: [{ id: "reply-model", config: { context_length: 65536 } }],
            },
          ],
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      failures.push(`Unexpected request: ${request.method} ${request.url}`);
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(raw) as WireBody;
        bodies.push(body);
        const content = reply(body, bodies.length - 1);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }),
        );
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const gateway = createLmStudioClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "reply-model",
    apiKey: "synthetic-only",
    timeoutSeconds: 5,
  });
  return {
    gateway,
    bodies,
    failures,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

for (const scenario of ["expiry", "binding-authority"] as const) {
  it(`rejects ${scenario} revoked after a successful explicit image read`, async () => {
    const bytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    let disclosedId: string | undefined;
    let triggered = 0;
    const capture = await captureGateway((body, index) => {
      if (index === 0)
        return decisionReply(body, {
          kind: "invoke",
          calls: [{ name: "media.list", arguments: {} }],
        });
      if (index === 1) {
        const listed = observations(body, "media.list").at(-1)?.value;
        if (listed?.status !== "ok" || listed.items?.length !== 1)
          throw new Error("Expected one real listed image");
        disclosedId = listed.items[0]?.id;
        if (!disclosedId) throw new Error("Missing disclosed image id");
        return decisionReply(body, {
          kind: "invoke",
          calls: [{ name: "media.read", arguments: { id: disclosedId } }],
        });
      }
      throw new Error(`Unexpected model request ${index + 1}`);
    });
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaEnabled: true,
      mediaInput: { mode: "native" },
      messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
      imageBytes: { "deep-image": bytes },
      model: createModelPort({ gateway: capture.gateway }),
      actualGateway: capture.gateway,
    });
    const originalRead = BotContextSource.prototype.read;
    try {
      BotContextSource.prototype.read = function (input) {
        const successfulRead = input.observations.find(
          (observation) =>
            observation.name === "media.read" &&
            observation.value !== null &&
            typeof observation.value === "object" &&
            (observation.value as { status?: unknown }).status === "ok",
        );
        if (successfulRead && triggered === 0) {
          triggered++;
          const value = successfulRead.value as { mediaId?: string };
          expect(value.mediaId).toBe(disclosedId);
          if (!disclosedId) throw new Error("Missing source to revoke");
          if (scenario === "expiry") {
            h.orm
              .update(schema.qqMediaNotes)
              .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
              .where(eq(schema.qqMediaNotes.id, disclosedId))
              .run();
          } else {
            const binding = readQqBinding(h.orm, h.bindingId);
            if (!binding) throw new Error("Missing synthetic binding");
            const agent = createAgent(
              h.orm,
              { name: "Other synthetic agent", model_name: "reply-model" },
              {
                core_identity: "",
                communication_style: "",
                interaction_boundaries: "",
                example_dialogues: "",
                advanced_instructions: "",
              },
            );
            const changed = updateQqBinding(binding, { agentId: agent.id }, binding.revision);
            if (changed.kind !== "saved") throw new Error("Synthetic rebind rejected");
            const saved = saveQqBinding(h.orm, {
              binding: changed.binding,
              expectedRevision: binding.revision,
            });
            expect(saved.authorityRevision).toBe(binding.authorityRevision + 1);
            expect(saved.revision).toBe(binding.revision + 1);
          }
        }
        return originalRead.call(this, input);
      };
      h.receive({ id: "-101", speaker: "20002", text: "A image", image: "deep-image" });
      h.advance(1);
      h.receive({ id: "-102", speaker: "20003", text: "B replies A", replyTo: "-101" });
      h.advance(1);
      h.receive({
        id: "-103",
        speaker: "20004",
        text: "C asks about A",
        replyTo: "-102",
        addressed: true,
      });
      const activation = h.activate("direct_reply");
      let activationError: unknown;
      try {
        await activation;
      } catch (error) {
        activationError = error;
      }
      if (scenario === "expiry") {
        expect(activationError).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      } else {
        expect(activationError).toMatchObject({ message: "binding_changed" });
      }
      expect(triggered).toBe(1);
      expect(capture.failures).toEqual([]);
      expect(capture.bodies).toHaveLength(2);
      expect(capture.bodies.flatMap(imageUrls)).toEqual([]);
      expect(h.sent).toHaveLength(0);
    } finally {
      BotContextSource.prototype.read = originalRead;
      h.close();
      await capture.close();
    }
  });
}
