/** Check the explicit fs.existsSync(path.join(installRoot, resource)) form used by setup.
 * Counting filenames alone accepts unused arguments and && inside an argument. Require
 * each migration to have its own complete, single-argument existence call instead.
 */
export function checkSetupMigrationExistence(text, migrations) {
  const checked = [
    ...text.matchAll(
      /fs\.existsSync\(\s*path\.join\(\s*installRoot,\s*"app\/resources\/migrations\/versions\/(\d{4}_[a-z_]+\.sql)"\s*,?\s*\)\s*,?\s*\)/g,
    ),
  ].map((match) => match[1]);
  const problems = [];
  for (const name of migrations) {
    const count = checked.filter((entry) => entry === name).length;
    if (count !== 1)
      problems.push(`verify-setup.mjs: ${name} has ${count} independent existence checks`);
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
