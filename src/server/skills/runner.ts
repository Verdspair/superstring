import path from "node:path";
import type { SkillScript } from "../../shared/contracts/skill";
import { processEnvironment } from "../permissions/process-environment";
import { resolveSkillFile } from "./config";

export type SkillRunOutcome =
  | { status: "ok"; output: string; durationMs: number }
  | { status: "unavailable"; code: string; output?: string; durationMs: number };
export interface SkillRunInput {
  skillDir: string;
  script: SkillScript;
  arguments: readonly string[];
  granted: readonly string[];
  signal: AbortSignal;
}

// Directory declarations describe consent; a native process is not an OS sandbox.
function scriptEnvironment(skillDir: string, granted: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {
    ...processEnvironment(),
    SUPERSTRING_SKILL_DIR: skillDir,
    SUPERSTRING_SKILL_DIRS: JSON.stringify(granted),
    SUPERSTRING_SKILL_NETWORK: "allow",
    NO_COLOR: "1",
  };
  return env;
}

export async function runSkillScript(input: SkillRunInput): Promise<SkillRunOutcome> {
  const { skillDir, script, signal } = input;
  signal.throwIfAborted();
  const entry = resolveSkillFile(skillDir, script.path);
  const started = Date.now();
  const child = Bun.spawn([script.command, ...script.args, entry, ...input.arguments], {
    cwd: path.resolve(skillDir),
    env: scriptEnvironment(skillDir, input.granted),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let overflowed = false;
  let bytes = 0;
  const output: string[] = [];
  const onAbort = () => child.kill();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, script.timeoutMs);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          output.push(decoder.decode());
          break;
        }
        bytes += value.byteLength;
        if (bytes > script.maxOutputChars * 4) {
          overflowed = true;
          child.kill();
          break;
        }
        output.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };
  try {
    await Promise.all([pump(child.stdout), pump(child.stderr)]);
    const exitCode = await child.exited;
    signal.throwIfAborted();
    const durationMs = Date.now() - started;
    const text = output.join("").trimEnd();
    if (overflowed || [...text].length > script.maxOutputChars)
      return { status: "unavailable", code: "SKILL_OUTPUT_TOO_LARGE", durationMs };
    if (timedOut) return { status: "unavailable", code: "SKILL_TIMEOUT", durationMs };
    return exitCode === 0
      ? { status: "ok", output: text, durationMs }
      : { status: "unavailable", code: "SKILL_EXIT_NONZERO", output: text, durationMs };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    child.kill();
    await child.exited;
  }
}
