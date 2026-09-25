// P2h: the transport credential at rest (ADR0018).
//
// Two properties matter and neither is visible from the outside. First, the token must
// not be readable in the database file — a local credential for a locally listening
// service is still a credential. Second, a token whose ciphertext no longer
// authenticates (a regenerated key file, a tampered row) must read as "not configured"
// rather than as some mangled string, because a broken credential that is used anyway
// produces a baffling failure much later.
//
// Key files live in a per-test temp directory, so nothing here touches a real key.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeTransportEndpoint,
  readQqConnectionConfig,
  readQqSettings,
  readQqTransportConfigView,
  readTransportToken,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { openSecret, sealSecret, transportSecret } from "../../src/server/secret-box";

const TOKEN = "synthetic-onebot-token";
const ENDPOINT = "ws://127.0.0.1:3000/";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-secret-"));
  const keyPath = path.join(dir, "qq-transport.key");
  const business = openBusinessDb();
  // The account id is part of the saved configuration, so a complete setup has one.
  const seeded = readQqSettings(business.orm);
  updateQqSettings(business.orm, {
    accountId: "10001",
    expectedRevision: seeded.revision,
  });
  return {
    orm: business.orm,
    db: business.db,
    keyPath,
    close: () => {
      business.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Setup = ReturnType<typeof setup>;

/** Save a complete configuration (endpoint + token), resetting nothing else. */
function configure(
  h: Setup,
  patch: { endpoint?: string | null; token?: string | null; keyPath?: string } = {},
) {
  return updateQqTransportConfig(h.orm, {
    endpoint: patch.endpoint === undefined ? ENDPOINT : patch.endpoint,
    token: patch.token === undefined ? TOKEN : patch.token,
    expectedRevision: readQqSettings(h.orm).revision,
    keyPath: patch.keyPath ?? h.keyPath,
  });
}

/**
 * Change only the fields named. Omitting a field means "leave it alone", which is the
 * whole point of the three-state token (absent / null / value).
 */
function patchConfig(
  h: Setup,
  patch: { endpoint?: string | null; token?: string | null; keyPath?: string } = {},
) {
  const update: Parameters<typeof updateQqTransportConfig>[1] = {
    expectedRevision: readQqSettings(h.orm).revision,
    keyPath: patch.keyPath ?? h.keyPath,
  };
  if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
  if (patch.token !== undefined) update.token = patch.token;
  return updateQqTransportConfig(h.orm, update);
}

describe("sealing a secret", () => {
  it("round-trips through the key file and produces a self-describing value", () => {
    const h = setup();
    try {
      const secret = transportSecret(h.keyPath);
      const sealed = sealSecret(TOKEN, secret);
      expect(sealed.startsWith("v1.")).toBe(true);
      expect(sealed).not.toContain(TOKEN);
      expect(openSecret(sealed, secret)).toBe(TOKEN);
      // The same plaintext seals differently every time (fresh IV).
      expect(sealSecret(TOKEN, secret)).not.toBe(sealed);
      // The key file was created with the project's own permission discipline.
      expect(readFileSync(h.keyPath, "ascii").length).toBeGreaterThan(0);
      expect(transportSecret(h.keyPath)).toBe(secret);
    } finally {
      h.close();
    }
  });

  it("returns null for a tampered payload instead of a mangled string", () => {
    const h = setup();
    try {
      const secret = transportSecret(h.keyPath);
      const sealed = sealSecret(TOKEN, secret);
      const parts = sealed.split(".");
      // Flip a BYTE of the ciphertext. Flipping a base64 character instead is unreliable:
      // the final character carries unused padding bits, so some changes decode to the
      // very same bytes and the check would pass without testing anything.
      const body = Buffer.from(parts[3] ?? "", "base64url");
      const first = body[0] ?? 0;
      body[0] = first ^ 0x01;
      const tampered = [parts[0], parts[1], parts[2], body.toString("base64url")].join(".");
      expect(openSecret(tampered, secret)).toBeNull();
      // A flipped authentication tag is refused too.
      const tag = Buffer.from(parts[2] ?? "", "base64url");
      tag[0] = (tag[0] ?? 0) ^ 0x01;
      expect(
        openSecret([parts[0], parts[1], tag.toString("base64url"), parts[3]].join("."), secret),
      ).toBeNull();
      // A different key cannot open it either.
      const other = transportSecret(path.join(path.dirname(h.keyPath), "other.key"));
      expect(openSecret(sealed, other)).toBeNull();
      // Malformed input is refused rather than guessed at.
      expect(openSecret("not-sealed", secret)).toBeNull();
      expect(openSecret("v9.a.b.c", secret)).toBeNull();
      expect(openSecret("v1..b.c", secret)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("refuses to seal an empty secret", () => {
    const h = setup();
    try {
      expect(() => sealSecret("", transportSecret(h.keyPath))).toThrow();
    } finally {
      h.close();
    }
  });
});

describe("the saved transport configuration", () => {
  it("keeps the token out of the row and out of the settings view", () => {
    const h = setup();
    try {
      configure(h);
      const row = readQqSettings(h.orm);
      expect(row.endpoint).toBe(ENDPOINT);
      expect(row.tokenCiphertext).not.toBeNull();
      // The stored column never contains the token itself.
      expect(row.tokenCiphertext).not.toContain(TOKEN);
      // A settings surface learns only whether a token exists.
      expect(readQqTransportConfigView(h.orm, h.keyPath)).toEqual({
        endpoint: ENDPOINT,
        hasToken: true,
      });
      // The runtime-facing read is the only place the plaintext appears.
      expect(readQqConnectionConfig(h.orm, h.keyPath)).toEqual({
        endpoint: ENDPOINT,
        token: TOKEN,
        accountId: "10001",
      });
    } finally {
      h.close();
    }
  });

  it("treats a token whose key changed as not configured", () => {
    const h = setup();
    try {
      configure(h);
      // Regenerating the key file models a reinstall or a manual key rotation.
      const rotated = path.join(path.dirname(h.keyPath), "rotated.key");
      expect(readTransportToken(h.orm, rotated)).toBeNull();
      expect(readQqTransportConfigView(h.orm, rotated)).toEqual({
        endpoint: ENDPOINT,
        hasToken: false,
      });
      // The row is untouched: nothing was silently rewritten.
      expect(readQqSettings(h.orm).tokenCiphertext).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("distinguishes leaving the token alone from removing it", () => {
    const h = setup();
    try {
      configure(h);
      // Omitting the token leaves it alone: only the endpoint moves.
      patchConfig(h, { endpoint: "ws://127.0.0.1:4000/" });
      expect(readTransportToken(h.orm, h.keyPath)).toBe(TOKEN);
      expect(readQqSettings(h.orm).endpoint).toBe("ws://127.0.0.1:4000/");
      // null = remove it, and the view stops claiming a token.
      patchConfig(h, { token: null });
      expect(readTransportToken(h.orm, h.keyPath)).toBeNull();
      expect(readQqTransportConfigView(h.orm, h.keyPath).hasToken).toBe(false);
      // The endpoint survives a token removal.
      expect(readQqSettings(h.orm).endpoint).toBe("ws://127.0.0.1:4000/");
    } finally {
      h.close();
    }
  });

  it("refuses a stale revision and an unchanged save keeps the revision", () => {
    const h = setup();
    try {
      const saved = configure(h);
      expect(() =>
        updateQqTransportConfig(h.orm, {
          endpoint: "ws://127.0.0.1:5000/",
          expectedRevision: saved.revision - 1,
          keyPath: h.keyPath,
        }),
      ).toThrow();
      // Saving the same values again is a no-op.
      const again = configure(h);
      expect(again.revision).toBe(saved.revision);
      // The account id and switch are untouched by a transport save.
      expect(readQqSettings(h.orm).enabled).toBe(0);
      expect(readQqSettings(h.orm).accountId).toBe("10001");
    } finally {
      h.close();
    }
  });

  it("validates the endpoint the way the transport will", () => {
    const h = setup();
    try {
      expect(normalizeTransportEndpoint("ws://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000/");
      expect(normalizeTransportEndpoint("  wss://example.invalid/onebot  ")).toBe(
        "wss://example.invalid/onebot",
      );
      // Anything the transport would reject, or that smuggles a credential, is refused.
      for (const bad of [
        "http://127.0.0.1:3000/",
        "ws://user:pass@127.0.0.1:3000/",
        "ws://127.0.0.1:3000/?token=abc",
        "ws://127.0.0.1:3000/#frag",
        "not a url",
        "",
      ]) {
        expect(() => normalizeTransportEndpoint(bad)).toThrow();
      }
      // A rejected endpoint leaves the saved row alone.
      configure(h);
      expect(() =>
        updateQqTransportConfig(h.orm, {
          endpoint: "http://127.0.0.1:3000/",
          expectedRevision: readQqSettings(h.orm).revision,
          keyPath: h.keyPath,
        }),
      ).toThrow();
      expect(readQqSettings(h.orm).endpoint).toBe(ENDPOINT);
    } finally {
      h.close();
    }
  });

  it("reads as not configured until every piece is present", () => {
    const h = setup();
    try {
      expect(readQqConnectionConfig(h.orm, h.keyPath)).toBeNull();
      // An endpoint alone is not enough.
      patchConfig(h, { endpoint: ENDPOINT, token: null });
      expect(readQqConnectionConfig(h.orm, h.keyPath)).toBeNull();
      // A token alone is not enough.
      patchConfig(h, { endpoint: null, token: TOKEN });
      expect(readQqConnectionConfig(h.orm, h.keyPath)).toBeNull();
      // Both together, with the account already saved, is complete.
      configure(h);
      expect(readQqConnectionConfig(h.orm, h.keyPath)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("never writes the token into the database file's plain bytes", () => {
    const h = setup();
    try {
      configure(h);
      // Read the raw page image, which is what a copied database file exposes.
      const raw = h.db.serialize();
      expect(Buffer.from(raw).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
      expect(h.orm.select().from(schema.qqSettings).get()?.tokenCiphertext).not.toContain(TOKEN);
    } finally {
      h.close();
    }
  });
});
