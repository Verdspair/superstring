// The real media path: reference → bytes → frames → picture model (ADR0018 P5j, §7.1).
//
// The reader was already tested with an injected adapter; what these cases cover is the adapter
// that fills the seam — the part that must not guess. It refuses voice and video (undecided
// protocol / no decoder) instead of inventing a description, and it sniffs the container from the
// bytes rather than trusting a reference's name, exactly as the sticker import does.

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import upstream from "omggif";
import { mediaNoteRow, recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { QqImagePrepareError } from "../../src/server/services/qq-image-codec";
import { createQqMediaAdapter } from "../../src/server/services/qq-media-adapter";
import { readQqAddressedMediaOnce } from "../../src/server/services/qq-media-cycle";
import { createQqMediaSourceFetcher } from "../../src/server/services/qq-media-source";
import { createEphemeralAgentRuntime } from "../harness/ephemeral-runtime";

const AGENT = "00000000-0000-0000-0000-000000000001";
const PNG = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));

function gifBytes(frameCount = 2): Uint8Array<ArrayBuffer> {
  const width = 8;
  const height = 8;
  const buffer = new Uint8Array(width * height * frameCount * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  for (let index = 0; index < frameCount; index += 1) {
    writer.addFrame(0, 0, width, height, new Array(width * height).fill(index % 2), { delay: 10 });
  }
  return buffer.slice(0, writer.end());
}

function sampledFramesPayload(prompt: string): {
  sampled_frames: {
    source: string;
    suppliedCount: number;
    truncated: boolean;
    frames: { index: number; sourceTotal: number }[];
  };
} {
  const line = prompt.split("\n").find((candidate) => {
    try {
      return "sampled_frames" in JSON.parse(candidate);
    } catch {
      return false;
    }
  });
  if (!line) throw new Error(`prompt carries no sampled_frames JSON: ${prompt}`);
  return JSON.parse(line);
}

function visionClient() {
  const calls: {
    model: string;
    prompt: string;
    images: readonly { mimeType: string; bytes: Uint8Array }[];
  }[] = [];
  return {
    calls,
    client: {
      annotate: async (request: {
        model: string;
        prompt: string;
        images: readonly { mimeType: string; bytes: Uint8Array }[];
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
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "如实说明这条消息里的媒体内容。",
    });
    expect(await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" })).toBe(
      "一张合成图片",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("vision-local");
    // The instruction itself is unchanged; the sampling facts travel as a JSON data suffix.
    expect(calls[0]?.prompt.startsWith("如实说明这条消息里的媒体内容。")).toBe(true);
    // §7.1's 有限抽帧: the model sees composited PNG frames, not the GIF file.
    expect(calls[0]?.images.map((image) => image.mimeType)).toEqual(["image/png", "image/png"]);
    const payload = sampledFramesPayload(calls[0]?.prompt ?? "");
    // No reference in this read, so the source is the existing sha256 fallback of the ref.
    expect(payload.sampled_frames.source).toBe(createHash("sha256").update("ref").digest("hex"));
    expect(payload.sampled_frames.suppliedCount).toBe(2);
    expect(payload.sampled_frames.truncated).toBe(false);
    expect(payload.sampled_frames.frames).toEqual([
      { index: 0, sourceTotal: 2 },
      { index: 1, sourceTotal: 2 },
    ]);
    // The transport reference (URL/path/bytes of the source) must never travel into a prompt.
    expect(calls[0]?.prompt).not.toMatch(/upstream-ref|data:|file:/);
  });

  it("samples the number of frames the conversation asked for (0029)", async () => {
    const { calls, client } = visionClient();
    // §7.1's 可改 sampling: the scheme carries the two numbers, so a conversation that wants more
    // frames — or smaller ones — gets them, and the defaults are what the fixtures above use.
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: gifBytes() }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "如实说明这条消息里的媒体内容。",
      frames: 1,
      maxDimension: 64,
    });
    await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" });
    // One frame means the first frame, which is also the regression the sampling fix pinned.
    expect(calls[0]?.images).toHaveLength(1);
    const payload = sampledFramesPayload(calls[0]?.prompt ?? "");
    expect(payload.sampled_frames.suppliedCount).toBe(1);
    expect(payload.sampled_frames.truncated).toBe(true);
    expect(payload.sampled_frames.frames).toEqual([{ index: 0, sourceTotal: 2 }]);
  });

  it("refuses a sampling request it cannot honour", () => {
    // Zero frames would be a silent empty picture; the adapter validates rather than guessing.
    expect(() =>
      createQqMediaAdapter({
        fetchSource: async () => ({ bytes: PNG }),
        agentRuntime: createEphemeralAgentRuntime({ vision: visionClient().client }),
        prompt: "如实说明这条消息里的媒体内容。",
        frames: 0,
      }),
    ).toThrow();
    expect(() =>
      createQqMediaAdapter({
        fetchSource: async () => ({ bytes: PNG }),
        agentRuntime: createEphemeralAgentRuntime({ vision: visionClient().client }),
        prompt: "如实说明这条消息里的媒体内容。",
        maxDimension: 4096,
      }),
    ).toThrow();
  });

  it("sends a still picture as itself", async () => {
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: PNG }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "说明媒体",
    });
    await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" });
    expect(calls[0]?.images.map((image) => image.mimeType)).toEqual(["image/png"]);
    // A still is the whole picture: no sampling suffix is appended, the prompt travels as-is.
    expect(calls[0]?.prompt).toBe("说明媒体");
  });

  it("keeps the original bytes of an ordinary still without degrading it", async () => {
    const { calls, client } = visionClient();
    const original = encodeQqFramePng(new Uint8Array(700 * 400 * 4).fill(0x20), 700, 400);
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: original }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "说明媒体",
    });
    await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" });
    expect(calls).toHaveLength(1);
    // §7.4: 普通静图原图优先，不默认降画质 — the model sees the file it was given.
    expect(calls[0]?.images.map((image) => image.mimeType)).toEqual(["image/png"]);
    expect(calls[0]?.images[0]?.bytes).toEqual(original);
  });

  it("refuses an animated APNG as unsupported instead of a fake first frame", async () => {
    // The animated hint is header-only (signature + IHDR + acTL); the negative path is the adapter's refusal.
    const chunk = (type: string, payload: Uint8Array): Uint8Array => {
      const out = new Uint8Array(12 + payload.length);
      new DataView(out.buffer).setUint32(0, payload.length);
      for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
      out.set(payload, 8);
      let crc = 0xffffffff;
      for (const byte of out.subarray(4, 8 + payload.length)) {
        crc ^= byte;
        for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      new DataView(out.buffer).setUint32(8 + payload.length, (crc ^ 0xffffffff) >>> 0);
      return out;
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 8);
    new DataView(ihdr.buffer).setUint32(4, 8);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("acTL", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0])), // num_frames=1, num_plays=0 — presence makes it animated.
      chunk("IEND", new Uint8Array(0)),
    ];
    const apng = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      apng.set(part, at);
      at += part.length;
    }
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: apng }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "说明媒体",
    });
    const failure = await adapter
      .read({ kind: "image", sourceRef: "ref", model: "vision-local" })
      .then(
        (value) => {
          throw new Error(`animated APNG read returned ${value}`);
        },
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(QqImagePrepareError);
    expect((failure as QqImagePrepareError).reason).toBe("unsupported_animation");
    expect((failure as Error).message).toMatch(/APNG/);
    // No picture was ever handed to a model for a format we cannot honestly sample.
    expect(calls).toHaveLength(0);
  });

  it("refuses an animated WebP as unsupported instead of a fake first frame", async () => {
    // A real animated WebP container (VP8X with the animation flag 0x02 set) — the same
    // synthetic bytes the codec test uses, fed through the adapter's production path.
    const animatedWebp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x2c,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50, // RIFF....WEBP
      0x56,
      0x50,
      0x38,
      0x58,
      0x0e,
      0x00,
      0x00,
      0x00, // "VP8X" chunk, 14 bytes
      0x02,
      0x00,
      0x00,
      0x00, // flags: animation bit set
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00, // canvas 1x1
      0x41,
      0x4e,
      0x49,
      0x4d,
      0x06,
      0x00,
      0x00,
      0x00, // "ANIM" chunk, 6 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: animatedWebp }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "说明媒体",
    });
    const failure = await adapter
      .read({ kind: "image", sourceRef: "ref", model: "vision-local" })
      .then(
        (value) => {
          throw new Error(`animated WebP read returned ${value}`);
        },
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(QqImagePrepareError);
    expect((failure as QqImagePrepareError).reason).toBe("unsupported_animation");
    expect((failure as Error).message).toMatch(/WebP/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces an abort between fetch and prepare with the caller's reason", async () => {
    // The stub fetch resolves before the read continues, so the abort is observed at the post-fetch re-check, not inside a codec worker.
    const controller = new AbortController();
    const gif = (() => {
      const width = 256;
      const height = 256;
      const buffer = new Uint8Array(width * height * 8 * 4 + 4096 + 768);
      const writer = new upstream.GifWriter(buffer, width, height, {
        palette: [0xff0000, 0x00ff00],
        loop: 0,
      });
      for (let index = 0; index < 8; index += 1) {
        writer.addFrame(0, 0, width, height, new Array(width * height).fill(index % 2), {
          delay: 10,
          disposal: 2,
        });
      }
      return buffer.slice(0, writer.end());
    })();
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: gif }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "说明媒体",
    });
    const pending = adapter.read({
      kind: "image",
      sourceRef: "ref",
      model: "vision-local",
      signal: controller.signal,
    });
    controller.abort(new Error("media read gave up"));
    const failure = await pending.then(
      (value) => {
        throw new Error(`cancelled media read returned ${value}`);
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("media read gave up");
    expect(calls).toHaveLength(0);
  });

  it("states finite-frame sampling facts in the prompt when the animation is truncated", async () => {
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: gifBytes(4) }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
      prompt: "说明媒体",
    });
    await adapter.read({
      kind: "image",
      sourceRef: "upstream-ref",
      model: "vision-local",
      source: { kind: "qq_media", id: "media-row-1", revision: "1" },
    });
    expect(calls[0]?.images).toHaveLength(3);
    for (const frame of calls[0]?.images ?? []) {
      expect(frame.mimeType).toBe("image/png");
      expect(frame.bytes.byteLength).toBeGreaterThan(0);
    }
    const payload = sampledFramesPayload(calls[0]?.prompt ?? "");
    // A read that carries the real media reference names it, not a hash of the transport ref.
    expect(payload.sampled_frames.source).toBe("media-row-1");
    expect(payload.sampled_frames.suppliedCount).toBe(3);
    expect(payload.sampled_frames.truncated).toBe(true);
    expect(payload.sampled_frames.frames).toEqual([
      { index: 0, sourceTotal: 4 },
      { index: 2, sourceTotal: 4 },
      { index: 3, sourceTotal: 4 },
    ]);
    expect(calls[0]?.prompt.startsWith("说明媒体")).toBe(true);
    expect(calls[0]?.prompt).not.toMatch(/data:|file:\/\//);
  });

  it("refuses voice and video loudly instead of writing a description", async () => {
    const { calls, client } = visionClient();
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: PNG }),
      agentRuntime: createEphemeralAgentRuntime({ vision: client }),
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
      agentRuntime: createEphemeralAgentRuntime({ vision: visionClient().client }),
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
          capabilities: ["image"] as const,
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
        { capabilities: ["image"] as const, read: async () => "第二张的说明" },
        cycleInput,
      );
      expect(second).toEqual({
        kind: "read",
        segmentIndex: 1,
        result: { kind: "described", attempt: 1 },
      });
      expect(
        await readQqAddressedMediaOnce(
          h.orm,
          { capabilities: ["image"] as const, read: async () => "不该再读" },
          cycleInput,
        ),
      ).toEqual({ kind: "idle", reason: "all_described" });
    } finally {
      h.close();
    }
  });

  it("reports idle when the message carried no media at all", async () => {
    const h = fixture("image", 0);
    try {
      expect(
        await readQqAddressedMediaOnce(
          h.orm,
          { capabilities: ["image"] as const, read: async () => "不该读" },
          cycleInput,
        ),
      ).toEqual({ kind: "idle", reason: "no_media" });
    } finally {
      h.close();
    }
  });

  it("skips a segment the adapter cannot read and reads the next readable one", async () => {
    const h = fixture("record", 1);
    try {
      // 同一条消息：先是一条语音（声明读不了），后是一张图。
      recordMediaSegment(h.orm, {
        eventKey: "media-1",
        segmentIndex: 1,
        kind: "image",
        sourceRef: "upstream-ref-image",
        occurredAtSeconds: Math.floor(Date.now() / 1000),
        addressed: true,
      });
      const seen: string[] = [];
      const result = await readQqAddressedMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async ({ sourceRef }) => {
            seen.push(sourceRef);
            return "图里的说明";
          },
        },
        cycleInput,
      );
      // 语音不消耗尝试也不入选；这一轮读的是那张图。
      expect(result).toEqual({
        kind: "read",
        segmentIndex: 1,
        result: { kind: "described", attempt: 1 },
      });
      expect(seen).toEqual(["upstream-ref-image"]);
      expect(mediaNoteRow(h.orm, "media-1", 0)).toMatchObject({ attempts: 0, note: null });
    } finally {
      h.close();
    }
  });

  it("reports unsupported media as idle instead of attempting it", async () => {
    const h = fixture("video", 1);
    try {
      let calls = 0;
      expect(
        await readQqAddressedMediaOnce(
          h.orm,
          {
            capabilities: ["image"] as const,
            read: async () => {
              calls++;
              return "不该读";
            },
          },
          cycleInput,
        ),
      ).toEqual({ kind: "idle", reason: "unsupported_kind" });
      expect(calls).toBe(0);
      expect(mediaNoteRow(h.orm, "media-1", 0)).toMatchObject({ attempts: 0, note: null });
    } finally {
      h.close();
    }
  });
});
