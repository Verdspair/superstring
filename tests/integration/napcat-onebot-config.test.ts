import { describe, expect, it } from "bun:test";
import {
  mergeNapCatOneBotConfig,
  verifyNapCatOneBotConfig,
} from "../../src/server/napcat/onebot-config";

const desired = { endpoint: "ws://127.0.0.1:3001/", token: "synthetic-onebot-secret" };
const owned = {
  name: "superstring",
  enable: true,
  host: "127.0.0.1",
  port: 3001,
  messagePostFormat: "array",
  reportSelfMessage: false,
  token: desired.token,
  enableForcePushEvent: true,
  debug: false,
  heartInterval: 30000,
};

function fixture() {
  return {
    unknownRoot: { retained: ["one", { two: true }] },
    network: {
      httpServers: [{ name: "other-http", enable: true, vendorExtra: 17 }],
      websocketServers: [
        { name: "other-ws", enable: true, host: "127.0.0.1", port: 3500, unknown: "keep" },
      ] as Record<string, unknown>[],
      websocketClients: [{ name: "other-client", url: "ws://synthetic.invalid", unknown: true }],
      unknownNetwork: [1, 2],
    },
  };
}

describe("NapCat owned OneBot configuration", () => {
  it("adds only its own server and retains every unknown value and unowned entry", () => {
    const current = fixture();
    const original = structuredClone(current);
    const result = mergeNapCatOneBotConfig(current, desired);
    expect(result.changed).toBe(true);
    expect(result.config).toEqual({
      ...original,
      network: {
        ...original.network,
        websocketServers: [...original.network.websocketServers, owned],
      },
    });
    expect(current).toEqual(original);
    expect(verifyNapCatOneBotConfig(current, result.config, desired)).toBe(true);
  });

  it("updates one owned entry in place without changing unknown properties or list order", () => {
    const current = fixture();
    const before = current.network.websocketServers[0];
    const after = { name: "following", enable: false, preserved: [1, 2] };
    const config = {
      ...current,
      network: {
        ...current.network,
        websocketServers: [
          before,
          {
            ...owned,
            port: 3002,
            token: "old",
            enableForcePushEvent: false,
            debug: true,
            futureField: true,
          },
          after,
        ],
      },
    };
    const result = mergeNapCatOneBotConfig(config, desired);
    expect(result.changed).toBe(true);
    expect((result.config.network as typeof config.network).websocketServers).toEqual([
      before,
      { ...owned, enableForcePushEvent: false, debug: true, futureField: true },
      after,
    ]);
    expect(verifyNapCatOneBotConfig(config, result.config, desired)).toBe(true);
    expect(mergeNapCatOneBotConfig(result.config, desired).changed).toBe(false);
  });

  it("does not treat code-zero or an owned-only projection as preserved readback", () => {
    const current = fixture();
    const merged = mergeNapCatOneBotConfig(current, desired).config;
    expect(
      verifyNapCatOneBotConfig(current, { network: { websocketServers: [owned] } }, desired),
    ).toBe(false);
    const wrong = structuredClone(merged);
    (
      (wrong.network as Record<string, unknown>).websocketServers as Record<string, unknown>[]
    )[1]!.port = 3002;
    expect(verifyNapCatOneBotConfig(current, wrong, desired)).toBe(false);
    const stripped = structuredClone(merged);
    delete stripped.unknownRoot;
    expect(verifyNapCatOneBotConfig(current, stripped, desired)).toBe(false);
  });

  it("refuses malformed or ambiguous ownership instead of replacing whole arrays", () => {
    for (const config of [
      {},
      { network: [] },
      { network: { websocketServers: "not-an-array" } },
      { network: { websocketServers: [null] } },
      { network: { websocketServers: [owned, owned] } },
    ]) {
      expect(() => mergeNapCatOneBotConfig(config, desired)).toThrow();
    }
  });

  it("rejects external endpoints, credentials, queries and unsupported listener paths", () => {
    for (const endpoint of [
      "ws://192.0.2.1:3001/",
      "wss://127.0.0.1:3001/",
      "ws://user:password@127.0.0.1:3001/",
      "ws://127.0.0.1:3001/?token=secret",
      "ws://127.0.0.1:3001/#secret",
      "ws://127.0.0.1:3001/unsupported",
    ]) {
      expect(() => mergeNapCatOneBotConfig(fixture(), { ...desired, endpoint })).toThrow();
    }
    for (const token of ["", " ", "bad\nsecret"]) {
      expect(() => mergeNapCatOneBotConfig(fixture(), { ...desired, token })).toThrow();
    }
  });
});

describe("NapCat existing listener preservation", () => {
  it("reuses an exact existing listener without taking its name or writing a duplicate", () => {
    const current = fixture();
    const existing = { ...owned, name: "existing-official-listener", future: true };
    current.network.websocketServers = [existing];
    const original = structuredClone(current);
    const result = mergeNapCatOneBotConfig(current, desired);
    expect(result.changed).toBe(false);
    expect(result.config).toEqual(original);
    expect(verifyNapCatOneBotConfig(current, current, desired)).toBe(true);
    expect(current).toEqual(original);
  });

  it("refuses a conflicting enabled listener without changing or deleting it", () => {
    for (const patch of [
      { token: "different" },
      { messagePostFormat: "string" },
      { reportSelfMessage: true },
      { host: "0.0.0.0" },
    ]) {
      const current = fixture();
      current.network.websocketServers = [{ ...owned, name: "unowned", ...patch }];
      const original = structuredClone(current);
      expect(() => mergeNapCatOneBotConfig(current, desired)).toThrow();
      expect(current).toEqual(original);
    }
  });
});
