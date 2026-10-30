import type { KnowledgeSettings } from "../../../shared/contracts/knowledge";
import { type ReadTask, startRead } from "../../services/read-task";
import type { StoreGet } from "../../state/types";

type Lease = {
  resolve(value: KnowledgeSettings): void;
  reject(reason: unknown): void;
  detach(): void;
};
type Flight = {
  api: ReturnType<StoreGet>["apiClient"];
  generation: number;
  task: ReadTask | null;
  leases: Set<Lease>;
};
const flights = new WeakMap<StoreGet, Flight>();
const cancelled = () => new Error("Knowledge settings read cancelled");

function settle(get: StoreGet, flight: Flight, result: KnowledgeSettings | Error) {
  if (flights.get(get) !== flight) return;
  flights.delete(get);
  flight.task?.cancel();
  flight.task = null;
  for (const lease of flight.leases) {
    lease.detach();
    if (result instanceof Error) lease.reject(result);
    else lease.resolve(result);
  }
  flight.leases.clear();
}

function start(get: StoreGet, flight: Flight) {
  const generation = ++flight.generation;
  flight.task?.cancel();
  flight.task = startRead((signal) => flight.api.getKnowledgeSettings(signal), {
    success: (value) => {
      if (flight.generation !== generation) return;
      if (get().apiClient !== flight.api) settle(get, flight, cancelled());
      else settle(get, flight, value);
    },
    failure: (reason) => {
      if (flight.generation === generation)
        settle(get, flight, reason instanceof Error ? reason : new Error(String(reason)));
    },
  });
}

/** One raw request per API. Drafts and saved baselines stay with their domain owners. */
export function readKnowledgeSettings(
  get: StoreGet,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<KnowledgeSettings> {
  if (options.signal?.aborted) return Promise.reject(cancelled());
  const api = get().apiClient;
  let flight = flights.get(get);
  if (flight && flight.api !== api) {
    settle(get, flight, cancelled());
    flight = undefined;
  }
  const created = !flight;
  if (!flight) {
    flight = { api, generation: 0, task: null, leases: new Set() };
    flights.set(get, flight);
  }
  const current = flight;
  const promise = new Promise<KnowledgeSettings>((resolve, reject) => {
    const abort = () => {
      current.leases.delete(lease);
      lease.detach();
      reject(cancelled());
      if (!current.leases.size && flights.get(get) === current) {
        flights.delete(get);
        current.task?.cancel();
        current.task = null;
      }
    };
    const lease: Lease = {
      resolve,
      reject,
      detach: () => options.signal?.removeEventListener("abort", abort),
    };
    current.leases.add(lease);
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  // Refresh replaces transport, not subscribers. No previous response can win the generation.
  if (created || options.force) start(get, current);
  return promise;
}

/** A committed revision supersedes any read begun before that commit. */
export function acceptKnowledgeSettings(
  get: StoreGet,
  api: ReturnType<StoreGet>["apiClient"],
  saved: KnowledgeSettings,
): void {
  const flight = flights.get(get);
  if (flight?.api === api) {
    flight.generation++;
    settle(get, flight, get().apiClient === api ? saved : cancelled());
  }
}

/** Store/API ownership changes dispose raw flights even when no screen remains mounted. */
export function cancelKnowledgeSettingsRead(get: StoreGet): void {
  const flight = flights.get(get);
  if (flight) {
    flight.generation++;
    settle(get, flight, cancelled());
  }
}
