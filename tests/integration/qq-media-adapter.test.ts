// The real media path: reference → bytes → frames → picture model (ADR0018 P5j, §7.1).
//
// The reader was already tested with an injected adapter; what these cases cover is the adapter
// that fills the seam — the part that must not guess. It refuses voice and video (undecided
// protocol / no decoder) instead of inventing a description, and it sniffs the container from the
// bytes rather than trusting a reference's name, exactly as the sticker import does.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import upstream from "omggif";
import { recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { createQqMediaAdapter } from "../../src/server/services/qq-media-adapter";
import { readQqAddressedMediaOnce } from "../../src/server/services/qq-media-cycle";
import { createQqMediaSourceFetcher } from "../../src/server/services/qq-media-source";

const AGENT = "00000000-0000-0000-0000-000000000001";
const PNG = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));

function gifBytes(): Uint8Array<ArrayBuffer> {
  const width = 8;
  const height = 8;
  const buffer = new Uint8Array(width * height * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer.addFrame(0, 0, width, height, new Array(width * height).fill(0), { delay: 10 });
  writer.addFrame(0, 0, width, height, new Array(width * height).fill(1), { delay: 10 });
  return buffer.slice(0, writer.end());
}

function visionClient() {
  const calls: {
    model: string;
    prompt: string;
    images: readonly { mimeType: string }[];
  }[] = [];
  return {
    calls,
    client: {
      annotate: async (request: {
        model: string;
        prompt: string;
        images: readonly { mimeType: string }[];
      }) => {
        calls.push(request);
        return "一张合成图片";
      },
    },
  };
}

describe("the QQ media adapter", () => {
  it("fetches the source, samples an animation, and asks the picture model", async () => {
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: gifBytes() }),
      vision: client as never,
      prompt: "如实说明这条消息里的媒体内容。",
    });
    expect(await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" })).toBe(
      "一张合成图片",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("vision-local");
    expect(calls[0]?.prompt).toBe("如实说明这条消息里的媒体内容。");
    // §7.1's 有限抽帧: the model sees composited PNG frames, not the GIF file.
    expect(calls[0]?.images.map((image) => image.mimeType)).toEqual(["image/png", "image/png"]);
  });

  it("samples the number of frames the conversation asked for (0029)", async () => {
    const { calls, client } = visionClient();
    // §7.1's 可改 sampling: the scheme carries the two numbers, so a conversation that wants more
    // frames — or smaller ones — gets them, and the defaults are what the fixtures above use.
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: gifBytes() }),
      vision: client as never,
      prompt: "如实说明这条消息里的媒体内容。",
      frames: 1,
      maxDimension: 64,
    });
    await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" });
    // One frame means the first frame, which is also the regression the sampling fix pinned.
    expect(calls[0]?.images).toHaveLength(1);
  });

  it("refuses a sampling request it cannot honour", () => {
    // Zero frames would be a silent empty picture; the adapter validates rather than guessing.
    expect(() =>
      createQqMediaAdapter({
        fetchSource: async () => ({ bytes: PNG }),
        vision: visionClient().client as never,
        prompt: "如实说明这条消息里的媒体内容。",
        frames: 0,
      }),
    ).toThrow();
    expect(() =>
      createQqMediaAdapter({
        fetchSource: async () => ({ bytes: PNG }),
        vision: visionClient().client as never,
        prompt: "如实说明这条消息里的媒体内容。",
        maxDimension: 4096,
      }),
    ).toThrow();
  });

  it("sends a still picture as itself", async () => {
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: PNG }),
      vision: client as never,
      prompt: "说明媒体",
    });
    await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" });
    expect(calls[0]?.images.map((image) => image.mimeType)).toEqual(["image/png"]);
  });

  it("refuses voice and video loudly instead of writing a description", async () => {
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: PNG }),
      vision: client as never,
      prompt: "说明媒体",
    });
    await expect(
      adapter.read({ kind: "record", sourceRef: "ref", model: "whisper" }),
    ).rejects.toThrow(/transcribe/);
    await expect(
      adapter.read({ kind: "video", sourceRef: "ref", model: "vision-local" }),
    ).rejects.toThrow(/video/);
    expect(calls).toHaveLength(0);
  });

  it("refuses bytes whose header cannot be read", async () => {
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: new TextEncoder().encode("not an image") }),
      vision: visionClient().client as never,
      prompt: "说明媒体",
    });
    await expect(
      adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" }),
    ).rejects.toThrow(/header/);
  });
});

describe("the media source fetcher", () => {
  it("decodes a data URL, reads a local file, and fetches an http reference", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qq-media-source-"));
    try {
      const localPath = path.join(directory, "cached.png");
      writeFileSync(localPath, PNG);
      const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
      const requested: string[] = [];
      const fetcher = createQqMediaSourceFetcher({
        resolveSource: async ({ sourceRef }) => ({ kind: "source", reference: sourceRef }),
        fetchImpl: (async (url: string | URL) => {
          requested.push(String(url));
          return new Response(PNG, { status: 200 });
        }) as unknown as typeof fetch,
      });
      expect((await fetcher({ kind: "image", sourceRef: dataUrl })).bytes).toEqual(PNG);
      expect((await fetcher({ kind: "image", sourceRef: localPath })).bytes).toEqual(PNG);
      expect(
        (await fetcher({ kind: "image", sourceRef: "http://127.0.0.1:1/cached.png" })).bytes,
      ).toEqual(PNG);
      expect(requested).toEqual(["http://127.0.0.1:1/cached.png"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses when the bot side hands back no source", async () => {
    const fetcher = createQqMediaSourceFetcher({
      resolveSource: async () => ({ kind: "unavailable", reason: "not_ready" }),
    });
    await expect(fetcher({ kind: "image", sourceRef: "ref" })).rejects.toThrow(/not_ready/);
  });
});

function fixture(kind: "image" | "record" | "video" = "image", segments = 1) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: `media-cycle-${kind}-${segments}` });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: "11111111-1111-4111-8111-111111111111",
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: AGENT,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: "media-1",
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: AGENT,
      messageId: "m1",
      occurredAtSeconds: Math.floor(Date.now() / 1000),
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
  for (let index = 0; index < segments; index += 1) {
    recordMediaSegment(h.orm, {
      eventKey: "media-1",
      segmentIndex: index,
      kind,
      sourceRef: `upstream-ref-${index}`,
      occurredAtSeconds: Math.floor(Date.now() / 1000),
      addressed: true,
    });
  }
  return h;
}

const cycleInput = {
  eventKey: "media-1",
  addressedToAssistant: true,
  relatedSupplementArrived: false,
  modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
};

describe("one reading turn per message", () => {
  it("reads the first segment that has no description, exactly once", async () => {
    const h = fixture("image", 2);
    const seen: string[] = [];
    try {
      const result = await readQqAddressedMediaOnce(
        h.orm,
        {
          read: async ({ sourceRef }) => {
            seen.push(sourceRef);
            return "第一张的说明";
          },
        },
        cycleInput,
      );
      expect(result).toEqual({
        kind: "read",
        segmentIndex: 0,
        result: { kind: "described", attempt: 1 },
      });
      // §7.1: one segment per turn — a failure would mean "wait for a supplement", not "next one".
      expect(seen).toEqual(["upstream-ref-0"]);
      // The second turn picks up the next segment, because the first now has a note.
      const second = await readQqAddressedMediaOnce(
        h.orm,
        { read: async () => "第二张的说明" },
        cycleInput,
      );
      expect(second).toEqual({
        kind: "read",
        segmentIndex: 1,
        result: { kind: "described", attempt: 1 },
      });
      expect(
        await readQqAddressedMediaOnce(h.orm, { read: async () => "不该再读" }, cycleInput),
      ).toEqual({ kind: "idle", reason: "all_described" });
    } finally {
      h.close();
    }
  });

  it("reports idle when the message carried no media at all", async () => {
    const h = fixture("image", 0);
    try {
      expect(
        await readQqAddressedMediaOnce(h.orm, { read: async () => "不该读" }, cycleInput),
      ).toEqual({ kind: "idle", reason: "no_media" });
    } finally {
      h.close();
    }
  });
});
