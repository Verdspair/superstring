import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { RuntimeConfig } from "../../shared/contracts";
import type { Evidence } from "../../shared/contracts/evidence";
import { contextDumps } from "../db/json-text";
import { DEFAULT_USER_ID } from "../db/repositories";
import { fail } from "../errors";
import type { EvidenceReadInput, EvidenceTextPage, MemoryQuery } from "./contracts";
import { estimateMessages } from "./memory-query";

const cursorSecret = randomBytes(32);
const memoryCursorKey = randomBytes(32);
const CursorSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["memory", "knowledge"]),
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.string().min(1).max(256),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  query: z.string().regex(/^[a-f0-9]{64}$/),
  after: z.strictObject({
    id: z.string().max(256),
    ordinal: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    original: z.boolean().optional(),
    score: z.number().int().nonnegative().optional(),
  }),
});
type Cursor = z.infer<typeof CursorSchema>;
export type EvidenceCursorBinding = Omit<Cursor, "version" | "after">;

export function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(contextDumps(value)).digest("hex");
}

export function assertEvidenceOwner(
  input: Pick<MemoryQuery, "owner" | "agentId">,
  runtime: RuntimeConfig,
): void {
  if (
    runtime.agent_id !== input.agentId ||
    (input.owner.agentId !== undefined && input.owner.agentId !== input.agentId) ||
    (input.owner.userId !== undefined && input.owner.userId !== DEFAULT_USER_ID)
  )
    fail("CONTEXT_INVALID_SELECTION", "资料读取身份与助手不匹配");
}

/** Shared signed envelope for server locators and cursors; never an authorization grant. */
export function sealEvidenceValue(value: unknown): string {
  const payload = JSON.stringify(value);
  return JSON.stringify({
    payload,
    mac: createHmac("sha256", cursorSecret).update(payload).digest("hex"),
  });
}

export function openEvidenceValue(value: string): unknown {
  try {
    if (value.length > 4096) throw new Error("Reference too long");
    const envelope = z
      .strictObject({ payload: z.string().max(3500), mac: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(value));
    const mac = createHmac("sha256", cursorSecret).update(envelope.payload).digest();
    if (!timingSafeEqual(mac, Buffer.from(envelope.mac, "hex")))
      throw new Error("Invalid signature");
    return JSON.parse(envelope.payload);
  } catch {
    fail("CONTEXT_INVALID_SELECTION", "资料引用无效");
  }
}

/** Memory cursors hide scan positions; neither cursor form grants authority. */
export function evidenceCursor(binding: EvidenceCursorBinding, after: Cursor["after"]): string {
  const value = CursorSchema.parse({ version: 1, ...binding, after });
  if (binding.kind !== "memory") return sealEvidenceValue(value);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", memoryCursorKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function openMemoryCursor(value: string): unknown {
  if (value.length > 4096) throw new Error("Cursor too long");
  const envelope = z
    .strictObject({
      version: z.literal(1),
      nonce: z.string(),
      tag: z.string(),
      ciphertext: z.string(),
    })
    .parse(JSON.parse(value));
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid cursor");
  const decipher = createDecipheriv("aes-256-gcm", memoryCursorKey, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export function parseEvidenceCursor(
  cursor: string | undefined,
  binding: EvidenceCursorBinding,
): Cursor["after"] {
  if (cursor === undefined) return { id: "", ordinal: -1, offset: 0 };
  try {
    const parsed = CursorSchema.parse(
      binding.kind === "memory" ? openMemoryCursor(cursor) : openEvidenceValue(cursor),
    );
    for (const key of ["kind", "owner", "agent", "scope", "query"] as const)
      if (parsed[key] !== binding[key]) throw new Error("Different query scope");
    if (
      (binding.kind === "memory" &&
        (parsed.after.ordinal !== -1 ||
          parsed.after.offset !== 0 ||
          parsed.after.original !== undefined)) ||
      (binding.kind === "knowledge" && parsed.after.score !== undefined)
    )
      throw new Error("Invalid evidence position");
    return parsed.after;
  } catch {
    fail("CONTEXT_INVALID_SELECTION", "资料游标无效或不属于当前查询与范围");
  }
}

/** Offsets and totals are Unicode code points, not UTF-16 units or UTF-8 bytes. */
export function evidenceTextPage(
  text: string,
  input: Pick<EvidenceReadInput, "offset" | "limit">,
): EvidenceTextPage {
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1
  )
    fail("CONTEXT_INVALID_SELECTION", "资料正文分页参数无效");
  const chars = [...text];
  if (input.offset > chars.length) fail("CONTEXT_INVALID_SELECTION", "资料正文偏移超出证据范围");
  const end = Math.min(chars.length, input.offset + Math.min(4096, input.limit));
  return {
    text: chars.slice(input.offset, end).join(""),
    offset: input.offset,
    total: chars.length,
    nextOffset: end < chars.length ? end : null,
  };
}

export function evidencePageLimit(
  limit: number | undefined,
  fallback: number,
  maximum = 100,
): number {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    fail("CONTEXT_INVALID_SELECTION", "资料目录分页参数无效");
  return Math.min(100, maximum, limit ?? fallback);
}

export function evidenceCatalogCost(items: readonly Evidence[]): number {
  // Include a host opaque bodyRef placeholder and JSON/protocol framing in the byte budget.
  return estimateMessages([
    {
      role: "user",
      content: JSON.stringify(
        items.map((item) => ({
          id: item.id,
          ...item.preview,
          bodyRef: "0".repeat(64),
          ...(item.metadata ? { metadata: item.metadata } : {}),
        })),
      ),
    },
  ]);
}
