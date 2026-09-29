// 联网配置存储：文件路径注入、Zod 校验、原子写（对照 permissions/service.ts 的
// FilePermissionStore 模式）。schema 最小：{ version: 1, searxngEndpoint? }。
//
// 端点只要求 http/https、长度有界，保存时去掉尾斜杠；**允许 loopback/私网**——它是用户在
// 设置页自己填写的可信端点，不适用抓取侧的 ssrf 护栏。读取容错：文件缺失＝默认空配置；
// 内容损坏＝带码拒绝（不猜内容），写入用「读原文哈希比较 + 原子替换」。

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { webError } from "./errors";

export const MAX_SEARXNG_ENDPOINT_CHARS = 2048;

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

export const WebAccessConfigSchema = z.strictObject({
  version: z.literal(1),
  searxngEndpoint: z
    .string()
    .min(1)
    .max(MAX_SEARXNG_ENDPOINT_CHARS)
    .refine(isHttpEndpoint, "SearXNG 端点必须是合法的 http/https 地址")
    .optional(),
});

export type WebAccessConfig = z.infer<typeof WebAccessConfigSchema>;

export interface WebAccessConfigSnapshot {
  readonly revision: string;
  readonly config: WebAccessConfig;
}

export interface WebAccessConfigStore {
  read(): WebAccessConfigSnapshot;
  replace(expectedRevision: string, config: WebAccessConfig): WebAccessConfigSnapshot;
}

/** 保存前归一化：去首尾空白与尾斜杠；空串视为未配置。 */
export function normalizeWebAccessConfig(input: WebAccessConfig): WebAccessConfig {
  const endpoint = input.searxngEndpoint?.trim().replace(/\/+$/, "") ?? "";
  return endpoint === "" ? { version: 1 } : { version: 1, searxngEndpoint: endpoint };
}

export class FileWebAccessConfigStore implements WebAccessConfigStore {
  constructor(private readonly file: string) {}

  /** 缺失 → 默认空配置（revision 空串）；存在但不可读/不合 schema → 带码拒绝。 */
  read(): WebAccessConfigSnapshot {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { revision: "", config: { version: 1 } };
      throw webError("WEB_CONFIG_UNAVAILABLE", "联网配置不可读", { cause: error });
    }
    try {
      return {
        revision: createHash("sha256").update(text).digest("hex"),
        config: WebAccessConfigSchema.parse(JSON.parse(text)),
      };
    } catch (error) {
      throw webError("WEB_CONFIG_INVALID", "联网配置不合法，请检查 SearXNG 端点", {
        cause: error,
      });
    }
  }

  /** 写入配置：expectedRevision 必须等于当前原文哈希；成功返回新快照。 */
  replace(expectedRevision: string, config: WebAccessConfig): WebAccessConfigSnapshot {
    let parsed: WebAccessConfig;
    try {
      parsed = WebAccessConfigSchema.parse(normalizeWebAccessConfig(config));
    } catch (error) {
      throw webError("WEB_CONFIG_INVALID", "SearXNG 端点不合法：仅支持 http/https 地址", {
        cause: error,
      });
    }
    if (this.read().revision !== expectedRevision)
      throw webError("WEB_CONFIG_CONFLICT", "联网配置已变化，请重新读取后保存");
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the original write failure. */
      }
      throw error;
    }
    return this.read();
  }
}
