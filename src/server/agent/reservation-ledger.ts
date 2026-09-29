/**
 * 同批在飞只读动作的预算预留账本：token→投影增量。检查与登记必须落在同一同步块内完成，
 * 才能消除并发竞态（JS 单线程）——两个通道此前各持一份同款实现，行为一致。
 */
export class ReservationLedger {
  private readonly units = new Map<symbol, number>();
  set(token: symbol, value: number): void {
    this.units.set(token, value);
  }
  /** 在飞预留总和；`except` 用于排除 fitter 自己那笔。 */
  reserved(except?: symbol): number {
    let total = 0;
    for (const [key, units] of this.units) if (key !== except) total += units;
    return total;
  }
  clear(): void {
    this.units.clear();
  }
}
