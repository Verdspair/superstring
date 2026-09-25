import { describe, expect, it } from "bun:test";
import {
  classifyOneBotSendReceipt,
  isOneBotAuthenticationFailure,
  normalizeOneBotMessage,
} from "../../src/server/services/onebot-protocol";

const groupEvent = (patch: Record<string, unknown> = {}) => ({
  time: 123,
  self_id: 10001,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: -12,
  user_id: 20002,
  group_id: 30003,
  message: [{ type: "text", data: { text: "你好" } }],
  sender: { nickname: "昵称", card: "群名片" },
  ...patch,
});
const normalize = (patch: Record<string, unknown> = {}) =>
  normalizeOneBotMessage(groupEvent(patch), "10001");
const observation = (patch: Record<string, unknown> = {}) => {
  const result = normalize(patch);
  if (result.kind !== "message") throw new Error(`Unexpected result: ${result.kind}`);
  return result.observation;
};
const receipt = (patch: Record<string, unknown> = {}) =>
  classifyOneBotSendReceipt(
    { status: "ok", retcode: 0, data: { message_id: -42 }, echo: "send-1", ...patch },
    "send-1",
  );

describe("OneBot message boundary", () => {
  it("normalizes group identities and preserves negative platform message IDs", () => {
    expect(observation()).toMatchObject({
      accountId: "10001",
      messageId: "-12",
      occurredAtSeconds: 123,
      conversation: { kind: "group", peerId: "30003" },
      speaker: { kind: "member", id: "20002", displayName: "群名片" },
      text: "你好",
      mentionsSelf: false,
    });
  });
  it("canonicalizes numeric and string IDs to the same stable keys", () => {
    const original = observation();
    const stringIds = observation({
      self_id: "010001",
      user_id: "020002",
      group_id: "030003",
      message_id: "-00012",
    });
    expect(stringIds.eventKey).toBe(original.eventKey);
    expect(stringIds.speaker.id).toBe(original.speaker.id);
  });
  it("does not derive keys from sender names or receiving time", () => {
    expect(observation({ sender: { nickname: "另一昵称" }, time: 456 }).eventKey).toBe(
      observation().eventKey,
    );
  });
  it("separates accounts, peers, conversation kinds and message IDs", () => {
    const base = observation();
    const privateMessage = observation({
      message_type: "private",
      sub_type: "friend",
      user_id: 30003,
    });
    const anotherAccount = normalizeOneBotMessage(groupEvent({ self_id: 10002 }), "10002");
    if (anotherAccount.kind !== "message") throw new Error("Expected account message");
    const keys = [
      base.eventKey,
      privateMessage.eventKey,
      anotherAccount.observation.eventKey,
      observation({ group_id: 30004 }).eventKey,
      observation({ message_id: -13 }).eventKey,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("uses the peer user for private conversations, not the optional group ID", () => {
    expect(observation({ message_type: "private", sub_type: "group" }).conversation).toMatchObject({
      kind: "private",
      peerId: "20002",
    });
  });
  it("keeps stable IDs when sender display information is absent", () => {
    expect(observation({ sender: undefined }).speaker).toEqual({
      kind: "member",
      id: "20002",
      displayName: null,
    });
  });
  it("filters both self-message mechanisms before parsing message segments", () => {
    for (const patch of [{ post_type: "message_sent" }, { user_id: 10001 }]) {
      expect(normalize({ ...patch, message: "[CQ:image,file=ignored]" })).toEqual({
        kind: "ignored",
        reason: "self_message",
      });
    }
  });
  it("rejects events from a different authenticated account", () => {
    expect(normalize({ self_id: 10002 })).toEqual({ kind: "ignored", reason: "account_mismatch" });
  });
  it("ignores lifecycle, notice and request events without treating them as chat", () => {
    for (const post_type of ["meta_event", "notice", "request"]) {
      expect(normalizeOneBotMessage({ post_type }, "10001")).toEqual({
        kind: "ignored",
        reason: "not_message",
      });
    }
  });
  it("rejects malformed top-level inputs without throwing or leaking contents", () => {
    for (const input of [null, [], 42, "secret", { post_type: "message" }]) {
      expect(normalizeOneBotMessage(input, "10001")).toEqual({
        kind: "invalid",
        reason: "invalid_event",
      });
    }
  });
  it("requires a verified positive account identity", () => {
    for (const id of ["", "-1", "0", "1e4", " 10001"]) {
      expect(normalizeOneBotMessage(groupEvent(), id)).toEqual({
        kind: "invalid",
        reason: "invalid_account",
      });
    }
  });
  it("rejects unsafe numeric identities instead of accepting rounded numbers", () => {
    for (const key of ["self_id", "user_id", "group_id", "message_id"]) {
      expect(normalize({ [key]: Number.MAX_SAFE_INTEGER + 1 }).kind).toBe("invalid");
    }
    expect(observation({ message_id: "9007199254740993" }).messageId).toBe("9007199254740993");
  });
  it("rejects missing group identity and invalid timestamp", () => {
    for (const patch of [{ group_id: undefined }, { group_id: 0 }, { time: -1 }, { time: 1.2 }]) {
      expect(normalize(patch).kind).toBe("invalid");
    }
  });
  it("does not invent member identities for anonymous or system group messages", () => {
    for (const patch of [{ sub_type: "anonymous" }, { anonymous: { id: 999 } }]) {
      expect(observation(patch).speaker).toEqual({
        kind: "anonymous",
        id: null,
        displayName: null,
      });
    }
    expect(observation({ sub_type: "notice" }).speaker).toEqual({
      kind: "system",
      id: null,
      displayName: null,
    });
  });
  it("requires array-format input, never interprets CQ strings as normal text", () => {
    expect(normalize({ message: "hello[CQ:image,file=x]" })).toEqual({
      kind: "invalid",
      reason: "unsupported_message_format",
    });
  });
  it("preserves ordered text, mentions, quotes, media and unsupported segments", () => {
    const result = observation({
      message: [
        { type: "reply", data: { id: "-012" } },
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: "[CQ:image,file=literal]&#91;" } },
        {
          type: "image",
          data: { file: "asset.gif", url: "https://example.invalid/a", secret: "omit" },
        },
        { type: "record", data: { file: "voice.silk" } },
        { type: "face", data: { id: 123 } },
        { type: "video", data: { file: "clip.mp4" } },
        { type: "file", data: { name: "example.txt", file: "attachment" } },
        { type: "future", data: null },
        { type: "text", data: { text: "结束" } },
      ],
    });
    expect(result.mentionsSelf).toBe(true);
    expect(result.text).toBe("[CQ:image,file=literal]&#91;结束");
    expect(result.segments.map((s) => s.kind)).toEqual([
      "reply",
      "mention",
      "text",
      "image",
      "record",
      "face",
      "video",
      "file",
      "unsupported",
      "text",
    ]);
    expect(result.segments[0]).toEqual({ kind: "reply", messageId: "-12" });
    expect(result.segments[3]).toEqual({
      kind: "image",
      file: "asset.gif",
      url: "https://example.invalid/a",
    });
  });
  it("does not infer an explicit self mention from at-all or another member", () => {
    expect(
      observation({
        message: [
          { type: "at", data: { qq: "all" } },
          { type: "at", data: { qq: 20002 } },
        ],
      }).mentionsSelf,
    ).toBe(false);
  });
  it("keeps media-only observations without fabricating a description", () => {
    const result = observation({ message: [{ type: "image", data: { file: "picture" } }] });
    expect(result.text).toBe("");
    expect(result.segments).toEqual([{ kind: "image", file: "picture" }]);
  });
  it("rejects malformed known segments as a whole instead of silently dropping them", () => {
    for (const segment of [
      { type: "text", data: null },
      { type: "at", data: { qq: {} } },
      { type: "reply", data: { id: "bad" } },
      { type: "image", data: { url: 123 } },
      { type: "text", data: [] },
      null,
    ]) {
      expect(normalize({ message: [{ type: "text", data: { text: "before" } }, segment] })).toEqual(
        {
          kind: "invalid",
          reason: "invalid_segments",
        },
      );
    }
  });
  it("projects only allowed fields and does not mutate upstream input", () => {
    const input = groupEvent({ secret: "do not propagate", raw_message: "do not propagate" });
    const before = JSON.stringify(input);
    const result = normalizeOneBotMessage(input, "10001");
    expect(JSON.stringify(result)).not.toContain("do not propagate");
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("OneBot send receipt boundary", () => {
  it("confirms only a matching successful response with a platform message ID", () => {
    expect(receipt()).toEqual({ kind: "confirmed", messageId: "-42" });
    expect(receipt({ data: { message_id: 0 } })).toEqual({ kind: "confirmed", messageId: "0" });
    expect(receipt({ data: { message_id: "9007199254740993" } })).toEqual({
      kind: "confirmed",
      messageId: "9007199254740993",
    });
  });
  it("classifies explicit failure without exposing external error text", () => {
    expect(receipt({ status: "failed", retcode: 1200, wording: "private details" })).toEqual({
      kind: "failed",
      retcode: 1200,
    });
  });
  it("treats async acknowledgement as unknown delivery, not success", () => {
    expect(receipt({ status: "async", retcode: 1, data: null })).toEqual({
      kind: "unknown",
      reason: "async",
    });
  });
  it("does not match missing or foreign echo, or an event with a spoofed echo", () => {
    for (const patch of [
      { echo: "other" },
      { echo: undefined },
      { echo: 1 },
      { post_type: "message" },
    ]) {
      expect(receipt(patch)).toEqual({ kind: "unrelated" });
    }
    expect(classifyOneBotSendReceipt(null, "send-1")).toEqual({ kind: "unrelated" });
  });
  it("rejects empty correlation tokens", () => {
    expect(() => classifyOneBotSendReceipt({}, "")).toThrow(TypeError);
  });
  it("treats contradictory or malformed matching envelopes as unknown", () => {
    for (const patch of [
      { status: "ok", retcode: 1 },
      { status: "failed", retcode: 0 },
      { status: "failed", retcode: 1 },
      { status: "async", retcode: 0 },
      { status: "other" },
      { retcode: "0" },
      { retcode: 1.1 },
      { retcode: Number.NaN },
    ])
      expect(receipt(patch)).toEqual({ kind: "unknown", reason: "malformed_receipt" });
  });
  it("does not claim success without a valid message ID", () => {
    for (const data of [
      null,
      {},
      [],
      { message_id: "bad" },
      { message_id: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(receipt({ data })).toEqual({ kind: "unknown", reason: "missing_message_id" });
    }
  });
  it("recognizes post-open authentication rejection without assigning it to a send", () => {
    const failure = { status: "failed", retcode: 1403, data: null };
    expect(isOneBotAuthenticationFailure(failure)).toBe(true);
    expect(classifyOneBotSendReceipt(failure, "send-1")).toEqual({ kind: "unrelated" });
    expect(isOneBotAuthenticationFailure({ ...failure, echo: "" })).toBe(true);
    expect(isOneBotAuthenticationFailure({ ...failure, echo: "send-1" })).toBe(false);
    expect(isOneBotAuthenticationFailure({ ...failure, post_type: "message" })).toBe(false);
    expect(isOneBotAuthenticationFailure({ ...failure, retcode: 1200 })).toBe(false);
    expect(isOneBotAuthenticationFailure(null)).toBe(false);
  });
});
