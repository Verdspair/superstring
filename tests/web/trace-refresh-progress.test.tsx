import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  RuntimeTrace,
  RuntimeTracesPage,
} from "../../src/shared/contracts/runtime-observability";
import type { SuperstringApi } from "../../src/web/api";
import { useRuntimeTraces } from "../../src/web/features/observability/use-runtime-traces";
import { resetConversationChangesForTests } from "../../src/web/services/conversation-changes";
import { setupLibrary } from "./helpers/library-fixture";

const trace = (id: number): RuntimeTrace => ({
  traceId: String(id),
  cursorId: id,
  causes: [],
  specIds: [],
  root: {
    id,
    traceId: String(id),
    spanId: String(id),
    parentSpanId: null,
    name: "synthetic",
    at: "2026-10-08T00:00:00Z",
    finishedAt: null,
    durationMs: null,
    channel: "web",
    stage: "model",
    status: "started",
    code: "",
    model: null,
    conversationId: null,
    agentId: null,
    runId: null,
    wakeId: null,
    outputId: null,
    sourceSeq: null,
    details: {},
  },
  at: "2026-10-08T00:00:00Z",
  lastActivityAt: "2026-10-08T00:00:00Z",
  finishedAt: null,
  durationMs: 0,
  status: "started",
  spanCount: 1,
  matchedSpanCount: 1,
  models: [],
  channels: ["web"],
  runIds: [],
  wakeIds: [],
});
const summary: RuntimeTracesPage["summary"] = {
  totalTraces: 200,
  activeTraces: 200,
  failedTraces: 0,
  matchedSpans: 200,
  lastActivityAt: null,
  now: "2026-10-08T00:00:00Z",
};
const page = (
  items: RuntimeTrace[],
  nextBeforeId: number,
  hasMore: boolean,
): RuntimeTracesPage => ({ items, nextBeforeId, hasMore, summary });
function Probe({ active = true }: { active?: boolean }) {
  const result = useRuntimeTraces({}, false, active);
  return (
    <>
      <button type="button" onClick={result.loadMore}>
        More
      </button>
      <button type="button" onClick={result.refresh}>
        Refresh
      </button>
      {result.items.map((item) => (
        <span key={item.traceId}>
          {item.traceId}:{item.root.name}
        </span>
      ))}
    </>
  );
}
afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
});
it("publishes the refreshed trace head through the shared owner before a slow tail finishes", async () => {
  const first = Array.from({ length: 100 }, (_, i) => trace(300 - i));
  const second = Array.from({ length: 100 }, (_, i) => trace(200 - i));
  let head!: (value: RuntimeTracesPage) => void;
  let tail!: (value: RuntimeTracesPage) => void;
  const list = vi
    .fn<SuperstringApi["listRuntimeTraces"]>()
    .mockResolvedValueOnce(page(first, 200, true))
    .mockResolvedValueOnce(page(second, 100, false))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          head = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          tail = resolve;
        }),
    );
  setupLibrary({ listRuntimeTraces: list });
  render(<Probe />);
  await waitFor(() => expect(screen.getByText("300:synthetic")).toBeTruthy());
  fireEvent.click(screen.getByText("More"));
  await waitFor(() => expect(screen.getByText("101:synthetic")).toBeTruthy());
  fireEvent.click(screen.getByText("Refresh"));
  await act(async () => {
    head(
      page(
        first.map((item) => ({ ...item, root: { ...item.root, name: "updated" } })),
        200,
        true,
      ),
    );
  });
  expect(screen.getByText("300:updated")).toBeTruthy();
  expect(screen.getByText("101:synthetic")).toBeTruthy();
  await act(async () => {
    tail(page(second, 100, false));
  });
  expect(list).toHaveBeenCalledTimes(4);
  expect(screen.getByText("101:synthetic")).toBeTruthy();
});
