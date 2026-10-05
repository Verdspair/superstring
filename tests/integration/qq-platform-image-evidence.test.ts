// T03/规格 §7.2：平台扩展图片提示归一（market face 可靠结构证据 → 平台分类）。
//
// 证据来源（内部报告 prime-platform-image-hint-plan.md，均实读核实）：
//   * OneBot 11 官方标准 image 收侧仅 file/type(=flash)/url，无分类字段；
//   * NapCat 实发 image 段：file/url/sub_type/summary/file_size；market face 被映射为
//     image 段带 emoji_id/emoji_package_id/key/summary（NapNeko/NapCatQQ packages/napcat-onebot/api/msg.ts）；
//   * go-cqhttp 实发驼峰 subType（Mrs4s/go-cqhttp coolq/cqcode.go，MiraiGo ImageBizType）。
// 规则（已批最小方案）：emoji_id + emoji_package_id + summary 三键同现且均为非空 string
// 才判 expression；单字段/误形/跨实现 subtype 数值/flash/gif URL 一律不猜，保持 unknown；
// 未知键维持既有丢弃契约（secret:"omit" 背书）；key/URL/summary 不作为命令或持久元数据保存。

import { describe, expect, it } from "bun:test";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>) {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','90001','group','30003',?,'scheme',?,?)",
    )
    .run(DEFAULT_AGENT_ID, now, now);
}

function imageEvent(data: Record<string, unknown>, messageId = -201) {
  return {
    time: at,
    self_id: 90001,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: messageId,
    user_id: 10001,
    group_id: 30003,
    sender: { nickname: "阿林" },
    message: [{ type: "image", data }],
  };
}

const MARKET_FACE = {
  file: "8a-00abc123.gif",
  url: "https://gxh.vip.qq.com/club/item/parcel/item/8a/00abc123/raw300.gif",
  summary: "[萌宠]",
  key: "secret-key-value",
  emoji_id: "00abc123",
  emoji_package_id: "8",
};

function imagePart(event: ReturnType<typeof imageEvent>) {
  const result = normalizeOneBotMessage(event, "90001");
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation.segments[0];
}

function storedCategory(event: ReturnType<typeof imageEvent>) {
  const h = setup();
  try {
    bind(h);
    const result = normalizeOneBotMessage(event, "90001");
    if (result.kind !== "message") throw new Error("message expected");
    recordObservation(h.orm, result.observation, DEFAULT_AGENT_ID);
    const row = h.db.query("SELECT parts FROM qq_message_facts LIMIT 1").get() as { parts: string };
    const parts = JSON.parse(row.parts) as Array<{ kind: string; category?: string }>;
    const image = parts.find((p) => p.kind === "image");
    return image?.category;
  } finally {
    h.close();
  }
}

describe("platform image evidence normalization (spec §7.2)", () => {
  it("classifies a complete market face segment as expression via the real wire path", () => {
    const segment = imagePart(imageEvent(MARKET_FACE));
    if (segment.kind !== "image") throw new Error("image segment expected");
    expect(segment.categoryEvidence).toBe("expression");
  });

  it("records platform expression category through real intake, no DB seeding", () => {
    expect(storedCategory(imageEvent(MARKET_FACE))).toBe("expression");
  });

  it("keeps unknown for single market field, malformed shapes and non-string values", () => {
    for (const data of [
      { ...MARKET_FACE, emoji_package_id: undefined },
      { ...MARKET_FACE, emoji_id: undefined },
      { ...MARKET_FACE, summary: undefined },
      { ...MARKET_FACE, emoji_id: "" },
      { ...MARKET_FACE, emoji_package_id: 8 },
      { emoji_id: "00abc123" },
    ]) {
      const segment = imagePart(imageEvent(data));
      if (segment.kind !== "image") throw new Error("image segment expected");
      expect(segment.categoryEvidence).toBeUndefined();
    }
    expect(storedCategory(imageEvent({ ...MARKET_FACE, emoji_id: 123 }))).toBe("unknown");
  });

  it("never guesses from cross-implementation sub_type numbers, flash type or gif URLs", () => {
    for (const data of [
      { file: "a.png", sub_type: 1 },
      { file: "a.png", subType: "7" },
      { file: "a.png", type: "flash" },
      { file: "meme.gif", url: "https://example.invalid/meme.gif" },
    ]) {
      const segment = imagePart(imageEvent(data));
      if (segment.kind !== "image") throw new Error("image segment expected");
      expect(segment.categoryEvidence).toBeUndefined();
      expect(storedCategory(imageEvent(data))).toBe("unknown");
    }
  });

  it("keeps the existing contract: unknown data keys are dropped, file/url/name intact", () => {
    const segment = imagePart(
      imageEvent({ file: "asset.gif", url: "https://example.invalid/a", secret: "omit", key: "k" }),
    );
    if (segment.kind !== "image") throw new Error("image segment expected");
    expect(segment).toEqual({
      kind: "image",
      file: "asset.gif",
      url: "https://example.invalid/a",
    });
  });
});
