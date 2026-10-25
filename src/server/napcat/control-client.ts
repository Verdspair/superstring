import { createHash } from "node:crypto";
import { z } from "zod";

export type NapCatFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type NapCatControlErrorCode =
  | "aborted"
  | "timeout"
  | "transport_error"
  | "connection_refused"
  | "http_error"
  | "upstream_rejected"
  | "invalid_response";

export class NapCatControlError extends Error {
  constructor(readonly code: NapCatControlErrorCode) {
    super(`NapCat control request failed: ${code}`);
    this.name = "NapCatControlError";
  }
}

export type NapCatLoginResult =
  | { readonly kind: "credential"; readonly credential: string }
  | { readonly kind: "requires_2fa" };

const LoginBody = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  totpCode: z.string().optional(),
});
const LoginChallenge = z.strictObject({
  require2FA: z.literal(true),
  message: z.string(),
});
const LoginPayload = z.strictObject({
  Credential: z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value)),
  require2FA: z.literal(false).optional(),
});
const Envelope = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal(0),
    data: z.unknown().optional(),
    message: z.literal("success"),
  }),
  z.strictObject({ code: z.literal(-1), message: z.string() }),
]);
const LoginStatusPayload = z.strictObject({
  isLogin: z.boolean(),
  isOffline: z.boolean(),
  loginPhase: z.string(),
  qrLoginAccepted: z.boolean(),
  coreReady: z.boolean(),
  qrcodeurl: z.string(),
  loginError: z.unknown(),
});
const QrPayload = z.strictObject({ qrcode: z.string() });
const RefreshQrPayload = z.union([
  z.strictObject({ qrcodeurl: z.string(), restarting: z.literal(true) }),
  z.strictObject({ qrcodeurl: z.string() }),
]);

export interface NapCatControlClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetch: NapCatFetch;
}

function loopbackOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("NapCat base URL must be an explicit loopback HTTP origin");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("NapCat base URL must be an explicit loopback HTTP origin");
  }
  return url.origin;
}

export async function deriveNapCatTokenHash(token: string): Promise<string> {
  return createHash("sha256").update(`${token}.napcat`, "utf8").digest("hex");
}

export class NapCatControlClient {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #fetch: NapCatFetch;

  constructor(options: NapCatControlClientOptions) {
    this.#origin = loopbackOrigin(options.baseUrl);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TypeError("NapCat timeoutMs must be a positive safe integer");
    }
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch;
  }

  async login(
    input: { readonly hash: string; readonly totpCode?: string },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<NapCatLoginResult> {
    const body = LoginBody.safeParse(input);
    if (!body.success) throw new NapCatControlError("invalid_response");
    const payload = await this.#request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.data),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const challenge = LoginChallenge.safeParse(payload);
    if (challenge.success) return { kind: "requires_2fa" };
    const parsed = LoginPayload.safeParse(payload);
    if (!parsed.success) throw new NapCatControlError("invalid_response");
    return { kind: "credential", credential: parsed.data.Credential };
  }

  async checkLoginStatus(
    credential: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<z.infer<typeof LoginStatusPayload>> {
    const payload = await this.#request("/api/QQLogin/CheckLoginStatus", {
      method: "POST",
      headers: this.#authHeaders(credential),
      body: "{}",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = LoginStatusPayload.safeParse(payload);
    if (!parsed.success) throw new NapCatControlError("invalid_response");
    return parsed.data;
  }

  async getLoginQrCode(
    credential: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<z.infer<typeof QrPayload>> {
    const payload = await this.#request("/api/QQLogin/GetQQLoginQrcode", {
      method: "POST",
      headers: this.#authHeaders(credential),
      body: "{}",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = QrPayload.safeParse(payload);
    if (!parsed.success) throw new NapCatControlError("invalid_response");
    return parsed.data;
  }

  async refreshLoginQrCode(
    credential: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<z.infer<typeof RefreshQrPayload>> {
    const payload = await this.#request("/api/QQLogin/RefreshQRcode", {
      method: "POST",
      headers: this.#authHeaders(credential),
      body: "{}",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = RefreshQrPayload.safeParse(payload);
    if (!parsed.success) throw new NapCatControlError("invalid_response");
    return parsed.data;
  }

  #authHeaders(credential: string): HeadersInit {
    if (!credential.trim() || /[\r\n]/.test(credential)) {
      throw new NapCatControlError("invalid_response");
    }
    return { authorization: `Bearer ${credential}` };
  }

  async #request(route: string, init: RequestInit): Promise<unknown> {
    const callerSignal = init.signal ?? undefined;
    if (callerSignal?.aborted) throw new NapCatControlError("aborted");
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.#timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const response = await this.#fetch(`${this.#origin}${route}`, {
        ...init,
        redirect: "error",
        signal,
      });
      const text = await response.text();
      if (callerSignal?.aborted) throw new NapCatControlError("aborted");
      if (timeoutController.signal.aborted) throw new NapCatControlError("timeout");
      if (!response.ok) throw new NapCatControlError("http_error");
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new NapCatControlError("invalid_response");
      }
      if (callerSignal?.aborted) throw new NapCatControlError("aborted");
      if (timeoutController.signal.aborted) throw new NapCatControlError("timeout");
      const envelope = Envelope.safeParse(decoded);
      if (!envelope.success) throw new NapCatControlError("invalid_response");
      if (envelope.data.code === -1) throw new NapCatControlError("upstream_rejected");
      return envelope.data.data;
    } catch (error) {
      if (error instanceof NapCatControlError) throw error;
      if (callerSignal?.aborted) throw new NapCatControlError("aborted");
      if (timeoutController.signal.aborted) throw new NapCatControlError("timeout");
      const directCode =
        error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      const cause =
        error !== null && typeof error === "object" && "cause" in error ? error.cause : undefined;
      const causeCode =
        cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (
        ["ECONNREFUSED", "ConnectionRefused"].includes(String(directCode)) ||
        ["ECONNREFUSED", "ConnectionRefused"].includes(String(causeCode))
      ) {
        throw new NapCatControlError("connection_refused");
      }
      throw new NapCatControlError("transport_error");
    } finally {
      clearTimeout(timer);
    }
  }
}
