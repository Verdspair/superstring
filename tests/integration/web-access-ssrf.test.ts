// 联网 URL 安全校验（SSRF 护栏）的负向矩阵与放行口径。全离线：DNS 解析器注入假实现。

import { describe, expect, it } from "bun:test";
import { assertSafeUrl, isBlockedAddress } from "../../src/server/web-access/ssrf";

const publicResolver = async () => ["93.184.216.34"];
const resolverFor = (addresses: string[]) => async () => addresses;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("IP 禁止段判定", () => {
  it("v4 清单逐项命中，边界外不误伤", () => {
    const blocked = [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.255",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
    ];
    for (const address of blocked) expect(isBlockedAddress(address)).toBe(true);
    const allowed = [
      "1.1.1.1",
      "8.8.8.8",
      "9.255.255.255",
      "11.0.0.1",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.1",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.0.1.1",
      "192.0.3.1",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
    ];
    for (const address of allowed) expect(isBlockedAddress(address)).toBe(false);
  });

  it("v6 清单逐项命中；内嵌 v4 的两个前缀按内嵌地址判", () => {
    const blocked = [
      "::",
      "::1",
      "100::1",
      "2001:db8::1",
      "fc00::1",
      "fdff:ffff::1",
      "fe80::1",
      "febf::1",
      "ff02::1",
    ];
    for (const address of blocked) expect(isBlockedAddress(address)).toBe(true);
    const allowed = [
      "::2",
      "100:1::",
      "2001:db9::1",
      "fbff::1",
      "fe00::1",
      "fec0::1",
      "2606:4700::1111",
    ];
    for (const address of allowed) expect(isBlockedAddress(address)).toBe(false);
    // ::ffff:0:0/96 与 64:ff9b::/96：内嵌公网 v4 放行，内嵌私网 v4 拒绝。
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::808:808")).toBe(false);
    expect(isBlockedAddress("64:ff9b::a00:1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true);
    // 带方括号的写法也能直接判。
    expect(isBlockedAddress("[::1]")).toBe(true);
    expect(isBlockedAddress("[2606:4700::1111]")).toBe(false);
    // 非 IP 字面量不是禁止段。
    expect(isBlockedAddress("example.com")).toBe(false);
    expect(isBlockedAddress("")).toBe(false);
  });
});

describe("URL 护栏", () => {
  it("URL 里的禁止段一律拒绝（v4/v6/IP 字面量）", async () => {
    const blockedUrls = [
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://100.64.0.1/",
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.16.0.1/",
      "http://192.0.0.1/",
      "http://192.0.2.1/",
      "http://192.168.1.1/",
      "http://198.18.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://240.0.0.1/",
      "http://255.255.255.255/",
      "http://[::1]/",
      "http://[::]/",
      "http://[100::1]/",
      "http://[2001:db8::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[64:ff9b::10.0.0.1]/",
    ];
    for (const url of blockedUrls) {
      expect(await codeOf(assertSafeUrl(url, { resolve: publicResolver }))).toBe(
        "WEB_BLOCKED_ADDRESS",
      );
    }
  });

  it("非标准 IPv4 写法在 URL 归一化后按字面量判", async () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0x7f.0.0.1/",
      "http://127.1/",
      "http://0177.0.0.1/",
      "http://0300.0250.0.1/",
    ]) {
      expect(await codeOf(assertSafeUrl(url, { resolve: publicResolver }))).toBe(
        "WEB_BLOCKED_ADDRESS",
      );
    }
    // 同样的写法指向公网地址时应放行（归一化本身不是封禁）。
    const url = await assertSafeUrl("http://0x5db8d822/", { resolve: publicResolver });
    expect(url.hostname).toBe("93.184.216.34");
  });

  it("协议与凭证：仅 http/https，拒绝含用户名/密码", async () => {
    for (const url of [
      "ftp://example.com/",
      "file:///etc/hosts",
      "ws://example.com/",
      "data:text/html,hi",
    ]) {
      expect(await codeOf(assertSafeUrl(url, { resolve: publicResolver }))).toBe("WEB_URL_BLOCKED");
    }
    for (const url of [
      "http://user:pass@example.com/",
      "https://user@example.com/",
      "http://:pass@example.com/",
    ]) {
      expect(await codeOf(assertSafeUrl(url, { resolve: publicResolver }))).toBe("WEB_URL_BLOCKED");
    }
  });

  it("非法 URL 拒绝", async () => {
    for (const url of ["not a url", "http://", "://example.com", "http://exa mple.com/"]) {
      expect(await codeOf(assertSafeUrl(url, { resolve: publicResolver }))).toBe("WEB_URL_INVALID");
    }
  });

  it("域名解析：每个地址都要过校验，任一命中即拒", async () => {
    expect(
      await codeOf(
        assertSafeUrl("http://example.com/", { resolve: resolverFor(["93.184.216.34"]) }),
      ),
    ).toBe(undefined);
    expect(
      await codeOf(
        assertSafeUrl("http://example.com/", { resolve: resolverFor(["93.184.216.34", "::1"]) }),
      ),
    ).toBe("WEB_BLOCKED_ADDRESS");
    expect(
      await codeOf(
        assertSafeUrl("http://example.com/", { resolve: resolverFor(["2606:4700::1111"]) }),
      ),
    ).toBe(undefined);
    expect(
      await codeOf(assertSafeUrl("http://example.com/", { resolve: resolverFor(["10.0.0.1"]) })),
    ).toBe("WEB_BLOCKED_ADDRESS");
    expect(await codeOf(assertSafeUrl("http://example.com/", { resolve: resolverFor([]) }))).toBe(
      "WEB_HOST_UNRESOLVED",
    );
    expect(
      await codeOf(
        assertSafeUrl("http://example.com/", {
          resolve: async () => {
            throw new Error("dns down");
          },
        }),
      ),
    ).toBe("WEB_HOST_UNRESOLVED");
  });

  it("IP 字面量不走 DNS；通过时返回归一化的 URL", async () => {
    let calls = 0;
    const resolve = async () => {
      calls++;
      return ["93.184.216.34"];
    };
    const literal = await assertSafeUrl("https://8.8.8.8/dns-query?x=1", { resolve });
    expect(literal.href).toBe("https://8.8.8.8/dns-query?x=1");
    expect(calls).toBe(0);
    const named = await assertSafeUrl("http://Example.COM:8080/a", { resolve });
    expect(named.href).toBe("http://example.com:8080/a");
    expect(calls).toBe(1);
  });
});
