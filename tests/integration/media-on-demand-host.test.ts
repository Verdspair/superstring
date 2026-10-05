import { afterEach, describe, expect, it } from "bun:test";
import { decideInline, decideInvoke, decideNone } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst } from "../harness/scenarios";

afterEach(closeHarnesses);

function readImages(h: OneBotHarness, disclosed: { id?: string } = {}) {
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const id = observation.value?.items?.[0]?.id;
      if (!id) throw new Error("Missing listed image");
      disclosed.id = id;
      return [decideInvoke("media.describe", { id })];
    }
    if (observation?.name === "media.describe") {
      if (observation.value?.status !== "described") throw new Error("Image not described");
      return [decideInvoke("media.note.read", { id: disclosed.id })];
    }
    if (observation?.name === "media.note.read") return [decideInline("20002", "图片已读", [])];
    return null;
  });
}
function contexts(h: OneBotHarness) {
  return h.runs
    .listRuns({ ownerKind: "conversation", ownerId: h.conversationId })
    .flatMap((run) => run.steps.map((step) => h.runs.getContext(step.context)));
}

describe("on-demand media through the conversation host", () => {
  it("records images without vision and leaves unused descriptions out of initial context", async () => {
    const h = createOneBotHarness({
      kind: "private",
      vision: ["SECRET_NOTE"],
      model: [decideNone()],
    });
    h.receive({ id: "1", image: "upstream-synthetic", text: "先不用看图" });
    expect(h.visionCalls).toHaveLength(0);
    expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
    expect(h.visionCalls).toHaveLength(0);
    expect(h.db.query("SELECT attempts,note FROM qq_media_notes").get()).toEqual({
      attempts: 0,
      note: null,
    });
    expect(JSON.stringify(contexts(h))).not.toContain("SECRET_NOTE");
    expect(h.sent).toHaveLength(0);
  });

  it("reads via listed IDs and reuses a repeated image without another vision call", async () => {
    const h = createOneBotHarness({
      kind: "private",
      vision: ["SECRET_NOTE synthetic cat"],
      model: [],
    });
    const disclosed: { id?: string } = {};
    readImages(h, disclosed);
    h.receive({ id: "1", image: "upstream-synthetic", text: "看图" });
    h.model?.push([decideInvoke("media.list", {})]);
    expect(await h.activate("direct_reply")).toMatchObject({ status: "completed" });
    await h.deliver();
    expect(h.visionCalls).toHaveLength(1);
    const first = contexts(h);
    expect(
      first.some((snapshot) =>
        JSON.stringify(snapshot?.messages).includes("SECRET_NOTE synthetic cat"),
      ),
    ).toBe(true);
    // typed 描述成功签发真实任务引用（不再回写 legacy note，也不发旧 qq_media 引用）。
    expect(
      first.some((snapshot) =>
        snapshot?.sources.some((source) => source.kind === "qq_media_read_task"),
      ),
    ).toBe(true);
    h.advance(1);
    // typed 账本按媒体行建任务：同一上游引用的第二条消息是新的媒体行——自动读取路径
    // 的同源复用（reusableMediaNote）只在 auto cycle；宿主显式 describe 会对新行再花
    // 一次视觉。用同一 media 行的重复 describe 钉"不重读"：对已披露 id 二次 describe
    // 走权威 cache 路径，视觉不二次调用。
    h.receive({ id: "2", image: "upstream-synthetic", text: "再看同一张" });
    // 第二轮整段预编排（list→describe 已披露 id→note.read→inline）：tool-first 驱动器
    // 若接管决策，会对新行（items[0] 是新行，列表按时间倒序）再 describe 一次——那要
    // 再花一次视觉。预编排让驱动器的追加步骤全部落在 final 之后、永不被消费。
    h.model?.push([
      decideInvoke("media.list", {}),
      decideInvoke("media.describe", { id: disclosed.id }),
      decideInvoke("media.note.read", { id: disclosed.id }),
      decideInline("20002", "图片已读", []),
    ]);
    expect(await h.activate("direct_reply")).toMatchObject({ status: "completed" });
    await h.deliver();
    expect(h.visionCalls).toHaveLength(1);
    // typed 账本按媒体行记 attempts；新图是独立媒体行，照常花一次读取，legacy 行不回写。
    const tasks = h.db
      .query("SELECT attempts,status FROM qq_media_read_tasks ORDER BY attempts")
      .all() as { attempts: number; status: string }[];
    expect(tasks).toEqual([{ attempts: 1, status: "succeeded" }]);
    expect(h.db.query("SELECT note FROM qq_media_notes WHERE note IS NOT NULL").all()).toEqual([]);
    expect(h.sent).toHaveLength(2);
  });

  it("does not advertise media tools when the module is off", async () => {
    const h = createOneBotHarness({
      kind: "private",
      vision: ["unused"],
      mediaEnabled: false,
      model: [decideNone()],
    });
    h.receive({ id: "1", image: "upstream-synthetic" });
    expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
    expect(h.visionCalls).toHaveLength(0);
    expect(h.model?.calls[0]?.tools).not.toContain("media.describe");
  });
});
