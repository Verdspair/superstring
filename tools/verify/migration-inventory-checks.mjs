/**
 * Verify-setup's fresh-install check must prove every business migration with its own
 * complete fs.existsSync(path.join(installRoot, "…/NAME.sql")) call, and those calls must be
 * the direct && operands of that check call's pass expression. Counting filenames across the
 * whole file would accept copies parked in a detail argument or anywhere else, so the check
 * call is located by its name and only its second (pass) argument is counted. The scanner
 * handles the current source style (quoted strings, nested brackets); it is not a general
 * JavaScript parser.
 */
const FRESH_MIGRATION_CHECK_NAME = '"fresh install writes the business migration"';
const EXISTENCE_CALL =
  /^fs\.existsSync\(\s*path\.join\(\s*installRoot,\s*"app\/resources\/migrations\/versions\/(\d{4}_[a-z_]+\.sql)"\s*,?\s*\)\s*,?\s*\)$/;
const EXISTENCE_CALLS =
  /fs\.existsSync\(\s*path\.join\(\s*installRoot,\s*"app\/resources\/migrations\/versions\/(\d{4}_[a-z_]+\.sql)"\s*,?\s*\)\s*,?\s*\)/g;

/** Split the bracketed group opening at openIndex at its top-level separators. */
function splitTopLevelArgs(source, separator, openIndex) {
  const parts = [];
  let part = "";
  let depth = 1;
  let quote = null;
  let index = openIndex + 1;
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === "\\") {
        part += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        parts.push(part);
        return { parts, closeIndex: index };
      }
    } else if (depth === 1 && source.startsWith(separator, index)) {
      parts.push(part);
      part = "";
      index += separator.length;
      continue;
    }
    part += char;
    index += 1;
  }
  return { parts: [], closeIndex: -1 };
}

export function checkSetupMigrationExistence(text, migrations) {
  const problems = [];
  const calls = [];
  let index = text.indexOf("check(");
  while (index !== -1) {
    if (!/[A-Za-z0-9_$.]/.test(index === 0 ? "" : text[index - 1])) {
      const args = splitTopLevelArgs(text, ",", index + 5).parts.map((part) => part.trim());
      if (args.length > 0 && args[args.length - 1] === "") args.pop();
      if (args[0] === FRESH_MIGRATION_CHECK_NAME) calls.push(args);
    }
    index = text.indexOf("check(", index + 1);
  }
  if (calls.length !== 1) {
    problems.push(
      `verify-setup.mjs: expected exactly one check(${FRESH_MIGRATION_CHECK_NAME}, …) call, found ${calls.length}`,
    );
    return problems;
  }
  const pass = calls[0][1] ?? "";
  const extra = calls[0].slice(2);
  if (extra.length > 0) {
    problems.push(
      `verify-setup.mjs: fresh-install migration check must have exactly (name, pass) arguments, found ${extra.length + 2}`,
    );
  }
  const checked = [...pass.matchAll(EXISTENCE_CALLS)].map((match) => match[1]);
  for (const operand of splitTopLevelArgs(`(${pass})`, "&&", 0).parts) {
    if (!EXISTENCE_CALL.test(operand.trim())) {
      problems.push(
        `verify-setup.mjs: fresh-install pass expression must chain independent fs.existsSync(path.join(installRoot, …)) calls, found: ${operand.trim().slice(0, 120)}`,
      );
    }
  }
  for (const migration of migrations) {
    const count = checked.filter((entry) => entry === migration).length;
    if (count !== 1)
      problems.push(`verify-setup.mjs: ${migration} has ${count} independent existence checks`);
  }
  return problems;
}

/** Current package identity must agree at both JS build/policy and native acceptance. */
export function checkInstallerSchemaVersions(read, current) {
  const versions = [
    ["tools/setup/src/Manifest.cs", /SupportedSchemaVersion\s*=\s*(\d+)/],
    [
      "tools/desktop/src/DesktopLayout.cs",
      /RequireInteger\(manifest,\s*"businessSchemaVersion",\s*(\d+)\)/,
    ],
    ["tools/installer/build-service.mjs", /businessSchemaVersion:\s*(\d+)/],
    ["tools/installer/build-package.mjs", /businessSchemaVersion:\s*(\d+)/],
    ["tools/installer/upgrade-policy.mjs", /businessSchemaVersion !== (\d+)/],
  ];
  const problems = [];
  for (const [file, pattern] of versions) {
    const version = read(file).match(pattern)?.[1];
    if (Number(version) !== current)
      problems.push(`${file}: current schema ${version ?? "missing"}, filesystem has ${current}`);
  }
  const policy = read("tools/installer/upgrade-policy.mjs");
  const known = policy.match(/!\[([\s\d,]+)\]\.includes\(manifest\.businessSchemaVersion\)/)?.[1];
  const accepted = known?.match(/\d+/g)?.map(Number) ?? [];
  const expected = Array.from({ length: current }, (_, index) => index + 1);
  if (JSON.stringify(accepted) !== JSON.stringify(expected))
    problems.push(
      `upgrade-policy: supported schema list must include versions 1 through ${current}`,
    );
  return problems;
}
