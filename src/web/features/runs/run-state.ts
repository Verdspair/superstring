import type {
  OutputSummary,
  RunEvent,
  RunSnapshot,
  RunStatus,
} from "../../../shared/contracts/agent-run";

export interface RunView {
  snapshot?: RunSnapshot;
  status: RunStatus;
  lastSeq: number;
  errorCode: string | null;
  dataStatus: "expired" | "revoked" | null;
  outputs: OutputSummary[];
  /** Live deltas only. A persisted message remains authoritative after reconnect. */
  outputTextById: Record<string, string>;
  pendingEvents: Record<number, RunEvent>;
}
export type RunById = Record<string, RunView>;
export const runOwnerKey = (kind: string, id: string) => JSON.stringify([kind, id]);

function emptyRun(): RunView {
  return {
    status: "prepared",
    lastSeq: 0,
    errorCode: null,
    dataStatus: null,
    outputs: [],
    outputTextById: {},
    pendingEvents: {},
  };
}

function applyEvent(view: RunView, event: RunEvent): RunView {
  const next = { ...view, lastSeq: event.seq };
  switch (event.type) {
    case "started":
      next.status = "prepared";
      break;
    case "step":
      next.status = "deciding";
      break;
    case "action_result":
      next.status = "observing";
      break;
    case "output_delta":
      next.status = "generating";
      if (view.dataStatus) break;
      next.outputTextById = {
        ...view.outputTextById,
        [event.outputId]: (view.outputTextById[event.outputId] ?? "") + event.text,
      };
      break;
    case "completed":
      next.status = "completed";
      next.outputs = event.outputs;
      break;
    case "no_output":
      next.status = "no_output";
      break;
    case "failed":
      next.status = "failed";
      next.errorCode = event.code;
      break;
    case "cancelled":
      next.status = "cancelled";
      break;
  }
  return next;
}

/** One reducer for every run event. Sequence numbers are local to their run. */
export function reduceRunEvent(runs: RunById, event: RunEvent): RunById {
  const current = runs[event.runId] ?? emptyRun();
  // Retention/revocation also purges data if a redacted event is replayed.
  const view = event.dataStatus
    ? { ...current, dataStatus: event.dataStatus, outputTextById: {}, pendingEvents: {} }
    : current;
  if (event.seq <= view.lastSeq) return view === current ? runs : { ...runs, [event.runId]: view };
  const retainedEvent =
    view.dataStatus && event.type === "output_delta" ? { ...event, text: "" } : event;
  let next = { ...view, pendingEvents: { ...view.pendingEvents, [event.seq]: retainedEvent } };
  while (next.pendingEvents[next.lastSeq + 1]) {
    const pending = next.pendingEvents[next.lastSeq + 1];
    delete next.pendingEvents[pending.seq];
    next = applyEvent(next, pending);
  }
  if (event.dataStatus) next.outputTextById = {};
  return { ...runs, [event.runId]: next };
}

export function mergeRunSnapshot(runs: RunById, snapshot: RunSnapshot): RunById {
  const current = runs[snapshot.runId] ?? emptyRun();
  if (current.lastSeq > snapshot.lastSeq) return runs;
  const pendingEvents = Object.fromEntries(
    Object.entries(current.pendingEvents).filter(([seq]) => Number(seq) > snapshot.lastSeq),
  );
  let next: RunView = {
    ...current,
    snapshot,
    status: snapshot.status,
    errorCode: snapshot.errorCode,
    outputs: snapshot.outputs,
    lastSeq: snapshot.lastSeq,
    pendingEvents,
  };
  while (next.pendingEvents[next.lastSeq + 1]) {
    const event = next.pendingEvents[next.lastSeq + 1];
    delete next.pendingEvents[event.seq];
    next = applyEvent(next, event);
  }
  return { ...runs, [snapshot.runId]: next };
}
