import { afterEach, describe, expect, it } from "bun:test";
import {
  batchScore,
  decideGenerate,
  decideInline,
  decideInvoke,
  say,
  scriptedModel,
} from "../harness/model";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);
const badReply = (mentionId: string, quote?: string) =>
  decideInvoke("reply.text", {
    outputs: [
      {
        kind: "inline",
        targetId: "20002",
        text: "rejected draft",
        mentionIds: [mentionId],
        ...(quote ? { replyToMessageId: quote } : {}),
      },
    ],
  });
const correctedReply = () =>
  decideInline("20002", "explicit correction", undefined, undefined, ["20002"]);

describe("QQ mention selection feedback boundaries", () => {
  it("rejects the whole quoted draft and requires an explicit corrected terminal reply", async () => {
    const h = createOneBotHarness({
      model: [
        badReply("99999", "401"),
        decideInvoke("reply.text", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "explicit correction",
              replyToMessageId: "401",
              mentionIds: ["20002"],
            },
          ],
        }),
      ],
    });
    h.receive({ id: "401", speaker: "20002", text: "quote source", addressed: true });
    await h.activate("direct_reply");
    expect(h.model?.calls).toHaveLength(2);
    expect(JSON.stringify(h.model?.receivedMessages[1]?.messages)).toContain(
      "CONTEXT_INVALID_SELECTION",
    );
    expect(JSON.stringify(h.model?.receivedMessages[1]?.messages)).toContain("rejected draft");
    const parts = h.db.query("SELECT payload FROM outbound_parts").all();
    expect(parts).toHaveLength(1);
    expect(JSON.stringify(parts)).not.toContain("rejected draft");
    expect(JSON.stringify(parts)).not.toContain("99999");
    await h.deliver();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toEqual([
      { type: "reply", data: { id: "401" } },
      { type: "text", data: { text: "explicit correction" } },
      { type: "at", data: { qq: "20002" } },
    ]);
  });

  it("uses the same correction gate after a generated draft without sending its rejected text", async () => {
    const h = createOneBotHarness({
      model: [
        decideGenerate("20002", "reply", undefined, undefined, ["99999"]),
        say("rejected generated body"),
        correctedReply(),
      ],
    });
    h.receive({ id: "402", speaker: "20002", text: "question", addressed: true });
    await h.activate("direct_reply");
    expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "generate", "next"]);
    expect(JSON.stringify(h.model?.receivedMessages[2]?.messages)).toContain(
      "CONTEXT_INVALID_SELECTION",
    );
    expect(JSON.stringify(h.db.query("SELECT payload FROM outbound_parts").all())).not.toContain(
      "rejected generated body",
    );
    await h.deliver();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toEqual([
      { type: "text", data: { text: "explicit correction" } },
      { type: "at", data: { qq: "20002" } },
    ]);
  });

  it.each(["all", "99999", "+20002"])(
    "never grants or silently strips forbidden mention %s",
    async (id) => {
      const h = createOneBotHarness({ model: [badReply(id), correctedReply()] });
      h.receive({ id: "403", speaker: "20002", text: "question", addressed: true });
      await h.activate("direct_reply");
      expect(h.model?.calls).toHaveLength(2);
      expect(JSON.stringify(h.db.query("SELECT payload FROM outbound_parts").all())).not.toContain(
        "rejected draft",
      );
      await h.deliver();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.message).toEqual([
        { type: "text", data: { text: "explicit correction" } },
        { type: "at", data: { qq: "20002" } },
      ]);
    },
  );

  it("bounds repeated invalid choices by the existing run step budget with zero outbox", async () => {
    const h = createOneBotHarness({ model: Array.from({ length: 20 }, () => badReply("99999")) });
    h.receive({ id: "404", speaker: "20002", text: "question", addressed: true });
    await expect(h.activate("direct_reply")).rejects.toMatchObject({ code: "AGENT_STEP_LIMIT" });
    expect(h.model?.calls).toHaveLength(20);
    expect(h.db.query("SELECT id FROM outbound_intents").all()).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });

  it("keeps an already committed initiative sibling while another corrects its mention", async () => {
    const h = createOneBotHarness({
      initiativeMinScore: 1,
      initiativeBatchTargetCount: 2,
      initiativeBatchJitterCount: 0,
      model: [],
    });
    h.receive({ id: "406", speaker: "20002", text: "first question" });
    const firstSeq = h.lastEventSeq;
    h.receive({ id: "407", speaker: "20004", text: "second question" });
    h.model?.push([
      batchScore([
        { targetId: "20002", score: 1, intent: "first answer", sourceSeqs: [firstSeq] },
        { targetId: "20004", score: 1, intent: "second answer", sourceSeqs: [h.lastEventSeq] },
      ]),
      decideInline("20002", "first committed"),
      decideInline("20004", "rejected sibling", undefined, undefined, ["99999"]),
      decideInline("20004", "corrected sibling", undefined, undefined, ["20004"]),
    ]);
    h.advance(31);
    await h.activate("chiming_in");
    const intents = h.outbox.list({ conversationId: h.conversationId });
    expect(intents).toHaveLength(2);
    const payloads = JSON.stringify(h.db.query("SELECT payload FROM outbound_parts").all());
    expect(payloads).toContain("first committed");
    expect(payloads).toContain("corrected sibling");
    expect(payloads).not.toContain("rejected sibling");
    expect(h.model?.calls).toHaveLength(4);
    await h.deliver();
    expect(h.sent).toHaveLength(2);
    expect(
      h.sent.filter((request) => JSON.stringify(request.message).includes("first committed")),
    ).toHaveLength(1);
  });

  it("keeps a genuinely expired source fatal instead of asking the model to repair it", async () => {
    const scripted = scriptedModel([correctedReply()]);
    let h: ReturnType<typeof createOneBotHarness>;
    h = createOneBotHarness({
      model: {
        ...scripted.port,
        async complete(request) {
          const response = await scripted.port.complete(request);
          h.db.query("UPDATE qq_observation_text SET expires_at=?").run("2000-01-01T00:00:00.000Z");
          return response;
        },
      },
    });
    h.receive({ id: "405", speaker: "20002", text: "expiring source", addressed: true });
    await expect(h.activate("direct_reply")).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(scripted.calls).toHaveLength(1);
    expect(h.db.query("SELECT id FROM outbound_intents").all()).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });
});
