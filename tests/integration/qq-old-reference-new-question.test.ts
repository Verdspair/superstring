import { describe, expect, it } from "bun:test";
import { loadQqMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { expandQqReplies } from "../../src/server/channels/onebot11/reply-context";
import {
  buildQqPrompt,
  QQ_PROMPT_DEFAULTS,
  qqJudgeAllowsSpeech,
} from "../../src/server/services/qq-prompt-contract";
import {
  CONFIRMED_ANSWER_TEXT,
  FIXED_NOW,
  peerReply,
  read,
  sourceFixture,
} from "../harness/qq-reply-continuity";

describe("old references with a new question", () => {
  it("keeps a readable old message as context after a previous reply instead of treating its identity as a ban", async () => {
    const h = sourceFixture();
    const oldKey = h.seed("OLD-QUESTION: explain the configuration", 30);
    h.db
      .query(
        "UPDATE qq_message_facts SET name_state='known',legacy_display_name=NULL,personal_nickname='member' WHERE event_key=?",
      )
      .run(oldKey);
    const peer = peerReply(h);
    peer.complete();
    peer.settle("confirmed");
    const newKey = h.seed(
      "NEW-QUESTION: how does the earlier configuration handle cancellation?",
      0,
    );
    const scope = {
      conversationId: h.conversation.id,
      accountId: h.binding.accountId,
      conversationKind: h.binding.kind,
      peerId: h.binding.peerId,
      agentId: h.binding.agentId,
      bindingId: h.binding.id,
      bindingEpoch: h.conversation.bindingEpoch,
      authorityRevision: h.binding.authorityRevision,
    };
    const oldFact = loadQqMessageFact(h, scope, oldKey, FIXED_NOW);
    const newFact = loadQqMessageFact(h, scope, newKey, FIXED_NOW);
    expect(oldFact).not.toBeNull();
    expect(newFact).not.toBeNull();
    const quoted = { ...newFact!, replyTo: { platformMessageId: oldKey } };
    const projection = expandQqReplies({
      scope,
      window: [quoted],
      focus: {
        triggerMessageIds: [newKey],
        responseMessageIds: [newKey],
        responseQqs: ["20002"],
        assistantQq: h.binding.accountId,
      },
      settings: {
        reply_mode: "one_then_on_demand",
        reply_depth: 2,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      },
      load: (id) => loadQqMessageFact(h, scope, id, FIXED_NOW),
      now: FIXED_NOW,
      remainingTextUnits: 8192,
      register: () => "test-reference",
      fits: () => true,
    });
    expect(JSON.stringify(projection)).toContain("OLD-QUESTION");
    const material = await read(h.buildSource());
    expect(JSON.stringify(material)).toContain("NEW-QUESTION");
    expect(JSON.stringify(material)).toContain(CONFIRMED_ANSWER_TEXT);
    expect(qqJudgeAllowsSpeech({ kind: "scored", score: 8, reason: null }, 2)).toBe(true);
  });
  it("does not add autonomous suppression instructions to a directly addressed old-message follow-up", () => {
    const sections = buildQqPrompt({
      tier: "reply",
      path: "direct_reply",
      persona: "",
      prompts: QQ_PROMPT_DEFAULTS,
      timeline: [],
      nowSeconds: 1,
      replyingTo: { speakerId: "20002", label: "member" },
    });
    const scene = sections.find((s) => s.origin === "path")!.body;
    expect(scene).toContain("member");
    expect(scene).not.toContain("新增贡献");
  });
});
