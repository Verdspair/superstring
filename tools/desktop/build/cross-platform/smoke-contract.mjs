export function validateSmokeReport(report, identity) {
  if (report?.ok !== true) throw new Error("DESKTOP_SMOKE_FAILED");
  for (const key of ["platform", "arch", "version"]) {
    if (report[key] !== identity[key]) throw new Error(`DESKTOP_SMOKE_IDENTITY_MISMATCH:${key}`);
  }
  for (const check of ["backend", "renderer", "authentication", "gracefulStop"]) {
    if (report.checks?.[check] !== true) throw new Error(`DESKTOP_SMOKE_CHECK_MISSING:${check}`);
  }
}
