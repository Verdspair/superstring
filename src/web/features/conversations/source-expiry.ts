/** Shared source retention clock. It owns no content, cache, or read lifecycle. */
export function sourceExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || now >= Date.parse(expiresAt));
}
export function scheduleSourceExpiry(
  caps: readonly (string | null | undefined)[],
  expire: () => void,
): () => void {
  const times = caps
    .filter((cap): cap is string => !!cap)
    .map(Date.parse)
    .filter(Number.isFinite);
  if (!times.length) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    const wait = Math.min(...times) - Date.now();
    if (wait <= 0) {
      timer = null;
      expire();
      return;
    }
    timer = setTimeout(tick, Math.min(2_147_483_647, wait));
  };
  tick();
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}
