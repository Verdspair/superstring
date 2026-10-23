/**
 * Validates the report the packaged Electron host wrote before it exited.
 *
 * Every value here is self-reported by that host. `closeStopsBackend` in particular is
 * written before the window closes, so it states the approved close path
 * (terminate the owned backend, then leave) rather than proving the backend's process
 * tree is gone. The runner still has to wait for the host to exit, and an independent
 * descendant check belongs to the native lifecycle run, not this file.
 */
export function validateSmokeReport(report, identity) {
  if (report?.ok !== true) throw new Error("DESKTOP_SMOKE_FAILED");
  for (const key of ["platform", "arch", "version"]) {
    if (report[key] !== identity[key]) throw new Error(`DESKTOP_SMOKE_IDENTITY_MISMATCH:${key}`);
  }
  // The approved lifecycle is direct exit: close terminates the owned backend and the
  // host leaves without waiting for a graceful drain. A report claiming the retired
  // graceful-stop path is stale or describes a different host.
  if (report.checks?.gracefulStop === true)
    throw new Error("DESKTOP_SMOKE_GRACEFUL_STOP_RETIRED:gracefulStop");
  for (const check of ["backend", "renderer", "authentication", "directExit"]) {
    if (report.checks?.[check] !== true) throw new Error(`DESKTOP_SMOKE_CHECK_MISSING:${check}`);
  }
  if (report.checks?.closeStopsBackend !== true)
    throw new Error("DESKTOP_SMOKE_CLOSE_CLAIM_MISSING:closeStopsBackend");
}
