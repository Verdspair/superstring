import { isDeepStrictEqual } from "node:util";

const OWNER_NAME = "superstring";

type Document = Record<string, unknown>;

function record(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw Object.assign(new Error("NapCat owned network configuration is invalid"), {
    code: "NAPCAT_NETWORK_CONFIG_INVALID",
  });
}

function ownedFields(desired: { readonly endpoint: string; readonly token: string }): Document {
  let endpoint: URL;
  try {
    endpoint = new URL(desired.endpoint);
  } catch {
    return invalid();
  }
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.port === "" ||
    !desired.token.trim() ||
    /[\r\n]/.test(desired.token)
  )
    return invalid();
  return {
    name: OWNER_NAME,
    enable: true,
    host: "127.0.0.1",
    port: Number(endpoint.port),
    messagePostFormat: "array",
    reportSelfMessage: false,
    token: desired.token,
    heartInterval: 30000,
  };
}

function servers(config: Readonly<Document>): { network: Document; entries: Document[] } {
  const network = config.network;
  if (!record(network) || !Array.isArray(network.websocketServers)) return invalid();
  const entries = network.websocketServers;
  if (!entries.every(record)) return invalid();
  if (entries.filter((entry) => entry.name === OWNER_NAME).length > 1) return invalid();
  return { network, entries };
}

/** Preserve the vendor document; only the named application-owned listener is changed. */
export function mergeNapCatOneBotConfig(
  current: Readonly<Document>,
  desired: { readonly endpoint: string; readonly token: string },
): { readonly config: Document; readonly changed: boolean } {
  const fields = ownedFields(desired);
  const { network, entries } = servers(current);
  const index = entries.findIndex((entry) => entry.name === OWNER_NAME);
  const occupied = entries.filter(
    (entry) =>
      entry.name !== OWNER_NAME &&
      entry.enable === true &&
      entry.port === fields.port &&
      ["127.0.0.1", "0.0.0.0", "::", "localhost"].includes(String(entry.host)),
  );
  if (occupied.length > 0) {
    const exact =
      occupied.length === 1 &&
      ["host", "port", "token", "messagePostFormat", "reportSelfMessage"].every(
        (key) => occupied[0]?.[key] === fields[key],
      );
    if (!exact || index >= 0)
      throw Object.assign(new Error("NapCat listener configuration conflicts"), {
        code: "NAPCAT_NETWORK_LISTENER_CONFLICT",
      });
    return { config: { ...current }, changed: false };
  }
  const nextEntries = [...entries];
  if (index < 0) nextEntries.push({ ...fields, enableForcePushEvent: true, debug: false });
  else nextEntries[index] = { ...entries[index], ...fields };
  const config = { ...current, network: { ...network, websocketServers: nextEntries } };
  return { config, changed: !isDeepStrictEqual(config, current) };
}

/** A successful write response is not proof that the full working configuration survived. */
export function verifyNapCatOneBotConfig(
  before: Readonly<Document>,
  readback: Readonly<Document>,
  desired: { readonly endpoint: string; readonly token: string },
): boolean {
  try {
    const expected = mergeNapCatOneBotConfig(before, desired).config;
    return isDeepStrictEqual(expected, readback);
  } catch {
    return false;
  }
}
