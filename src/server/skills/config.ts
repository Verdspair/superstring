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
} from "../../shared/contracts/skill";
import { containsPath, PermissionError } from "../permissions/service";

const DOCUMENT_MAX_BYTES = 1_048_576;
const FRONTMATTER_MAX_BYTES = 65_536;
const YAML_MAX_DEPTH = 32;
const YAML_CORE_TAG = /^tag:yaml\.org,2002:(?:str|map|seq|null|bool|int|float)$/;

export interface SkillEntry {
  readonly dir: string;
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
  return { dir: document.dir, metadata, revision: document.revision };
}

export function readSkillDocument(skill: SkillEntry): SkillDetailResponse {
  const document = documentFile(skill.dir);
  if (document.revision !== skill.revision)
    throw new PermissionError("PERMISSION_REVISION_CHANGED");
  return {
    ...skill.metadata,
    revision: skill.revision,
    instructions: document.instructions,
    bodyChars: [...document.instructions].length,
  };
}

export function loadSkillCatalog(root: string): SkillCatalog {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { skills: [], problems: [] };
    throw new PermissionError("SKILL_CATALOG_UNAVAILABLE");
  }
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
