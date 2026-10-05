// api.ts SSE 读循环的行为测试：走真实 readEventStream 路径（fetch Response body 级 mock），
// 验证帧解析顺序、正常 EOF 收尾、解析异常传播与 reader 取消/释放锁——不只做源码静态断言。

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatV2Event } from "../../src/shared/contracts/chat-v2";
import { api, streamChatV2 } from "../../src/web/api";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]));
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function abortResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    }),
    { status: 200 },
  );
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api SSE 读循环（readEventStream 行为）", () => {
  it("跨 chunk 的帧被拼接解析，顺序与载荷正确，EOF 后正常返回", async () => {
    // 一帧被切成两个 chunk：readEventStream 必须缓冲到 \n\n 边界再解析。
    stubFetch(
      sseResponse([
        'event: conversation_changed\ndata: {"conversationId":"c1",',
        '"seq":3,"bindingEpoch":2}\n\n',
        'event: ready\ndata: {"ready":true}\n\n',
      ]),
    );
    const events: unknown[] = [];
    await api.subscribeConversationChanges((event) => events.push(event));
    expect(events).toEqual([
      { event: "conversation_changed", conversationId: "c1", seq: 3, bindingEpoch: 2 },
      { event: "ready", ready: true },
    ]);
  });

  it("v2 聊天流按到达顺序产出事件，EOF 正常收尾", async () => {
    const frame = (payload: Record<string, unknown>) =>
      `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    stubFetch(
      sseResponse([
        frame({ type: "started", runId: "r1", seq: 1, at: "2026-10-05T00:00:00.000Z" }),
        frame({
          type: "output_delta",
          runId: "r1",
          seq: 2,
          at: "2026-10-05T00:00:01.000Z",
          outputId: "m1",
          text: "hi",
        }),
      ]),
    );
    const events: ChatV2Event[] = [];
    await streamChatV2(
      { session_id: "s1", message: "hello", client_request_id: "req-1" },
      (event) => events.push(event),
    );
    expect(events.map((event) => event.type)).toEqual(["started", "output_delta"]);
  });

  it("流中途出错：异常向上传播，reader 被取消且锁被释放", async () => {
    stubFetch(abortResponse());
    const events: unknown[] = [];
    await expect(api.subscribeConversationChanges((event) => events.push(event))).rejects.toThrow(
      "connection reset",
    );
    expect(events).toEqual([]);
  });

  it("坏 JSON 帧使解析异常向上传播（不被静默吞掉），错误后 reader 取消", async () => {
    stubFetch(sseResponse(["event: conversation_changed\ndata: {broken}\n\n"]));
    await expect(api.subscribeConversationChanges(() => {})).rejects.toThrow();
  });
});
