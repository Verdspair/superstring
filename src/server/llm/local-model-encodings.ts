// 本地模型 tokenizer 编码存储：文件路径注入、Zod 校验、同步 CAS 原子写
// （对照 web-access/config.ts 的 FileWebAccessConfigStore 模式，但不引入任何
// 通用 store 框架）。schema 最小：{ version: 1, models: [{ name, tokenizer_encoding }] }。
//
// revision = 原始文件内容的 SHA-256（缺文件 = 空串），不在文件里存任何哈希或时间戳；
// CAS 冲突抛既有 CONFIG_VERSION_CONFLICT 409。
// 读取容错：文件缺失 = 空声明；存在但不可读/不合 schema = 带码拒绝（不猜内容、不降级）。
// 写入用「读原文哈希比较 + 临时文件 + rename」在同一事件循环内同步完成，模式 0600。

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type LocalModelEncoding,
  LocalModelEncodingsResponseSchema,
} from "../../shared/contracts/models";
import { DatabaseError, fail } from "../errors";

const FileSchema = z.strictObject({
  version: z.literal(1),
  models: LocalModelEncodingsResponseSchema.shape.models,
});

export interface LocalModelEncodingSnapshot {
  readonly revision: string;
  readonly models: readonly LocalModelEncoding[];
}

export interface LocalModelEncodingStore {
  read(): LocalModelEncodingSnapshot;
  replace(
    expectedRevision: string,
    models: readonly LocalModelEncoding[],
  ): LocalModelEncodingSnapshot;
}

export class FileLocalModelEncodingStore implements LocalModelEncodingStore {
  constructor(private readonly file: string) {}

  /** 缺失 → 空声明（revision 空串）；存在但不可读/不合 schema → 带码拒绝。 */
  read(): LocalModelEncodingSnapshot {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { revision: "", models: [] };
      }
      throw new DatabaseError("本地模型编码配置不可读", { cause: error });
    }
    try {
      const parsed = FileSchema.parse(JSON.parse(text));
      return {
        revision: createHash("sha256").update(text).digest("hex"),
        models: parsed.models,
      };
    } catch (error) {
      throw new DatabaseError("本地模型编码配置不合法", { cause: error });
    }
  }

  /** 写入声明：expectedRevision 必须等于当前原文哈希；空数组清空全部条目。 */
  replace(
    expectedRevision: string,
    models: readonly LocalModelEncoding[],
  ): LocalModelEncodingSnapshot {
    let text: string;
    try {
      text = `${JSON.stringify(FileSchema.parse({ version: 1, models: [...models] }), null, 2)}\n`;
    } catch (error) {
      fail("VALIDATION_ERROR", "本地模型编码声明不合法", 422);
    }
    // 同步读-比-写同在一个事件循环内，CAS 判定与落盘之间不会插入其他请求。
    if (this.read().revision !== expectedRevision) {
      fail("CONFIG_VERSION_CONFLICT", "本地模型编码配置已变化，请重新读取后保存");
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the original write failure. */
      }
      throw new DatabaseError("本地模型编码配置写入失败", { cause: error });
    }
    return this.read();
  }
}
