// T09：ImageByteResolver —— 字节只在 wire 边界，resolver 只接受 host 登记句柄。
// 断言：register→resolve 短生命周期取字节；跨 run/owner 伪句柄拒绝；release 清 run 关联；
// assertCurrent 失效即拒；resolve 结果是 VisionImage（mimeType+bytes），不含 URL/路径。
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createImageByteResolver } from "../../src/server/agent/image-byte-resolver";
import type { ModelContent, RunOwner } from "../../src/shared/contracts/agent-run";

const BYTES = new Uint8Array([9, 8, 7]);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const OWNER: RunOwner = { kind: "qq_group", id: "conv-9" };
const OTHER: RunOwner = { kind: "web", id: "conv-x" };

const part: ModelContent = {
  kind: "image",
  sourceId: "asset-1",
  revision: "r7",
  mimeType: "image/png",
  sha256: SHA,
};

function registered(assertCurrent: () => void = () => {}) {
  const resolver = createImageByteResolver();
  resolver.register({
    runId: "run-A",
    owner: OWNER,
    part,
    bytes: BYTES,
    sources: [{ kind: "qq_media", id: "asset-1", revision: "r7" }],
    assertCurrent,
  });
  return resolver;
}

describe("ImageByteResolver", () => {
  it("登记句柄可按 run/owner+part 解析出字节", async () => {
    const resolver = registered();
    const image = await resolver.resolve({
      runId: "run-A",
      owner: OWNER,
      part,
      signal: new AbortController().signal,
    });
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toBe(BYTES);
  });

  it("未登记的 run/owner/part 组合拒绝（host 句柄之外没有第二入口）", async () => {
    const resolver = registered();
    const wrong = {
      runId: "run-A",
      owner: OTHER,
      part,
      signal: new AbortController().signal,
    };
    await expect(resolver.resolve(wrong)).rejects.toThrow();
    const wrongRun = {
      runId: "run-B",
      owner: OWNER,
      part,
      signal: new AbortController().signal,
    };
    await expect(resolver.resolve(wrongRun)).rejects.toThrow();
    const wrongPart = {
      runId: "run-A",
      owner: OWNER,
      part: { ...part, sha256: "0".repeat(64) },
      signal: new AbortController().signal,
    };
    await expect(resolver.resolve(wrongPart)).rejects.toThrow();
  });

  it("release 清 run 关联：释放后句柄失效", async () => {
    const resolver = registered();
    resolver.release("run-A", OWNER);
    await expect(
      resolver.resolve({
        runId: "run-A",
        owner: OWNER,
        part,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(
      resolver.resolve({
        runId: "run-A",
        owner: OTHER,
        part,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("assertCurrent 失效即拒绝：字节不发给失效来源", async () => {
    let current = true;
    const resolver = registered(() => {
      if (!current) throw new Error("source revoked");
    });
    await expect(
      resolver.resolve({
        runId: "run-A",
        owner: OWNER,
        part,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeTruthy();
    current = false;
    await expect(
      resolver.resolve({
        runId: "run-A",
        owner: OWNER,
        part,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("resolve 期间取消的 signal 使后续解析拒绝", async () => {
    const resolver = registered();
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolver.resolve({ runId: "run-A", owner: OWNER, part, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
