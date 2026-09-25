// Migration inventory completeness check (ADR0018; see product policy).
//
// Why this exists: a schema version bump has to be mirrored in roughly 25 hardcoded lists.
// Most of them are covered by `verify-all`, but the C# files and `verify-setup.mjs` are NOT
// part of the gate's five checks, and `node --check` only proves those files parse. Two real
// mistakes got past both of those: a bulk replace that REPLACED an existing migration entry
// instead of appending after it, and a repair that put `&&` inside an `existsSync()` argument
// so the older entry was never checked at all. Green gate, valid syntax, wrong inventory.
//
// So this script asserts the inventories directly, from the filesystem, and is meant to be run
// after every schema change (and can be wired into the gate later).
//
// Usage: bun tools/verify/verify-migration-inventory.mjs   (cwd = dev root)

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const migrations = readdirSync(path.join(root, "migrations/versions"))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const problems = [];

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

/** Every migration referenced by a file, in the order the file mentions them. */
function referenced(text) {
  return [...text.matchAll(/(\d{4})_[a-z_]+\.sql/g)].map((match) => match[0]);
}

// 1. schema-gate: version, file list, tuple type and loader must agree with the filesystem.
{
  const gate = read("src/server/db/schema-gate.ts");
  const version = Number(gate.match(/BUSINESS_SCHEMA_VERSION\s*=\s*(\d+)\s+as\s+const/)?.[1]);
  const listed = [...gate.matchAll(/^ {2}"(\d{4}_[a-z_]+\.sql)",$/gm)].map((m) => m[1]);
  const tuple = gate.slice(
    gate.indexOf("export type BusinessMigrationSql"),
    gate.indexOf("];", gate.indexOf("export type BusinessMigrationSql")),
  );
  const tupleCount = (tuple.match(/^ {2}string,$/gm) ?? []).length;
  const loaderCount = (gate.match(/BUSINESS_MIGRATION_FILES\[\d+\]/g) ?? []).length;
  if (version !== migrations.length)
    problems.push(`schema-gate version ${version} != ${migrations.length} files`);
  if (listed.length !== migrations.length)
    problems.push(`schema-gate file list has ${listed.length} entries`);
  if (tupleCount !== migrations.length)
    problems.push(`BusinessMigrationSql tuple has ${tupleCount} strings`);
  if (loaderCount !== migrations.length)
    problems.push(`loadMigrationSql reads ${loaderCount} files`);
  if (JSON.stringify(listed) !== JSON.stringify(migrations)) {
    problems.push("schema-gate file list order/content differs from migrations/versions");
  }
}

// 2. Every other inventory that names all migrations must name each one exactly once (or, for
//    the per-version guards, at least once). A duplicate is as wrong as a miss: it means an
//    entry was appended where it should have replaced, or vice versa.
const fullInventories = [
  "src/server/app-paths.ts",
  "tools/installer/package-files.mjs",
  "tools/setup/src/Payload.cs",
  "tools/desktop/src/DesktopLayout.cs",
  "tools/verify/verify-setup.mjs",
  "tools/verify/knowledge-manifest-fixture.cs",
  // The test-side aggregates are hand-maintained too. `db-schema.test.ts` concatenates every
  // migration by hand so the reference DB is complete; 0034 was added to schema.ts and to the
  // migrations directory but NOT to that list, so the anti-drift test and the schema gate both
  // failed while this script stayed green (it did not know that list existed). Duplicates are
  // not asserted here: `migration-resource.test.ts` repeats filenames by design.
  "tests/integration/db-schema.test.ts",
  "tests/integration/knowledge-schema.test.ts",
  "tests/integration/migration-resource.test.ts",
  "tests/integration/qq-transport-schema.test.ts",
];
for (const file of fullInventories) {
  const found = referenced(read(file));
  const unique = new Set(found);
  const missing = migrations.filter((name) => !unique.has(name));
  const extra = [...unique].filter((name) => !migrations.includes(name));
  if (missing.length) problems.push(`${file}: missing ${missing.join(", ")}`);
  if (extra.length) problems.push(`${file}: references unknown ${extra.join(", ")}`);
}

// startup-layout.ts reads its resources through path keys rather than filenames, so what has
// to hold there is one read per migration. The key definitions themselves are checked by the
// filename pass above (app-paths.ts declares each path with its filename in it).
{
  const layout = read("src/server/startup-layout.ts");
  const reads = layout.match(/readFileSync\(paths\.[a-zA-Z]+Migration,/g) ?? [];
  if (reads.length !== migrations.length) {
    problems.push(
      `startup-layout.ts reads ${reads.length} resources, expected ${migrations.length}`,
    );
  }
}

// 3. Manifest.cs guards one version at a time; the chain must have no gaps.
{
  const manifest = read("tools/setup/src/Manifest.cs");
  const guarded = [
    ...manifest.matchAll(
      /SchemaVersion >= (\d+) && !seen\.Contains\("app\/resources\/migrations\/versions\/(\d{4})_/g,
    ),
  ].map((m) => ({ version: Number(m[1]), migration: Number(m[2]) }));
  for (const entry of guarded) {
    if (entry.version !== entry.migration) {
      problems.push(
        `Manifest.cs: guard for v${entry.version} names ${String(entry.migration).padStart(4, "0")}`,
      );
    }
  }
  const guardedNumbers = new Set(guarded.map((entry) => entry.version));
  // v1 is the baseline and has no guard.
  for (let version = 2; version <= migrations.length; version += 1) {
    if (!guardedNumbers.has(version))
      problems.push(`Manifest.cs: no guard for schema >= ${version}`);
  }
}

// 4. verify-setup.mjs: the existence check must be its own call per migration. A `&&` inside
//    the argument list would silently check only the last path.
{
  const text = read("tools/verify/verify-setup.mjs");
  const wrong = [...text.matchAll(/existsSync\(\s*path\.join\([^)]*\)\s*&&/g)];
  if (wrong.length) problems.push("verify-setup.mjs: `&&` inside an existsSync() argument");
  for (const name of migrations) {
    const count = text.split(name).length - 1;
    if (count !== 1) problems.push(`verify-setup.mjs: ${name} referenced ${count} times`);
  }
}

// 5. The installer policy must accept exactly the current version.
{
  const policy = read("tools/installer/upgrade-policy.mjs");
  const accepted = policy.match(/businessSchemaVersion !== (\d+)/)?.[1];
  if (Number(accepted) !== migrations.length) {
    problems.push(`upgrade-policy accepts ${accepted}, filesystem has ${migrations.length}`);
  }
  for (const file of ["tools/installer/build-service.mjs", "tools/installer/build-package.mjs"]) {
    const declared = read(file).match(/businessSchemaVersion: (\d+)/)?.[1];
    if (Number(declared) !== migrations.length) {
      problems.push(`${file} declares ${declared}, filesystem has ${migrations.length}`);
    }
  }
}

// 6. `db-schema.test.ts` assembles its reference database from one constant per migration, so a
//    filename appearing somewhere in the file proves nothing: the constant has to be *used* by
//    `ALL_MIGRATION_SQL`. Both halves were wrong at different times — 0034 was missing entirely
//    (no constant at all), and a declared-but-never-concatenated constant reads the file,
//    satisfies any filename scan, and still leaves the reference DB short one column. Paths are
//    often indirected (`MIGRATION_PATH` then `readFileSync(MIGRATION_PATH, ...)`), so resolve one
//    level of indirection instead of matching only the inline `path.join(..., "00NN_...sql")`.
{
  const file = "tests/integration/db-schema.test.ts";
  const text = read(file);
  const start = text.indexOf("const ALL_MIGRATION_SQL");
  const aggregate = text.slice(start, text.indexOf(";", start));
  const bodies = new Map(
    [...text.matchAll(/const (\w+) = ([^;]*);/gs)].map((match) => [match[1], match[2]]),
  );
  /** Migration filenames a constant resolves to, following one level of indirection. */
  const filesOf = (name, depth = 0, seen = new Set()) => {
    const body = bodies.get(name);
    if (body === undefined || seen.has(name) || depth > 2) return [];
    const next = new Set(seen).add(name);
    const direct = [...body.matchAll(/\d{4}_[a-z_]+\.sql/g)].map((match) => match[0]);
    if (direct.length) return direct;
    return (body.match(/[A-Za-z_$][\w$]*/g) ?? []).flatMap((id) => filesOf(id, depth + 1, next));
  };
  const constants = [...bodies.keys()];
  for (const name of migrations) {
    const readers = constants.filter((constant) => filesOf(constant).includes(name));
    if (readers.length === 0) {
      problems.push(`${file}: no constant reads ${name}`);
    } else if (!readers.some((constant) => aggregate.includes(constant))) {
      problems.push(
        `${file}: ${readers.join("/")} reads ${name} but is never concatenated into ALL_MIGRATION_SQL`,
      );
    }
  }
}

if (problems.length) {
  console.error(`[FAIL] migration inventory (${migrations.length} migrations)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `[PASS] migration inventory: ${migrations.length} migrations, all lists complete and consistent`,
);
