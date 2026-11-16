export type QuoteLine = Readonly<{ code: string; amountKopeks: number }>;
export function quoteTotal(lines: readonly QuoteLine[]): number {
  return lines.reduce((sum, line) => {
    if (!Number.isSafeInteger(line.amountKopeks) || line.amountKopeks < 0) {
      throw new Error("INVALID_MONEY");
    }
    const next = sum + line.amountKopeks;
    if (!Number.isSafeInteger(next)) throw new Error("MONEY_OVERFLOW");
    return next;
  }, 0);
}
export function offScheduleFees(pickup: boolean, delivery: boolean, feeKopeks = 50000): QuoteLine[] {
  if (!Number.isSafeInteger(feeKopeks) || feeKopeks < 0) throw new Error("INVALID_FEE");
  return [
    { code: "pickup_off_schedule", amountKopeks: pickup ? feeKopeks : 0 },
    { code: "delivery_off_schedule", amountKopeks: delivery ? feeKopeks : 0 },
  ];
}
