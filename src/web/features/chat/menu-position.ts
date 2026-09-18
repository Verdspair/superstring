export function menuPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const gap = 8;
  const x =
    anchor.x + gap + size.width <= viewport.width - gap
      ? anchor.x + gap
      : anchor.x - size.width - gap;
  const y =
    anchor.y + gap + size.height <= viewport.height - gap
      ? anchor.y + gap
      : anchor.y - size.height - gap;
  return {
    left: Math.max(gap, Math.min(x, viewport.width - size.width - gap)),
    top: Math.max(gap, Math.min(y, viewport.height - size.height - gap)),
  };
}
