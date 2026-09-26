import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ConversationListSchema } from "../../src/shared/contracts/conversation";
import type {
  ConversationAvatar,
  GeneratedAvatar,
} from "../../src/shared/contracts/conversation-avatar";
import type { SuperstringApi } from "../../src/web/api";
import { useConversationAvatar } from "../../src/web/features/conversations/use-conversation-avatar";
import { useSuperstringStore as store } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";

const original: GeneratedAvatar = { kind: "generated", style: "shapes", seed: "original" };
const selected: GeneratedAvatar = { kind: "generated", style: "rings", seed: "selected" };
const first = { ...summaryFixture("first"), avatar: original };
const second = summaryFixture("second");
function setup(client: Partial<SuperstringApi> = {}) {
  store
    .getState()
    .resetForTests({
      saveConversationAvatar: vi.fn(async () => selected),
      ...client,
    } as unknown as SuperstringApi);
  store.setState({
    summaryById: { [first.id]: first, [second.id]: second },
    directoryIds: [first.id, second.id],
    currentConversationId: first.id,
  });
  return renderHook(() => useConversationAvatar(first));
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("updates the original conversation after navigation, preserving the current conversation and all other metadata", async () => {
  const pending = Promise.withResolvers<ConversationAvatar>();
  const save = vi.fn(() => pending.promise);
  const { result } = setup({ saveConversationAvatar: save });
  let write: Promise<void>;
  act(() => {
    write = result.current.save(selected);
  });
  act(() => store.setState({ currentConversationId: second.id }));
  await act(async () => {
    pending.resolve(selected);
    await write;
  });
  expect(save).toHaveBeenCalledWith(first.id, selected);
  expect(store.getState().currentConversationId).toBe(second.id);
  expect(store.getState().summaryById[first.id]).toEqual({ ...first, avatar: selected });
  expect(store.getState().summaryById[second.id]).toEqual(second);
});

it("does not let an in-flight directory refresh restore the pre-save avatar", async () => {
  const pending = Promise.withResolvers<z.infer<typeof ConversationListSchema>>();
  const { result } = setup({ listConversations: vi.fn(() => pending.promise) });
  let read: Promise<boolean>;
  act(() => {
    read = store.getState().loadConversations();
  });
  await act(async () => {
    await result.current.save(selected);
  });
  await act(async () => {
    pending.resolve({ items: [first], nextCursor: null });
    expect(await read).toBe(false);
  });
  expect(result.current.value).toEqual(selected);
  expect(store.getState().directoryLoading).toBe(false);
});

it("retains the saved appearance when a write fails, so the editor can retry", async () => {
  const { result } = setup({
    saveConversationAvatar: vi.fn().mockRejectedValue(new Error("unavailable")),
  });
  await act(async () => {
    await expect(result.current.save(selected)).rejects.toThrow("unavailable");
  });
  expect(result.current.value).toEqual(original);
});

it("server reset overrides a stale prop with null rather than reviving its old appearance", async () => {
  const { result } = setup({ saveConversationAvatar: vi.fn(async () => null) });
  await act(async () => {
    await result.current.save(null);
  });
  expect(result.current.value).toBeNull();
});
