/** Integer-cent money helpers. Never use IEEE floats for amounts. */

const MONEY_RE = /^[0-9]+(\.[0-9]{1,2})?$/;

export function assertMoney(value: string, label = "amount"): void {
  if (!MONEY_RE.test(value)) {
    throw new Error(`${label} must be a decimal string, got ${JSON.stringify(value)}`);
  }
}

export function toCents(amount: string): bigint {
  assertMoney(amount);
  const [whole, frac = ""] = amount.split(".");
  const frac2 = (frac + "00").slice(0, 2);
  return BigInt(whole) * 100n + BigInt(frac2);
}

export function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

export function normalizeMoney(amount: string): string {
  return fromCents(toCents(amount));
}

/** `percent` is "2" or "2.00" meaning 2%. Result is a money string. */
export function percentOf(total: string, percent: string): string {
  const totalCents = toCents(total);
  if (!MONEY_RE.test(percent)) {
    throw new Error(`percent must be a decimal string, got ${JSON.stringify(percent)}`);
  }
  const [whole, frac = ""] = percent.split(".");
  const frac2 = (frac + "00").slice(0, 2);
  const percentHundredths = BigInt(whole) * 100n + BigInt(frac2);
  const result = (totalCents * percentHundredths) / 10000n;
  return fromCents(result);
}

export function computePayout(args: {
  type: "flat" | "percent";
  amount: string;
  orderTotal: string;
}): string {
  if (args.type === "flat") return normalizeMoney(args.amount);
  return percentOf(args.orderTotal, args.amount);
}

export function compareMoney(a: string, b: string): number {
  const ca = toCents(a);
  const cb = toCents(b);
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return 0;
}

export function addMoney(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}

export function isMoneyString(value: unknown): value is string {
  return typeof value === "string" && MONEY_RE.test(value);
}
