import { afterEach, expect, it } from "bun:test";
import http, { type Server } from "node:http";
import { eq } from "drizzle-orm";
import { createModelPort } from "../../src/server/agent/model-port";
import * as schema from "../../src/server/db/schema";
import { type ChatMessage, createLmStudioClient } from "../../src/server/llm/model-gateway";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
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

for (const scenario of ["deep", "outside-window"] as const) {
  it(`${scenario} ordinary media.read supplies A's image to the actual next gateway request`, async () => {
    const bytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    let disclosedId: string | undefined;
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
      if (index === 2) return decisionReply(body, { kind: "none" });
      throw new Error(`Unexpected model request ${index + 1}`);
    });
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaEnabled: true,
      mediaInput: { mode: "native" },
      ...(scenario === "deep"
        ? { messageSettings: { reply_mode: "configured_depth" as const, reply_depth: 2 } }
        : {}),
      imageBytes: { "deep-a-image": bytes },
      model: createModelPort({ gateway: capture.gateway }),
      actualGateway: capture.gateway,
    });
    try {
      if (scenario === "outside-window") {
        h.db
          .query(
            "UPDATE agents SET p5_config = json_set(p5_config, '$.recent_turns', 1) WHERE id = (SELECT agent_id FROM qq_bindings WHERE id = ?)",
          )
          .run(h.bindingId);
      }
      expect(
        h.receive({ id: "-101", speaker: "20002", text: "A image", image: "deep-a-image" }),
      ).toMatchObject({ kind: "recorded", recorded: true });
      h.advance(1);
      expect(
        h.receive({
          id: "-102",
          speaker: "20003",
          text: "B replies A",
          ...(scenario === "deep" ? { replyTo: "-101" } : {}),
        }),
      ).toMatchObject({ kind: "recorded", recorded: true });
      h.advance(1);
      expect(
        h.receive({
          id: "-103",
          speaker: "20004",
          text: "C asks about A",
          ...(scenario === "deep" ? { replyTo: "-102" } : {}),
          addressed: true,
        }),
      ).toMatchObject({ kind: "recorded", recorded: true });
      expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
      expect(capture.failures).toEqual([]);
      expect(capture.bodies).toHaveLength(3);
      const [initial, listed, next] = capture.bodies;
      if (!initial || !listed || !next) throw new Error("Missing gateway requests");
      // The depth-2 image is not automatic. The tool must change the next actual input.
      expect(imageUrls(initial)).toEqual([]);
      expect(imageUrls(listed)).toEqual([]);
      const read = observations(next, "media.read").at(-1)?.value;
      expect(read).toMatchObject({
        status: "ok",
        mediaId: disclosedId,
        images: [
          {
            sourceId: expect.any(String),
            sha256: expect.any(String),
          },
        ],
      });
      expect(h.sent).toHaveLength(0);
      // Do not replace this with prepared metadata, a mock answer, or an expected failure.
      expect(imageUrls(next)).toEqual([
        `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      ]);
    } finally {
      h.close();
      await capture.close();
    }
  });
}

function labeledImages(body: WireBody): { url: string; label: string }[] {
  return body.messages.flatMap((message) => {
    if (typeof message.content === "string") return [];
    const parts = message.content;
    return parts.flatMap((part, index) => {
      if (part.type !== "image_url") return [];
      const previous = parts[index - 1];
      return [{ url: part.image_url.url, label: previous?.type === "text" ? previous.text : "" }];
    });
  });
}

it("focus reads preserve two distinct image bytes and adjacent source identities on the wire", async () => {
  const first = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const second = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(128), 8, 8);
  let ids: string[] = [];
  const capture = await captureGateway((body, index) => {
    if (index === 0)
      return decisionReply(body, {
        kind: "invoke",
        calls: [{ name: "media.list", arguments: {} }],
      });
    if (index === 1) {
      const items = observations(body, "media.list").at(-1)?.value.items;
      if (!items || items.length !== 2) throw new Error("Expected two listed images");
      ids = items.map((item) => item.id);
      return decisionReply(body, {
        kind: "invoke",
        calls: ids.map((id) => ({
          name: "media.read",
          arguments: { id },
        })),
      });
    }
    if (index === 2) return decisionReply(body, { kind: "none" });
    throw new Error(`Unexpected model request ${index + 1}`);
  });
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mergeWindowSeconds: 0,
    mediaEnabled: true,
    mediaInput: { mode: "native" },
    imageBytes: { "focus-a": first, "focus-b": second },
    model: createModelPort({ gateway: capture.gateway }),
    actualGateway: capture.gateway,
  });
  try {
    h.receive({ id: "-201", speaker: "20002", image: "focus-a" });
    h.advance(1);
    h.receive({ id: "-202", speaker: "20003", image: "focus-b", addressed: true });
    expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
    expect(capture.failures).toEqual([]);
    expect(capture.bodies).toHaveLength(3);
    const next = capture.bodies[2];
    if (!next) throw new Error("Missing gateway request");
    const reads = observations(next, "media.read");
    expect(reads).toHaveLength(2);
    expect(reads.map((read) => read.value.mediaId)).toEqual(ids);
    expect(reads.map((read) => read.value.status)).toEqual(["ok", "ok"]);
    const rows = h.orm.select().from(schema.qqMediaNotes).all();
    const events = h.orm.select().from(schema.qqEvents).all();
    const expected = ids.map((id) => {
      const row = rows.find((item) => item.id === id);
      const event = events.find((item) => item.eventKey === row?.eventKey);
      if (!row || !event) throw new Error("Missing image source identity");
      const bytes = event.messageId === "-201" ? first : event.messageId === "-202" ? second : null;
      if (!bytes) throw new Error("Unexpected image message");
      return {
        id,
        messageId: event.eventKey,
        url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      };
    });
    const wire = labeledImages(next).filter((image) =>
      expected.some((item) => item.url === image.url),
    );
    expect(wire.map((image) => image.url)).toEqual(expected.map((item) => item.url));
    wire.forEach((image, index) => {
      const label = JSON.parse(image.label) as { mediaId?: string; messageIds?: string[] };
      expect(label.mediaId).toBe(expected[index]!.id);
      expect(label.messageIds).toContain(expected[index]!.messageId);
    });
    expect(h.sent).toHaveLength(0);
  } finally {
    h.close();
    await capture.close();
  }
});

for (const scenario of ["undisclosed", "expired"] as const) {
  it(`does not send an ${scenario} source as an image after media.read`, async () => {
    const bytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(77), 8, 8);
    let requestedId: string | undefined;
    const capture = await captureGateway((body, index) => {
      if (index === 0)
        return decisionReply(body, {
          kind: "invoke",
          calls: [{ name: "media.list", arguments: { limit: 1 } }],
        });
      if (index === 1) {
        const items = observations(body, "media.list").at(-1)?.value.items;
        if (!items || items.length !== 1) throw new Error("Expected one disclosed image");
        const rows = h.orm.select().from(schema.qqMediaNotes).all();
        requestedId =
          scenario === "expired" ? items[0]!.id : rows.find((row) => row.id !== items[0]!.id)?.id;
        if (!requestedId) throw new Error("Missing source for negative control");
        if (scenario === "expired")
          h.orm
            .update(schema.qqMediaNotes)
            .set({ expiresAt: "2000-01-01T00:00:00.000Z" })
            .where(eq(schema.qqMediaNotes.id, requestedId))
            .run();
        return decisionReply(body, {
          kind: "invoke",
          calls: [{ name: "media.read", arguments: { id: requestedId } }],
        });
      }
      if (index === 2) return decisionReply(body, { kind: "none" });
      throw new Error(`Unexpected model request ${index + 1}`);
    });
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaEnabled: true,
      mediaInput: { mode: "native" },
      messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
      imageBytes: { "negative-a": bytes, "negative-b": bytes },
      model: createModelPort({ gateway: capture.gateway }),
      actualGateway: capture.gateway,
    });
    try {
      h.receive({ id: "-300", speaker: "20002", image: "negative-b" });
      h.advance(1);
      h.receive({ id: "-301", speaker: "20002", image: "negative-a" });
      h.advance(1);
      h.receive({ id: "-302", speaker: "20003", replyTo: "-301" });
      h.advance(1);
      h.receive({ id: "-303", speaker: "20004", replyTo: "-302", addressed: true });
      expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
      expect(capture.failures).toEqual([]);
      expect(capture.bodies).toHaveLength(3);
      const next = capture.bodies[2];
      if (!next) throw new Error("Missing gateway request");
      const read = observations(next, "media.read").at(-1);
      expect(read).toBeDefined();
      expect(read?.value.status).not.toBe("ok");
      expect(imageUrls(next)).toEqual([]);
      expect(h.sent).toHaveLength(0);
    } finally {
      h.close();
      await capture.close();
    }
  });
}

it("decision stage disabled excludes automatic image from the actual gateway request", async () => {
  const bytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(88), 8, 8);
  const capture = await captureGateway((body, index) => {
    if (index === 0) return decisionReply(body, { kind: "none" });
    throw new Error(`Unexpected model request ${index + 1}`);
  });
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mergeWindowSeconds: 0,
    mediaEnabled: true,
    mediaInput: { mode: "native", stages: { decision: false } },
    imageBytes: { "stage-disabled": bytes },
    model: createModelPort({ gateway: capture.gateway }),
    actualGateway: capture.gateway,
  });
  try {
    h.receive({ id: "-401", speaker: "20002", image: "stage-disabled", addressed: true });
    expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
    expect(capture.failures).toEqual([]);
    expect(capture.bodies).toHaveLength(1);
    expect(imageUrls(capture.bodies[0]!)).toEqual([]);
    expect(h.sent).toHaveLength(0);
  } finally {
    h.close();
    await capture.close();
  }
});
