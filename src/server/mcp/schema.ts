import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import { addFormats } from "@modelcontextprotocol/client/validators/ajv";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";

export function mcpError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(`${code}: ${message}`, { cause }), { code });
}

export class McpSchemaValidator implements jsonSchemaValidator {
  private readonly modern = new Ajv2020({ strict: false, allErrors: false, addUsedSchema: false });
  private readonly legacy = new Ajv({ strict: false, allErrors: false, addUsedSchema: false });

  constructor() {
    addFormats(this.modern);
    addFormats(this.legacy);
    const draft7 = this.legacy.getSchema("http://json-schema.org/draft-07/schema#");
    if (draft7 && typeof draft7.schema === "object")
      this.legacy.addMetaSchema(draft7.schema, "https://json-schema.org/draft-07/schema#");
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    if (JSON.stringify(schema).length > 128_000)
      throw mcpError("MCP_SCHEMA_INVALID", "工具 schema 超过大小上限");
    const pending = [{ value: schema as unknown, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const entry = pending.pop();
      if (!entry || entry.value === null || typeof entry.value !== "object") continue;
      if (++nodes > 4096 || entry.depth > 64)
        throw mcpError("MCP_SCHEMA_INVALID", "工具 schema 超过复杂度上限");
      for (const value of Object.values(entry.value))
        pending.push({ value, depth: entry.depth + 1 });
    }
    const dialect = schema.$schema;
    const engine =
      dialect === undefined || dialect === "https://json-schema.org/draft/2020-12/schema"
        ? this.modern
        : dialect === "http://json-schema.org/draft-07/schema#" ||
            dialect === "https://json-schema.org/draft-07/schema#"
          ? this.legacy
          : null;
    if (!engine) throw mcpError("MCP_SCHEMA_DIALECT_UNSUPPORTED", "不支持工具声明的 schema 方言");
    try {
      const validate = engine.compile(schema);
      return (input) =>
        validate(input)
          ? { valid: true, data: input as T, errorMessage: undefined }
          : { valid: false, data: undefined, errorMessage: engine.errorsText(validate.errors) };
    } catch (error) {
      throw mcpError("MCP_SCHEMA_INVALID", "工具 schema 无效或引用不可解析", error);
    }
  }
}
