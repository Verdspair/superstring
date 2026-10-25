import { describe, expect, it } from "bun:test";
import {
  deriveNapCatTokenHash,
  NapCatControlClient,
  type NapCatFetch,
} from "../../src/server/napcat/control-client";

const baseUrl = "http://127.0.0.1:6099";
const credential = "opaque-synthetic-credential";
const qrPayload = "synthetic-qr-payload";
const statusPayload = {
  isLogin: false,
  isOffline: false,
  loginPhase: "future_vendor_phase",
  qrLoginAccepted: false,
  coreReady: false,
  qrcodeurl: qrPayload,
  loginError: null,
};

type FetchCall = { url: string; init: RequestInit };
function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function harness(responses: Response[] = []) {
  const calls: FetchCall[] = [];
  const fetcher: NapCatFetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("Synthetic response queue is empty");
    return next;
  };
  const client = new NapCatControlClient({ baseUrl, fetch: fetcher, timeoutMs: 100 });
  return { client, calls };
}

function jsonBody(call: FetchCall): unknown {
  return JSON.parse(String(call.init.body));
}

describe("NapCat control client", () => {
  it("derives lowercase SHA-256 from UTF-8 token plus the fixed suffix", async () => {
    expect(await deriveNapCatTokenHash("测试-token🔐")).toBe(
      "b18e9c0ff374d5970943a7026f817fab959535c2cae087a9d39edf4b28e184a2",
    );
    expect(await deriveNapCatTokenHash("")).toBe(
      "9321a78bf9c95f3d2b7ade7f2d02a4608c92bfa68f3fd7c18622d82bc93080cd",
    );
  });

  it("requires an explicit loopback HTTP base URL without embedded credentials or URL selectors", () => {
    for (const invalid of [
      "https://127.0.0.1:6099",
      "http://example.invalid:6099",
      "http://user:secret@127.0.0.1:6099",
      "http://127.0.0.1:6099?token=secret",
      "http://127.0.0.1:6099/#secret",
    ]) {
      expect(
        () =>
          new NapCatControlClient({
            baseUrl: invalid,
            fetch: async () => response({ code: 0, message: "success" }),
            timeoutMs: 100,
          }),
      ).toThrow();
    }
  });

  it("posts the supplied token hash and optional TOTP without retaining or logging credentials", async () => {
    const syntheticHash = await deriveNapCatTokenHash("synthetic-token");
    const { client, calls } = harness([
      response({ code: 0, data: { Credential: credential }, message: "success" }),
    ]);
    const result = await client.login({ hash: syntheticHash });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${baseUrl}/api/auth/login`,
      init: { method: "POST", redirect: "error" },
    });
    expect(jsonBody(calls[0])).toEqual({ hash: syntheticHash });
    expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
    expect(result).toEqual({ kind: "credential", credential });

    const totp = harness([
      response({ code: 0, data: { Credential: credential }, message: "success" }),
    ]);
    await totp.client.login({ hash: syntheticHash, totpCode: "123456" });
    expect(jsonBody(totp.calls[0])).toEqual({ hash: syntheticHash, totpCode: "123456" });
  });

  it("recognizes a 2FA challenge and a credential response that explicitly clears the challenge", async () => {
    const { client } = harness([
      response({
        code: 0,
        data: { require2FA: true, message: "Enter verification code" },
        message: "success",
      }),
      response({
        code: 0,
        data: { Credential: credential, require2FA: false },
        message: "success",
      }),
    ]);

    expect(await client.login({ hash: await deriveNapCatTokenHash("synthetic-token") })).toEqual({
      kind: "requires_2fa",
    });
    expect(
      await client.login({
        hash: await deriveNapCatTokenHash("synthetic-token"),
        totpCode: "123456",
      }),
    ).toEqual({ kind: "credential", credential });
  });

  it("uses the fixed authenticated status, QR, and refresh routes and projects their exact payloads", async () => {
    const refreshed = { qrcodeurl: "", restarting: true };
    const { client, calls } = harness([
      response({ code: 0, data: statusPayload, message: "success" }),
      response({ code: 0, data: { qrcode: qrPayload }, message: "success" }),
      response({ code: 0, data: refreshed, message: "success" }),
    ]);

    expect(await client.checkLoginStatus(credential)).toEqual(statusPayload);
    expect(await client.getLoginQrCode(credential)).toEqual({ qrcode: qrPayload });
    expect(await client.refreshLoginQrCode(credential)).toEqual(refreshed);
    expect(calls.map(({ url, init }) => [url, init.method])).toEqual([
      [`${baseUrl}/api/QQLogin/CheckLoginStatus`, "POST"],
      [`${baseUrl}/api/QQLogin/GetQQLoginQrcode`, "POST"],
      [`${baseUrl}/api/QQLogin/RefreshQRcode`, "POST"],
    ]);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${credential}`);
      expect(call.init.redirect).toBe("error");
    }
  });

  it("classifies the HTTP-200 vendor error envelope without exposing vendor text", async () => {
    const privateVendorText = `private detail ${credential} ${qrPayload}`;
    const { client } = harness([response({ code: -1, message: privateVendorText })]);
    let caught: unknown;
    try {
      await client.getLoginQrCode(credential);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "upstream_rejected" });
    expect(String(caught)).not.toContain(privateVendorText);
    expect(String(caught)).not.toContain(credential);
    expect(String(caught)).not.toContain(qrPayload);
  });

  it("rejects malformed JSON, envelopes, and route payloads with stable sanitized errors", async () => {
    const invalidJson = new Response("not-json", { status: 200 });
    const malformedEnvelope = response({ code: 0, data: statusPayload });
    const malformedStatus = response({
      code: 0,
      data: { ...statusPayload, isLogin: "yes" },
      message: "success",
    });
    for (const result of [invalidJson, malformedEnvelope, malformedStatus]) {
      const { client } = harness([result]);
      await expect(client.checkLoginStatus(credential)).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("sends one request only and rejects pre-aborted or caller-aborted requests without leaking response data", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const beforeSend = harness([]);
    await expect(
      beforeSend.client.getLoginQrCode(credential, { signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(beforeSend.calls).toHaveLength(0);

    const controller = new AbortController();
    let signalSeen: AbortSignal | null = null;
    const calls: FetchCall[] = [];
    const fetcher: NapCatFetch = (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      signalSeen = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        signalSeen?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          {
            once: true,
          },
        );
      });
    };
    const client = new NapCatControlClient({ baseUrl, fetch: fetcher, timeoutMs: 100 });
    const pending = client.getLoginQrCode(credential, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toHaveLength(1);
  });

  it("distinguishes typed connection refusal from reset and untyped transport failures", async () => {
    const failures = [
      {
        error: Object.assign(new Error("private refused"), { code: "ECONNREFUSED" }),
        code: "connection_refused",
      },
      {
        error: new Error("private wrapper", {
          cause: Object.assign(new Error("private cause"), { code: "ECONNREFUSED" }),
        }),
        code: "connection_refused",
      },
      {
        error: Object.assign(new Error("private Bun refusal"), { code: "ConnectionRefused" }),
        code: "connection_refused",
      },
      {
        error: Object.assign(new Error("private reset"), { code: "ECONNRESET" }),
        code: "transport_error",
      },
      { error: new Error("ECONNREFUSED only in untrusted text"), code: "transport_error" },
    ];
    for (const failure of failures) {
      const client = new NapCatControlClient({
        baseUrl,
        timeoutMs: 100,
        fetch: async () => {
          throw failure.error;
        },
      });
      await expect(client.getLoginQrCode(credential)).rejects.toMatchObject({ code: failure.code });
    }
  });

  it("aborts at the caller-supplied deadline and does not retry", async () => {
    const calls: FetchCall[] = [];
    const fetcher: NapCatFetch = (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          {
            once: true,
          },
        );
      });
    };
    const client = new NapCatControlClient({ baseUrl, fetch: fetcher, timeoutMs: 5 });
    await expect(client.getLoginQrCode(credential)).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toHaveLength(1);
  });
});

describe("NapCat control client account and OneBot configuration routes", () => {
  it("projects the pinned quick-login record shape and validates every source field", async () => {
    const { client, calls } = harness([
      response({
        code: 0,
        data: [
          {
            uin: "123456",
            uid: "uid-1",
            nickName: "Account one",
            faceUrl: "https://example.invalid/avatar",
            facePath: "avatar.png",
            loginType: 1,
            isQuickLogin: true,
            isAutoLogin: false,
          },
          {
            uin: "234567",
            uid: "uid-2",
            nickName: "",
            faceUrl: "",
            facePath: "",
            loginType: 1,
            isQuickLogin: false,
            isAutoLogin: false,
          },
        ],
        message: "success",
      }),
    ]);

    expect(await client.getQuickLoginAccounts(credential)).toEqual([
      { account_id: "123456", display_name: "Account one" },
      { account_id: "234567", display_name: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${baseUrl}/api/QQLogin/GetQuickLoginListNew`);
    expect(calls[0].init.method).toBe("POST");
    expect(jsonBody(calls[0])).toEqual({});
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${credential}`);

    const malformed = harness([
      response({
        code: 0,
        data: [{ uin: "123456", nickName: "Missing the rest of LoginListItem" }],
        message: "success",
      }),
    ]);
    await expect(malformed.client.getQuickLoginAccounts(credential)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("requests one quick login using the selected UIN and preserves rejection without retry", async () => {
    const { client, calls } = harness([
      response({ code: 0, data: null, message: "success" }),
      response({ code: -1, message: "QQ Is Logined" }),
    ]);

    await expect(client.quickLogin(credential, { account_id: "123456" })).resolves.toBeUndefined();
    expect(calls[0].url).toBe(`${baseUrl}/api/QQLogin/SetQuickLogin`);
    expect(calls[0].init.method).toBe("POST");
    expect(jsonBody(calls[0])).toEqual({ uin: "123456" });
    await expect(client.quickLogin(credential, { account_id: "123456" })).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    expect(calls).toHaveLength(2);
  });

  it("reads the current login UIN from the pinned login-info response", async () => {
    const { client, calls } = harness([
      response({
        code: 0,
        data: {
          uid: "uid-1",
          uin: "123456",
          nick: "Account one",
          online: true,
          avatarUrl: "https://example.invalid/avatar",
        },
        message: "success",
      }),
    ]);

    expect(await client.getLoginAccount(credential)).toBe("123456");
    expect(calls[0].url).toBe(`${baseUrl}/api/QQLogin/GetQQLoginInfo`);
    expect(jsonBody(calls[0])).toEqual({});

    const missingUin = harness([
      response({
        code: 0,
        data: { uid: "uid-1", nick: "Account one" },
        message: "success",
      }),
    ]);
    await expect(missingUin.client.getLoginAccount(credential)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("reads a full OneBot config object without dropping unknown nested fields", async () => {
    const config = {
      network: {
        httpServers: [],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [
          {
            name: "superstring",
            enable: true,
            host: "127.0.0.1",
            port: 3001,
            messagePostFormat: "array",
            reportSelfMessage: false,
            token: "synthetic-onebot-token",
            enableForcePushEvent: true,
            debug: false,
            heartInterval: 30000,
            customAdapterOption: { keep: "this" },
          },
        ],
        websocketClients: [],
        plugins: [],
        customNetworkOption: { preserve: true },
      },
      musicSignUrl: "",
      enableLocalFile2Url: false,
      parseMultMsg: false,
      imageDownloadProxy: "",
      timeout: {
        baseTimeout: 10000,
        uploadSpeedKBps: 256,
        downloadSpeedKBps: 256,
        maxTimeout: 1800000,
        customTimeoutOption: "preserve",
      },
      customTopLevelOption: ["preserve", 7],
    };
    const { client, calls } = harness([response({ code: 0, data: config, message: "success" })]);

    expect(await client.getOneBotConfig(credential)).toEqual(config);
    expect(calls[0].url).toBe(`${baseUrl}/api/OB11Config/GetConfig`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBeUndefined();
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${credential}`);

    const malformed = harness([
      response({
        code: 0,
        data: { ...config, network: { ...config.network, websocketServers: [{ name: "broken" }] } },
        message: "success",
      }),
    ]);
    await expect(malformed.client.getOneBotConfig(credential)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("serializes the complete OneBot config for SetConfig and does not retry a rejected write", async () => {
    const config = {
      network: {
        httpServers: [],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [],
        websocketClients: [],
        plugins: [],
        customNetworkOption: "retain",
      },
      musicSignUrl: "",
      enableLocalFile2Url: false,
      parseMultMsg: false,
      imageDownloadProxy: "",
      timeout: {
        baseTimeout: 10000,
        uploadSpeedKBps: 256,
        downloadSpeedKBps: 256,
        maxTimeout: 1800000,
      },
      customTopLevelOption: { retain: true },
    };
    const { client, calls } = harness([
      response({ code: 0, data: null, message: "success" }),
      response({ code: -1, message: "write rejected" }),
    ]);

    await expect(client.setOneBotConfig(credential, config)).resolves.toBeUndefined();
    expect(calls[0].url).toBe(`${baseUrl}/api/OB11Config/SetConfig`);
    expect(calls[0].init.method).toBe("POST");
    expect(jsonBody(calls[0])).toEqual({ config: JSON.stringify(config) });
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
    await expect(client.setOneBotConfig(credential, config)).rejects.toMatchObject({
      code: "upstream_rejected",
    });
    expect(calls).toHaveLength(2);
  });
});
