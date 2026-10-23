import { createHash } from "node:crypto";
import {
  closeSync,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import {
  type SkillDetailResponse,
  type SkillMetadata,
  SkillMetadataSchema,
  type SkillOrigin,
} from "../../shared/contracts/skill";
import { containsPath, PermissionError } from "../permissions/service";

const DOCUMENT_MAX_BYTES = 1_048_576;
const FRONTMATTER_MAX_BYTES = 65_536;
const YAML_MAX_DEPTH = 32;
const YAML_CORE_TAG = /^tag:yaml\.org,2002:(?:str|map|seq|null|bool|int|float)$/;

// 随包系统技能：真实 SKILL.md 文件用 Bun 文本导入嵌进产物（构建时内联，无运行时文件依赖）。
import systemEvidenceReading from "./builtin/system-evidence-reading/SKILL.md" with {
  type: "text",
};
import systemMediaReading from "./builtin/system-media-reading/SKILL.md" with { type: "text" };
import systemQqMembers from "./builtin/system-qq-members/SKILL.md" with { type: "text" };
import systemQqReply from "./builtin/system-qq-reply/SKILL.md" with { type: "text" };
import systemTaskExecution from "./builtin/system-task-execution/SKILL.md" with { type: "text" };
import systemWebResearch from "./builtin/system-web-research/SKILL.md" with { type: "text" };

export interface SkillEntry {
  /** 外置技能的目录；系统技能没有目录（文本来自随包文档），该字段不存在而不是假路径。 */
  readonly dir?: string;
  readonly origin: SkillOrigin;
  readonly metadata: SkillMetadata;
  readonly revision: string;
}
export interface SkillCatalog {
  readonly skills: readonly SkillEntry[];
  readonly problems: readonly { skill: string; code: string }[];
}

function skillDirectory(dir: string): string {
  const absolute = path.resolve(dir);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new PermissionError("SKILL_PATH_ESCAPE");
  if (!info.isDirectory()) throw new PermissionError("SKILL_FILE_INVALID");
  const resolved = realpathSync(absolute);
  if (path.relative(absolute, resolved) !== "") throw new PermissionError("SKILL_PATH_ESCAPE");
  return resolved;
}

export function resolveSkillFile(dir: string, relative: string): string {
  try {
    const root = skillDirectory(dir);
    const candidate = path.resolve(root, relative);
    if (!containsPath(root, candidate)) throw new PermissionError("SKILL_PATH_ESCAPE");
    const resolved = realpathSync(candidate);
    if (!containsPath(root, resolved)) throw new PermissionError("SKILL_PATH_ESCAPE");
    if (!statSync(resolved).isFile()) throw new PermissionError("SKILL_FILE_INVALID");
    return resolved;
  } catch (error) {
    if (error instanceof PermissionError) throw error;
    throw new PermissionError("SKILL_FILE_INVALID");
  }
}

interface BoundedFileRequest {
  /** Absolute path, already produced by `resolveSkillFile`. */
  readonly resolved: string;
  /** Re-resolve the same path after opening it, to verify dev/ino did not change. */
  readonly recheck: () => string;
  /** Hard size bound in bytes. */
  readonly maxBytes: number;
  /** Code for a decode failure; the two callers classify "not text" differently. */
  readonly decodeErrorCode: string;
  /** Whether a NUL byte also means "not text" (resources require it, documents do not). */
  readonly rejectNul: boolean;
}

/**
 * Read one already-resolved file with a hard size bound, verifying the path still points at the
 * same file (dev/ino) before the bytes are trusted. `decodeErrorCode` and `rejectNul` keep the
 * document and resource callers' own error semantics.
 */
function readBoundedFile(request: BoundedFileRequest): { bytes: Uint8Array; text: string } {
  const { resolved, recheck, maxBytes, decodeErrorCode, rejectNul } = request;
  const fd = openSync(resolved, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new PermissionError("SKILL_FILE_INVALID");
    if (info.size > maxBytes) throw new PermissionError("SKILL_FILE_TOO_LARGE");
    const current = recheck();
    const currentInfo = statSync(current);
    if (current !== resolved || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino)
      throw new PermissionError("SKILL_FILE_INVALID");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      length += count;
      if (length > maxBytes) throw new PermissionError("SKILL_FILE_TOO_LARGE");
      if (count === 0) break;
    }
    const bytes = buffer.subarray(0, length);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new PermissionError(decodeErrorCode);
    }
    // A NUL means the bytes are not a text resource; the spec reads text only.
    if (rejectNul && text.includes("\u0000")) throw new PermissionError("SKILL_FILE_INVALID");
    return { bytes, text };
  } finally {
    closeSync(fd);
  }
}

function documentFile(dir: string): { dir: string; instructions: string; revision: string } {
  try {
    const root = skillDirectory(dir);
    if (!readdirSync(root).includes("SKILL.md"))
      throw new PermissionError("SKILL_DOCUMENT_INVALID");
    const resolved = resolveSkillFile(root, "SKILL.md");
    const { bytes, text: instructions } = readBoundedFile({
      resolved,
      recheck: () => resolveSkillFile(root, "SKILL.md"),
      maxBytes: DOCUMENT_MAX_BYTES,
      decodeErrorCode: "SKILL_DOCUMENT_INVALID",
      rejectNul: false,
    });
    return {
      dir: root,
      instructions,
      revision: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof PermissionError) throw error;
    throw new PermissionError("SKILL_FILE_INVALID");
  }
}

export interface SkillResourceFile {
  readonly text: string;
  readonly sha256: string;
}

/** Stable resource identity: sha256(documentRevision + "\n" + path + "\n" + fileSha256). */
export function skillResourceRevision(
  documentRevision: string,
  relative: string,
  fileSha256: string,
): string {
  return createHash("sha256")
    .update(`${documentRevision}\n${relative}\n${fileSha256}`)
    .digest("hex");
}

/** Read one text resource inside a skill directory; binary content never becomes text. */
export function readSkillResource(dir: string, relative: string): SkillResourceFile {
  try {
    const resolved = resolveSkillFile(dir, relative);
    const { bytes, text } = readBoundedFile({
      resolved,
      recheck: () => resolveSkillFile(dir, relative),
      maxBytes: DOCUMENT_MAX_BYTES,
      decodeErrorCode: "SKILL_FILE_INVALID",
      rejectNul: true,
    });
    return { text, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof PermissionError) throw error;
    throw new PermissionError("SKILL_FILE_INVALID");
  }
}

function parseMetadata(instructions: string): SkillMetadata {
  const opening = /^\uFEFF?---\r?\n/u.exec(instructions);
  if (!opening) throw new PermissionError("SKILL_DOCUMENT_INVALID");
  const closing = /(?<=\n)---(?=\r?\n|(?![\s\S]))/g;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(instructions);
  if (!end) throw new PermissionError("SKILL_DOCUMENT_INVALID");
  if (Buffer.byteLength(instructions.slice(opening[0].length, end.index)) > FRONTMATTER_MAX_BYTES)
    throw new PermissionError("SKILL_FILE_TOO_LARGE");
  let value: unknown;
  try {
    const document = parseDocument(instructions.slice(0, end.index), {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      resolveKnownTags: false,
      prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length || !isMap(document.contents))
      throw new PermissionError("SKILL_DOCUMENT_INVALID");
    visit(document, {
      Node(_key, node, ancestors) {
        if (ancestors.length > YAML_MAX_DEPTH || (node.tag && !YAML_CORE_TAG.test(node.tag)))
          throw new PermissionError("SKILL_DOCUMENT_INVALID");
        if (isAlias(node)) {
          const target = node.resolve(document);
          if (!target || ancestors.includes(target))
            throw new PermissionError("SKILL_DOCUMENT_INVALID");
        }
      },
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new PermissionError("SKILL_DOCUMENT_INVALID");
      },
    });
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new PermissionError("SKILL_DOCUMENT_INVALID");
  }
  const metadata = SkillMetadataSchema.safeParse(value);
  if (!metadata.success) throw new PermissionError("SKILL_METADATA_INVALID");
  return metadata.data;
}

export function loadSkill(dir: string): SkillEntry {
  const document = documentFile(dir);
  const metadata = parseMetadata(document.instructions);
  if (metadata.name !== path.basename(document.dir))
    throw new PermissionError("SKILL_NAME_MISMATCH");
  return { origin: "external", dir: document.dir, metadata, revision: document.revision };
}

/** 系统技能的文档以固定 revision 内嵌；读取只比对 revision，不需要也不制造目录。 */
export function readSkillDocument(
  skill: SkillEntry,
): Omit<SkillDetailResponse, "origin" | "globalEnabled"> {
  const instructions = skill.origin === "system" ? systemDocument(skill.metadata.name) : undefined;
  if (instructions !== undefined) {
    if (createHash("sha256").update(instructions).digest("hex") !== skill.revision)
      throw new PermissionError("PERMISSION_REVISION_CHANGED");
    return {
      ...skill.metadata,
      revision: skill.revision,
      instructions,
      bodyChars: [...instructions].length,
    };
  }
  const document = documentFile(requireDir(skill));
  if (document.revision !== skill.revision)
    throw new PermissionError("PERMISSION_REVISION_CHANGED");
  return {
    ...skill.metadata,
    revision: skill.revision,
    instructions: document.instructions,
    bodyChars: [...document.instructions].length,
  };
}

function requireDir(skill: SkillEntry): string {
  if (skill.dir === undefined) throw new PermissionError("SKILL_FILE_INVALID");
  return skill.dir;
}

const SYSTEM_DOCUMENTS: Record<string, string> = {
  "system-evidence-reading": systemEvidenceReading,
  "system-media-reading": systemMediaReading,
  "system-qq-reply": systemQqReply,
  "system-task-execution": systemTaskExecution,
  "system-web-research": systemWebResearch,
  "system-qq-members": systemQqMembers,
};

function systemDocument(name: string): string {
  const instructions = SYSTEM_DOCUMENTS[name];
  if (instructions === undefined) throw new PermissionError("SKILL_FILE_INVALID");
  return instructions;
}

/** 随包系统技能目录：只提供 SKILL.md，没有附加文件，任何资源读取都是 SKILL_FILE_INVALID。 */
export function readSkillEntryResource(entry: SkillEntry, relative: string): SkillResourceFile {
  if (entry.origin === "system") throw new PermissionError("SKILL_FILE_INVALID");
  return readSkillResource(requireDir(entry), relative);
}

/**
 * 技能根目录的唯一可列举性判据：缺失＝空目录（引用按不存在处理），其它读取失败＝整份不可用。
 * 全量列举与按来源复验共用这一份，避免两条路径对同一个根给出不同授权。
 */
function listSkillRoot(root: string): Dirent[] | undefined {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new PermissionError("SKILL_CATALOG_UNAVAILABLE");
  }
}

/**
 * 保持既有整份拒绝语义：根存在但不可列举时，连系统条目来源也必须 revoked。
 * 只做一次目录列举，不读任何技能正文。
 */
export function assertSkillRootListable(root: string | undefined): void {
  if (root !== undefined) listSkillRoot(root);
}

export function loadSkillCatalog(root: string): SkillCatalog {
  const entries = listSkillRoot(root);
  if (entries === undefined) return { skills: [], problems: [] };
  const skills: SkillEntry[] = [];
  const problems: { skill: string; code: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      if (entry.isSymbolicLink()) throw new PermissionError("SKILL_PATH_ESCAPE");
      const dir = skillDirectory(path.resolve(root, entry.name));
      const files = readdirSync(dir);
      if (!files.some((file) => file.toLowerCase() === "skill.md" || file === "skill.json"))
        continue;
      skills.push(loadSkill(dir));
    } catch (error) {
      problems.push({
        skill: entry.name,
        code: error instanceof PermissionError ? error.code : "SKILL_FILE_INVALID",
      });
    }
  }
  return { skills, problems };
}

/**
 * 系统组件名被外置技能占用时不替换：系统条目保持在列，外置冒名者进 problems
 * （SKILL_NAME_RESERVED），目录不会出现同名外部可读条目。
 */
export const SYSTEM_SKILL_NAMES: readonly string[] = Object.keys(SYSTEM_DOCUMENTS).sort();

/**
 * 随包系统文档是构建期内联常量：同样的字节每次解析只会得到同样的元数据与哈希，因此只解析一次。
 * 缓存不出本模块——装配目录时每次返回浅拷贝（含 metadata 浅拷贝），调用方能拿到的对象
 * 仍与原先逐次解析时一样可改、互不影响，也不会改到缓存。
 */
let systemEntriesCache: readonly SkillEntry[] | undefined;

const systemEntries = (): readonly SkillEntry[] =>
  (systemEntriesCache ??= SYSTEM_SKILL_NAMES.map((name) => {
    const instructions = systemDocument(name);
    const metadata = parseMetadata(instructions);
    if (metadata.name !== name) throw new PermissionError("SKILL_DOCUMENT_INVALID");
    return {
      origin: "system" as const,
      metadata,
      revision: createHash("sha256").update(instructions).digest("hex"),
    };
  }).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)));

/** 系统条目的当前文档修订：只暴露哈希，不暴露可被调用方修改的缓存对象。 */
export function systemSkillDocumentRevision(name: string): string | undefined {
  return systemEntries().find((entry) => entry.metadata.name === name)?.revision;
}

/**
 * 按名读取一个外置技能：只碰目标目录，保留 loadSkill 的全部边界检查
 * （符号链接拒绝、realpath 包含、SKILL.md 存在、大小上限、UTF-8/NUL、目录名=声明名、字节哈希）。
 * 名称形状先拒绝（无分隔符、不是 . / ..、不是系统保留名），避免用来源 id 拼出根外路径。
 */
export function loadSkillByName(root: string, name: string): SkillEntry {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name !== path.basename(name) ||
    SYSTEM_SKILL_NAMES.includes(name)
  )
    throw new PermissionError("SKILL_FILE_INVALID");
  return loadSkill(path.resolve(root, name));
}

export function loadMergedSkillCatalog(root?: string): SkillCatalog {
  // 每次装配返回新的数组与新条目对象（metadata 也浅拷贝）：缓存不外泄，调用方语义不变。
  const skills = systemEntries().map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
  const problems: { skill: string; code: string }[] = [];
  const reserved = new Set<string>(SYSTEM_SKILL_NAMES);
  if (root !== undefined) {
    const external = loadSkillCatalog(root);
    for (const entry of external.skills) {
      if (reserved.has(entry.metadata.name)) {
        problems.push({ skill: entry.metadata.name, code: "SKILL_NAME_RESERVED" });
        continue;
      }
      skills.push(entry);
    }
    problems.push(...external.problems);
  }
  skills.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return { skills, problems };
}
