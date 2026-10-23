// RT-1 by-name skill source read: equivalence contract pinned BEFORE the change.
// Every assertion here is the current whole-catalog verdict; the narrowed read must keep it.
// Fixtures are synthetic temp dirs under artifacts/validation (same convention as skills.test.ts).

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  loadMergedSkillCatalog,
  readSkillEntryResource,
  SYSTEM_SKILL_NAMES,
  skillResourceRevision,
} from "../../src/server/skills/config";
import { skillSourceAccess } from "../../src/server/skills/sources";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const fixtureRoot = path.resolve(
  import.meta.dir,
  "../../artifacts/validation/skill-source-read-work",
);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function document(name: string, description = "Synthetic fixture skill", body = "body") {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
}

function baseDirectory(): string {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(path.join(fixtureRoot, "case-"));
  directories.push(directory);
  return directory;
}

function install(root: string, folder: string, text = document(folder)): string {
  const directory = path.join(root, folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), text);
  return directory;
}

const source = (kind: "skill_document" | "skill_resource", id: string, revision: string) =>
  ({ kind, id, revision }) as SourceRef;
const missingRevision = "0".repeat(64);
const systemName = SYSTEM_SKILL_NAMES[0]!;
const systemEntry = () =>
  loadMergedSkillCatalog(undefined).skills.find((entry) => entry.metadata.name === systemName)!;

/**
 * Oracle = today's whole-catalog semantics (new sources.ts calls into it indirectly).
 * After the by-name change this oracle stays the reference; the implementation must match it.
 */
function catalogVerdict(
  root: string | undefined,
  ref: SourceRef,
): "available" | "revoked" | undefined {
  if (ref.kind !== "skill_document" && ref.kind !== "skill_resource") return undefined;
  try {
    const catalog = loadMergedSkillCatalog(root);
    if (ref.kind === "skill_document") {
      const entry = catalog.skills.find((skill) => skill.metadata.name === ref.id);
      return entry && entry.revision === ref.revision ? "available" : "revoked";
    }
    const slash = ref.id.indexOf("/");
    if (slash <= 0 || slash === ref.id.length - 1) return "revoked";
    const entry = catalog.skills.find((skill) => skill.metadata.name === ref.id.slice(0, slash));
    if (!entry) return "revoked";
    const relative = ref.id.slice(slash + 1);
    const resource = readSkillEntryResource(entry, relative);
    return skillResourceRevision(entry.revision, relative, resource.sha256) === ref.revision
      ? "available"
      : "revoked";
  } catch {
    return "revoked";
  }
}

function revisionOf(documentText: string): string {
  return createHash("sha256").update(documentText).digest("hex");
}

describe("skill source reads: whole-catalog equivalence contract", () => {
  it("keeps a valid skill available while unrelated entries are invalid", () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    install(root, "demo");
    install(root, "broken", "no frontmatter at all");
    writeFileSync(path.join(root, "plain-file"), "not a skill directory");
    writeFileSync(path.join(path.join(root, "demo"), "unrelated.txt"), "extra bytes");
    const revision = revisionOf(document("demo"));

    expect(skillSourceAccess(root, source("skill_document", "demo", revision))).toBe("available");
    expect(skillSourceAccess(root, source("skill_document", "broken", missingRevision))).toBe(
      "revoked",
    );
    expect(skillSourceAccess(root, source("skill_document", "plain-file", missingRevision))).toBe(
      "revoked",
    );
    // The unrelated invalid entries must not turn the whole catalog into a refusal.
    expect(loadMergedSkillCatalog(root).skills.map((entry) => entry.metadata.name)).toContain(
      "demo",
    );
  });

  it("keeps name-mismatched folders and duplicate claims out of the name space", () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    const real = install(root, "demo");
    // Folder name and declared name must agree; a folder cannot donate another folder's name.
    install(root, "wrong-folder", document("claimed-elsewhere"));
    install(root, "demo-copy", document("demo"));
    const revision = revisionOf(document("demo"));

    expect(skillSourceAccess(root, source("skill_document", "demo", revision))).toBe("available");
    expect(skillSourceAccess(root, source("skill_document", "wrong-folder", missingRevision))).toBe(
      "revoked",
    );
    expect(
      skillSourceAccess(root, source("skill_document", "claimed-elsewhere", missingRevision)),
    ).toBe("revoked");
    expect(skillSourceAccess(root, source("skill_document", "demo-copy", missingRevision))).toBe(
      "revoked",
    );
    // A mismatched duplicate never shadows the real entry.
    expect(
      loadMergedSkillCatalog(root).skills.filter((entry) => entry.metadata.name === "demo"),
    ).toHaveLength(1);
    expect(path.basename(real)).toBe("demo");
  });

  it("never lets an external folder shadow a reserved system name", () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    const externalText = document(systemName, "imposter");
    install(root, systemName, externalText);
    const system = systemEntry();
    const externalRevision = revisionOf(externalText);

    // System revision wins; the external bytes never become an authorized document.
    expect(skillSourceAccess(root, source("skill_document", systemName, system.revision))).toBe(
      "available",
    );
    expect(skillSourceAccess(root, source("skill_document", systemName, externalRevision))).toBe(
      "revoked",
    );
    expect(
      skillSourceAccess(undefined, source("skill_document", systemName, system.revision)),
    ).toBe("available");
    // System components have no resources.
    expect(
      skillSourceAccess(root, source("skill_resource", `${systemName}/notes.txt`, missingRevision)),
    ).toBe("revoked");
  });

  it("rejects case-aliased folders instead of resolving them by name", () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    install(root, "Case-Skill", document("case-skill"));
    expect(skillSourceAccess(root, source("skill_document", "case-skill", missingRevision))).toBe(
      "revoked",
    );
    expect(skillSourceAccess(root, source("skill_document", "Case-Skill", missingRevision))).toBe(
      "revoked",
    );
  });

  it("rejects a symlinked root exactly like the catalog does", () => {
    const base = baseDirectory();
    const realRoot = path.join(base, "skills-real");
    install(realRoot, "demo");
    const linkRoot = path.join(base, "skills-link");
    try {
      symlinkSync(realRoot, linkRoot, "dir");
    } catch {
      return; // Symlink creation needs privileges on some hosts; the case is environment-dependent.
    }
    const revision = revisionOf(document("demo"));
    // The catalog rejects path-relative containment through the link; a by-name read must too.
    expect(skillSourceAccess(linkRoot, source("skill_document", "demo", revision))).toBe("revoked");
    expect(skillSourceAccess(realRoot, source("skill_document", "demo", revision))).toBe(
      "available",
    );
  });

  it("refuses roots that are not readable skill directories", () => {
    const base = baseDirectory();
    const notDirectory = path.join(base, "root-file");
    writeFileSync(notDirectory, "synthetic");
    const ref = source("skill_document", "demo", missingRevision);
    expect(skillSourceAccess(notDirectory, ref)).toBe("revoked");
    expect(skillSourceAccess(path.join(base, "missing-root"), ref)).toBe("revoked");

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // No list permission: the whole-catalog path refuses every ref, including system entries.
      const locked = path.join(base, "locked-root");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        expect(skillSourceAccess(locked, ref)).toBe("revoked");
      } finally {
        chmodSync(locked, 0o700);
      }
      // Execute-only root: child paths stay readable by name, but listing fails. A by-name read
      // must not turn today's wholesale refusal into an available verdict.
      const traversalOnly = path.join(base, "traversal-only-root");
      install(traversalOnly, "demo");
      chmodSync(traversalOnly, 0o111);
      try {
        expect(
          skillSourceAccess(
            traversalOnly,
            source("skill_document", "demo", revisionOf(document("demo"))),
          ),
        ).toBe("revoked");
        expect(
          skillSourceAccess(
            traversalOnly,
            source("skill_document", systemName, systemEntry().revision),
          ),
        ).toBe("revoked");
      } finally {
        chmodSync(traversalOnly, 0o700);
      }
    }
  });

  it("keeps skillSourceAccess identical to the whole-catalog verdict across the fixture matrix", () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    const demoText = document("demo");
    const demo = install(root, "demo", demoText);
    mkdirSync(path.join(demo, "references"));
    const resourceText = "resource body";
    writeFileSync(path.join(demo, "references", "notes.txt"), resourceText);
    install(root, "broken", "no frontmatter");
    install(root, "wrong-folder", document("claimed-elsewhere"));
    install(root, systemName, document(systemName, "imposter"));
    const demoRevision = revisionOf(demoText);
    const resourceRevision = skillResourceRevision(
      demoRevision,
      "references/notes.txt",
      createHash("sha256").update(resourceText).digest("hex"),
    );
    const system = systemEntry();

    const refs: SourceRef[] = [
      source("skill_document", "demo", demoRevision),
      source("skill_document", "demo", missingRevision),
      source("skill_document", "broken", missingRevision),
      source("skill_document", "wrong-folder", missingRevision),
      source("skill_document", "claimed-elsewhere", missingRevision),
      source("skill_document", systemName, system.revision),
      source("skill_document", systemName, missingRevision),
      source("skill_resource", "demo/references/notes.txt", resourceRevision),
      source("skill_resource", "demo/references/notes.txt", missingRevision),
      source("skill_resource", "demo/missing.txt", missingRevision),
      source("skill_resource", "demo/../escape.txt", missingRevision),
      source("skill_resource", `${systemName}/notes.txt`, missingRevision),
    ];
    const roots = [root, undefined, path.join(base, "missing-root")] as const;

    for (const scope of roots) {
      for (const ref of refs) {
        expect({ root: scope ?? "<none>", ref, verdict: skillSourceAccess(scope, ref) }).toEqual({
          root: scope ?? "<none>",
          ref,
          verdict: catalogVerdict(scope, ref),
        });
      }
    }
  });
});
