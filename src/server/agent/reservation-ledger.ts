/** Same-batch in-flight result increments. Admission and registration are synchronous. */
export class ReservationLedger {
  private readonly units = new Map<
    symbol,
    Partial<Record<"bytes" | "tokens" | "capacity", number>>
  >();
  set(token: symbol, value: number, group: "bytes" | "tokens" | "capacity" = "bytes"): void {
    const entry = this.units.get(token) ?? {};
    entry[group] = value;
    this.units.set(token, entry);
  }
  /** Excludes the fitter's own last accepted increment in the selected counting mode. */
  reserved(except?: symbol, group: "bytes" | "tokens" | "capacity" = "bytes"): number {
    let total = 0;
    for (const [key, units] of this.units) if (key !== except) total += units[group] ?? 0;
    return total;
  }
  clear(): void {
    this.units.clear();
  }
}
