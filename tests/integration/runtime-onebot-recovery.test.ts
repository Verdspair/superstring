import { afterEach, expect, it } from "bun:test";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createRuntime, type SuperstringRuntime } from "../../src/server/runtime";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { type QqIntakeRuntime, recordInbound } from "../../src/server/services/qq-intake";

const runtimes: SuperstringRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});
const bindingId = "11111111-1111-4111-8111-111111111111";
function setup(kind: "group" | "private") {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "fixture");
  updateQqSettings(business.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(business.orm, {
    name: "recovery",
    reply: { split_by_speaker: true },
    triggers: { direct_reply: true, follow_up: true, chiming_in: false, idle_topic: false },
  });
  const peerId = kind === "group" ? "30003" : "20002",
    at = new Date().toISOString(),
    seconds = Math.floor(Date.now() / 1000);
  business.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001',?,?,?,?,?,?)",
    )
    .run(bindingId, kind, peerId, DEFAULT_AGENT_ID, scheme.id, at, at);
  const sends: unknown[] = [];
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
    listModels: async () => ["fixture"],
    loadedContextCapacity: async () => 65536,
    probeModelLoaded: async () => true,
    complete: async () =>
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "20002", instructions: "answer" }],
      }),
    async *streamChat() {
      yield "reply";
    },
  };
  const intake = {
    state: { phase: "ready" },
    connection: {
      async send(request: unknown) {
        sends.push(request);
        return { kind: "confirmed", messageId: String(sends.length) };
      },
    },
    start: async () => {},
    stop() {},
  } as unknown as QqIntakeRuntime;
  const runtime = createRuntime({
    business,
    gateway,
    qqIntake: intake,
    browserStateSecret: "synthetic-recovery-fixture",
  });
  runtimes.push(runtime);
  const journal = new ConversationEventRepository(business.db),
    wakes = new WakeRepository(business.db),
    outbox = new OutboundIntentRepository(business.db);
  const adapter = new OneBot11Adapter({ orm: business.orm, journal, wakes });
  function receive(id: string, speaker: string, age: number, addressed = true) {
    recordInbound(
      business.orm,
      normalizeOneBotMessage(
        {
          time: seconds - age,
          self_id: 10001,
          post_type: "message",
          message_type: kind,
          sub_type: kind === "group" ? "normal" : "friend",
          message_id: id,
          user_id: Number(speaker),
          ...(kind === "group" ? { group_id: Number(peerId) } : {}),
          message: [
            ...(addressed && kind === "group" ? [{ type: "at", data: { qq: "10001" } }] : []),
            { type: "text", data: { text: `question ${id}` } },
          ],
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
    return (
      business.db.query("SELECT event_key FROM qq_events WHERE message_id=?").get(id) as {
        event_key: string;
      }
    ).event_key;
  }
  async function staleIntent() {
    const c = journal.ensureOneBot(bindingId)!;
    await runtime.agentRuntime.completeLeaf(
      { id: "fixture.old-output" },
      {
        owner: { kind: "conversation", id: c.id, agentId: DEFAULT_AGENT_ID },
        messages: [{ role: "user", content: "synthetic old output" }],
      },
    );
    const run = (
      business.db
        .query("SELECT run_id FROM agent_runs WHERE spec_id='fixture.old-output'")
        .get() as { run_id: string }
    ).run_id;
    const intent = outbox.commit({
      runId: run,
      conversationId: c.id,
      ordinal: 0,
      target: {
        accountId: "10001",
        conversationKind: kind,
        peerId,
        participantId: kind === "group" ? "20002" : undefined,
        agentId: DEFAULT_AGENT_ID,
        bindingId,
        bindingEpoch: c.bindingEpoch,
      },
      speechKind: "direct_reply",
      sourceThroughSeq: journal.sourceThroughSeq(c.id),
      deliverBy: new Date(Date.now() - 10000).toISOString(),
      createdAt: new Date(Date.now() - 900000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      parts: [{ kind: "text", text: "obsolete planned draft" }],
    });
    // The old run consumed its ingress opportunity; only stale-plan recovery is under test.
    business.db.exec("UPDATE wake_signals SET status='no_output'");
    return intent;
  }
  return { ...business, runtime, journal, wakes, outbox, receive, staleIntent, sends };
}
it.each([false, true])(
  "stale recovery keeps the original input age, even with fresh media revision=%s",
  async (media) => {
    const h = setup("private"),
      eventKey = h.receive("1", "20002", 900);
    if (media) {
      const at = new Date().toISOString();
      h.db
        .query(
          "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES('media',?,0,'image','synthetic','late description','fixture',1,?,?,?)",
        )
        .run(eventKey, new Date(Date.now() + 86400000).toISOString(), at, at);
      h.journal.ingestMedia("media", bindingId);
    }
    const old = await h.staleIntent();
    await h.runtime.botWorker.runCycle();
    expect(h.sends).toEqual([]);
    expect(h.outbox.get(old.id)?.status).toBe("stale");
    expect(h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").all()).toEqual(
      [],
    );
    const wake = h.db
      .query("SELECT through_seq FROM wake_signals WHERE dedupe_key=?")
      .get(`stale:${old.id}`) as { through_seq: number };
    const focus = h.journal.eventsAfter(old.conversationId, wake.through_seq - 1, 1).items[0]!;
    expect(focus.kind).toBe(media ? "media_revision" : "inbound");
  },
);
it("stale group recovery keeps the original recipient despite newer unrelated member input", async () => {
  const h = setup("group"),
    original = h.receive("1", "20002", 20);
  h.receive("2", "20003", 10, false);
  const old = await h.staleIntent();
  await h.runtime.botWorker.runCycle();
  expect(h.sends).toHaveLength(1);
  expect(h.sends[0]).toMatchObject({
    message: [
      { type: "at", data: { qq: "20002" } },
      { type: "text", data: { text: "reply" } },
    ],
  });
  const wake = h.db
    .query("SELECT through_seq FROM wake_signals WHERE dedupe_key=?")
    .get(`stale:${old.id}`) as { through_seq: number };
  expect(
    h.journal.eventsAfter(old.conversationId, wake.through_seq - 1, 1).items[0]?.source.id,
  ).toBe(original);
});
