import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Protect both old-case and already-lowercase builds. Never discard an earlier
// recovery file or swallow a failed restore. All paths are build artifacts.
export function prepareCaseSlot(outDir, finalBase) {
  if (path.basename(finalBase) !== finalBase || finalBase !== finalBase.toLowerCase()) {
    throw new Error("Expected a lowercase executable basename");
  }
  const matches = fs.readdirSync(outDir).filter((name) => name.toLowerCase() === finalBase);
  if (matches.length > 1) throw new Error("Ambiguous executable names; refusing to overwrite");
  const oldCase = matches[0] ?? null;
  const target = path.join(outDir, finalBase);
  const backup = oldCase ? path.join(outDir, `${finalBase}.${randomUUID()}.build-backup`) : null;
  if (oldCase) {
    const original = path.join(outDir, oldCase);
    if (!fs.lstatSync(original).isFile()) throw new Error("Executable slot is not a regular file");
    fs.renameSync(original, backup);
  }
  let finished = false;
  return {
    oldCase,
    backup,
    restore() {
      if (finished) throw new Error("Build transaction already finished");
      // A failed compiler may have left a partial output in our reserved slot.
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (backup) fs.renameSync(backup, path.join(outDir, oldCase));
      finished = true;
    },
    commit() {
      if (finished) throw new Error("Build transaction already finished");
      if (
        !fs.readdirSync(outDir).includes(finalBase) ||
        !fs.statSync(target).isFile() ||
        fs.statSync(target).size === 0
      ) {
        throw new Error(`Build output missing or empty; recovery retained: ${backup ?? "none"}`);
      }
      if (backup) fs.unlinkSync(backup);
      finished = true;
    },
  };
}
