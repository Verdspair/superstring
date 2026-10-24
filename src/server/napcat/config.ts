import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type QqManagedConfig as NapCatConfig,
  QqManagedConfigSchema as NapCatConfigSchema,
} from "../../shared/contracts/qq-managed";

export type { NapCatConfig };
export { NapCatConfigSchema };

export interface NapCatConfigSnapshot {
  readonly revision: string;
  readonly config: NapCatConfig;
}

export class NapCatConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NapCatConfigError";
  }
}

function invalidConfig(): NapCatConfigError {
  return new NapCatConfigError("NAPCAT_CONFIG_INVALID", "NapCat 配置无效");
}

function unavailableConfig(): NapCatConfigError {
  return new NapCatConfigError("NAPCAT_CONFIG_UNAVAILABLE", "NapCat 配置不可读或无法写入");
}

function snapshot(raw: Buffer): NapCatConfigSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw invalidConfig();
  }
  const parsed = NapCatConfigSchema.safeParse(value);
  if (!parsed.success) throw invalidConfig();
  return {
    revision: createHash("sha256").update(raw).digest("hex"),
    config: parsed.data,
  };
}

function sameConfig(left: NapCatConfig, right: NapCatConfig): boolean {
  return left.version === right.version && left.enabled === right.enabled;
}

export class FileNapCatConfigStore {
  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) throw invalidConfig();
  }

  read(): NapCatConfigSnapshot {
    let raw: Buffer;
    try {
      raw = readFileSync(this.file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { revision: "", config: { version: 1, enabled: false } };
      }
      throw unavailableConfig();
    }
    return snapshot(raw);
  }

  replace(expectedRevision: string, config: NapCatConfig): NapCatConfigSnapshot {
    const parsed = NapCatConfigSchema.safeParse(config);
    if (!parsed.success) throw invalidConfig();

    const current = this.read();
    if (current.revision !== expectedRevision) {
      throw new NapCatConfigError("NAPCAT_CONFIG_CONFLICT", "NapCat 配置已变化，请重新读取后保存");
    }
    if (sameConfig(current.config, parsed.data)) return current;

    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // Keep the storage error stable and do not expose local paths.
      }
      throw unavailableConfig();
    }
    return this.read();
  }
}
