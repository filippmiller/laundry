export function formatRub(kopeks: number) {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopeks / 100);
}

export function assertKopeks(value: number, label = "amount") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}

export function sumKopeks(values: number[]) {
  return values.reduce((total, value) => total + assertKopeks(value), 0);
}
