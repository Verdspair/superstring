import { afterEach, describe, expect, it } from "bun:test";
import { decideInline, decideInvoke, decideNone } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst } from "../harness/scenarios";

afterEach(closeHarnesses);

function readImages(h: OneBotHarness) {
  let id: string | undefined;
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      id = observation.value?.items?.[0]?.id;
      if (!id) throw new Error("Missing listed image");
      return [decideInvoke("media.describe", { id })];
    }
    if (observation?.name === "media.describe") {
      if (observation.value?.status !== "described") throw new Error("Image not described");
      return [decideInvoke("media.note.read", { id })];
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
    readImages(h);
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
    expect(
      first.some((snapshot) => snapshot?.sources.some((source) => source.kind === "qq_media")),
    ).toBe(true);
    h.advance(1);
    h.receive({ id: "2", image: "upstream-synthetic", text: "再看同一张" });
    h.model?.push([decideInvoke("media.list", {})]);
    expect(await h.activate("direct_reply")).toMatchObject({ status: "completed" });
    await h.deliver();
    expect(h.visionCalls).toHaveLength(1);
    const notes = h.db.query("SELECT attempts,note FROM qq_media_notes ORDER BY attempts").all();
    expect(notes).toEqual([
      { attempts: 0, note: "SECRET_NOTE synthetic cat" },
      { attempts: 1, note: "SECRET_NOTE synthetic cat" },
    ]);
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
