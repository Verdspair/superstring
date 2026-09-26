import type { Readable } from "node:stream";

/** The managed host owns stdin's write end; EOF also covers a crashed host. */
export function watchDesktopParent(
  onDisconnect: () => void,
  input: Readable = process.stdin,
): () => void {
  let finished = false;
  const dispose = () => {
    finished = true;
    input.off("end", disconnected);
    input.off("close", disconnected);
    input.off("error", disconnected);
    input.pause();
  };
  const disconnected = () => {
    if (finished) return;
    dispose();
    onDisconnect();
  };
  input.once("end", disconnected);
  input.once("close", disconnected);
  input.once("error", disconnected);
  if (input.readableEnded || input.destroyed) queueMicrotask(disconnected);
  else input.resume();
  return dispose;
}
