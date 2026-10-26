import { afterEach, describe, expect, it } from "bun:test";
import { batchScore, decideGenerate, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

describe("QQ stable system sequence prefix", () => {
  it("expects system instructions to remain byte-identical across sequential activations on same conversation and path", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      model: [decideGenerate("20002", "回答一", []), say("合成回复一")],
    });

    h.receive({
      id: "101",
      speaker: "20002",
      text: "第一条消息",
      addressed: true,
    });
    await h.activate("direct_reply");
    await h.deliver();

    const seq1 = h.observedSeq();
    expect(seq1).toBeGreaterThan(0);

    const call0Messages = h.model?.receivedMessages[0]?.messages ?? [];
    const systemText1 = call0Messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.content.flatMap((p) => (p.kind === "text" ? [p.text] : [])))
      .join("\n");
    expect(systemText1.length).toBeGreaterThan(0);

    h.model?.push([decideGenerate("20002", "回答二", []), say("合成回复二")]);
    h.receive({
      id: "102",
      speaker: "20002",
      text: "第二条消息",
      addressed: true,
    });
    await h.activate("direct_reply");
    await h.deliver();

    const seq2 = h.observedSeq();
    expect(seq2).toBeGreaterThan(seq1);

    const call2Messages = h.model?.receivedMessages[2]?.messages ?? [];
    const systemText2 = call2Messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.content.flatMap((p) => (p.kind === "text" ? [p.text] : [])))
      .join("\n");

    // System instructions remain byte-identical across sequential activations with identical path & targets,
    // as dynamic sequence digits are governed by program cursors rather than mutating the system prompt.
    expect(systemText2).toEqual(systemText1);
  });

  it("rejects low score and admits related follow-up above threshold", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: [],
    });

    // Round 1: first inbound message arrives for target 10001
    h.receive({
      id: "201",
      speaker: "10001",
      text: "首个输入",
      groupCard: "阿林",
    });
    h.advance(31);

    // Score 5 is below the default initiative_min_score (6): no reply permitted
    h.model?.push([
      batchScore([
        { targetId: "10001", score: 5, intent: "暂不接话", sourceSeqs: [h.observedSeq()] },
      ]),
    ]);
    await h.activate("chiming_in");
    await h.deliver();

    // Below threshold: no reply sent, zero deliveries committed
    expect(h.sent).toHaveLength(0);
    const firstSeq = h.observedSeq();
    expect(firstSeq).toBeGreaterThan(0);

    // Round 2: related new input arrives for target 10001 with qualified score (6 >= 6)
    h.receive({
      id: "202",
      speaker: "10001",
      text: "相关跟进提问",
      groupCard: "阿林",
    });
    h.advance(31);

    h.model?.push([
      batchScore([
        { targetId: "10001", score: 6, intent: "明确回应", sourceSeqs: [h.observedSeq()] },
      ]),
      decideGenerate("10001", "回答问题", []),
      say("主动回复正文"),
    ]);
    await h.activate("chiming_in");
    await h.deliver();

    // Related input advances sequence and permits generation
    const secondSeq = h.observedSeq();
    expect(secondSeq).toBeGreaterThan(firstSeq);
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0]?.message)).toContain("主动回复正文");
  });
});
