// URL 安全校验（SSRF 护栏）。
//
// 只放行 http/https，且目标地址不能落在保留网段：本机服务、内网主机、链路本地与文档示例
// 网段都不允许由联网工具访问。判定顺序：WHATWG URL 解析（它会把 2130706433、0x7f.0.0.1、
// 127.1 这类非标准 IPv4 写法折成点分十进制）→ 主机是 IP 字面量就直接判，否则解析 DNS，
// 每个返回地址都要通过，任一命中即拒。
//
// 解析器可注入：测试用假解析器即可全离线，生产默认 node:dns/promises。
// 重定向的每一跳都要重新调用（见 fetch-page），不能只在入口判一次。

import { lookup } from "node:dns/promises";
import { webError } from "./errors";

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export interface UrlSafetyOptions {
  readonly resolve?: HostResolver;
}

/** 点分十进制 IPv4 → 32 位无符号整数；不是该形式返回 null。 */
function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv4Range(network: string, bits: number): readonly [number, number] {
  const value = ipv4ToInt(network) ?? 0;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return [(value & mask) >>> 0, mask];
}

const BLOCKED_V4: readonly (readonly [number, number])[] = [
  ipv4Range("0.0.0.0", 8),
  ipv4Range("10.0.0.0", 8),
  ipv4Range("100.64.0.0", 10),
  ipv4Range("127.0.0.0", 8),
  ipv4Range("169.254.0.0", 16),
  ipv4Range("172.16.0.0", 12),
  ipv4Range("192.0.0.0", 24),
  ipv4Range("192.0.2.0", 24),
  ipv4Range("192.168.0.0", 16),
  ipv4Range("198.18.0.0", 15),
  ipv4Range("198.51.100.0", 24),
  ipv4Range("203.0.113.0", 24),
  ipv4Range("224.0.0.0", 4),
  ipv4Range("240.0.0.0", 4),
  ipv4Range("255.255.255.255", 32),
];

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some(([network, mask]) => (value & mask) >>> 0 === network);
}

/** IPv6 文本 → 16 字节；支持 "::" 压缩、内嵌 IPv4 与尾段 zone 前缀。 */
function ipv6ToBytes(address: string): Uint8Array | null {
  const zone = address.indexOf("%");
  const text = (zone >= 0 ? address.slice(0, zone) : address).toLowerCase();
  if (text.length === 0) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const embedded = ipv4ToInt(piece);
        if (embedded === null) return null;
        groups.push(embedded >>> 16, embedded & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (tail === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function v6Prefix(text: string, bits: number): { prefix: Uint8Array; bits: number } {
  const prefix = ipv6ToBytes(text);
  if (prefix === null) throw new Error(`invalid IPv6 prefix: ${text}`);
  return { prefix, bits };
}

const BLOCKED_V6 = [
  v6Prefix("::", 128),
  v6Prefix("::1", 128),
  v6Prefix("100::", 64),
  v6Prefix("2001:db8::", 32),
  v6Prefix("fc00::", 7),
  v6Prefix("fe80::", 10),
  v6Prefix("ff00::", 8),
];
/** 内嵌 IPv4 的两种前缀：按内嵌地址判，而不是整段封禁。 */
const V6_EMBEDDED_V4 = [v6Prefix("::ffff:0:0", 96), v6Prefix("64:ff9b::", 96)];

function matchesPrefix(address: Uint8Array, prefix: Uint8Array, bits: number): boolean {
  const fullBytes = bits >> 3;
  for (let index = 0; index < fullBytes; index++) {
    if (address[index] !== prefix[index]) return false;
  }
  const restBits = bits & 7;
  if (restBits === 0) return true;
  const mask = (0xff << (8 - restBits)) & 0xff;
  return (address[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

/** 单个地址（v4 或 v6 字面量，可带方括号）是否落在禁止段。不是 IP 字面量返回 false。 */
export function isBlockedAddress(address: string): boolean {
  const literal = address.trim().replace(/^\[/, "").replace(/\]$/, "");
  const value = ipv4ToInt(literal);
  if (value !== null) return isBlockedV4(value);
  const bytes = ipv6ToBytes(literal);
  if (bytes === null) return false;
  for (const { prefix, bits } of V6_EMBEDDED_V4) {
    if (matchesPrefix(bytes, prefix, bits)) {
      const embedded = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
      return isBlockedV4(embedded);
    }
  }
  return BLOCKED_V6.some(({ prefix, bits }) => matchesPrefix(bytes, prefix, bits));
}

/**
 * 校验一个 URL 是否可作为出站抓取目标；通过返回归一化后的 URL，否则抛出带码错误：
 * WEB_URL_INVALID（非法 URL）、WEB_URL_BLOCKED（协议或凭证不允许）、
 * WEB_HOST_UNRESOLVED（域名解析失败）、WEB_BLOCKED_ADDRESS（命中禁止段）。
 */
export async function assertSafeUrl(
  rawUrl: string | URL,
  options: UrlSafetyOptions = {},
): Promise<URL> {
  let url: URL;
  if (rawUrl instanceof URL) {
    url = new URL(rawUrl.href);
  } else {
    try {
      url = new URL(rawUrl);
    } catch {
      throw webError("WEB_URL_INVALID", `非法 URL：${rawUrl}`);
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw webError("WEB_URL_BLOCKED", `仅允许 http/https 地址，实际为 ${url.protocol}`);
  if (url.username !== "" || url.password !== "")
    throw webError("WEB_URL_BLOCKED", "URL 不允许携带用户名或密码");
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === "") throw webError("WEB_URL_INVALID", `URL 缺少主机名：${url.href}`);
  if (ipv4ToInt(hostname) !== null || ipv6ToBytes(hostname) !== null) {
    if (isBlockedAddress(hostname))
      throw webError("WEB_BLOCKED_ADDRESS", `目标地址属于保留网段：${hostname}`);
    return url;
  }
  const resolve = options.resolve ?? defaultResolve;
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw webError("WEB_HOST_UNRESOLVED", `域名解析失败：${hostname}`, { cause: error });
  }
  if (addresses.length === 0)
    throw webError("WEB_HOST_UNRESOLVED", `域名没有解析到任何地址：${hostname}`);
  for (const address of addresses) {
    if (isBlockedAddress(address))
      throw webError("WEB_BLOCKED_ADDRESS", `目标地址解析到保留网段：${hostname} → ${address}`);
  }
  return url;
}
