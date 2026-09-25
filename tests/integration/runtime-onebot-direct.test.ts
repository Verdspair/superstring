import { expect, it } from "bun:test";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { createSession, DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createRuntime } from "../../src/server/runtime";
import type { QqIntakeRuntime } from "../../src/server/services/qq-intake";

it("production composition shares Web/Bot Agent runtime and dispatches private input exactly once", async () => {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "fixture");
  let target = "reply";
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
    async listModels() {
      return ["fixture"];
    },
    async loadedContextCapacity() {
      return 65536;
    },
    async probeModelLoaded() {
      return true;
    },
    async complete() {
      return JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: target, instructions: "answer" }],
      });
    },
    async *streamChat() {
      yield "first\nsecond";
    },
  };
  const sends: unknown[] = [];
  const intake = {
    state: { phase: "ready" },
    connection: {
      async send(request: unknown) {
        sends.push(request);
        return { kind: "confirmed", messageId: String(sends.length) };
      },
    },
    async start() {},
    stop() {},
  } as unknown as QqIntakeRuntime;
  const runtime = createRuntime({
    business,
    gateway,
    qqIntake: intake,
    browserStateSecret: "synthetic-composition-secret",
  });
  try {
    const session = createSession(business.orm, "Web", { modelName: "fixture" });
    const web = await runtime.app.request("/v2/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        message: "hello",
        client_request_id: "web-request",
      }),
    });
    expect(await web.text()).toContain("event: completed");
    target = "20002";
    updateQqSettings(business.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const scheme = createQqScheme(business.orm, {
      name: "private",
      reply: { split_by_speaker: false },
      triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
    });
    const now = new Date().toISOString(),
      nowSeconds = Math.floor(Date.now() / 1000);
    business.orm
      .insert(schema.qqBindings)
      .values({
        id: crypto.randomUUID(),
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    business.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: "private-1",
        accountId: "10001",
        conversationKind: "private",
        peerId: "20002",
        agentId: DEFAULT_AGENT_ID,
        messageId: "1",
        occurredAtSeconds: nowSeconds,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
        addressed: 1,
      })
      .run();
    business.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: "private-1",
        body: "private hello",
        occurredAtSeconds: nowSeconds,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        recordedAt: now,
      })
      .run();
    await runtime.qqRuntime.runCycle();
    expect(sends).toHaveLength(2);
    expect(business.db.query("SELECT status FROM outbound_intents").all()).toEqual([
      { status: "confirmed" },
    ]);
    expect(
      business.db
        .query(
          "SELECT spec_id,status FROM agent_runs WHERE spec_id IN('conversation.web','onebot.private.main') ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { spec_id: "conversation.web", status: "completed" },
      { spec_id: "onebot.private.main", status: "completed" },
    ]);
    await runtime.qqRuntime.runCycle();
    expect(sends).toHaveLength(2);
  } finally {
    await runtime.stop();
  }
});
