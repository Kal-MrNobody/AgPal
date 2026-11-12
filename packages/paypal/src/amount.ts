import {
  isCurrency,
  money,
  parseDecimal,
  toDecimal,
  type Currency,
  type Money,
} from '@agpal/shared';

/** PayPal's amount object. */
export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export function toPayPalAmount(amountMinor: bigint, currency: Currency): PayPalAmount {
  return { currency_code: currency, value: toDecimal(money(amountMinor, currency)) };
}

export function fromPayPalAmount(
  a:
    | { currency_code?: string; currencyCode?: string; currency?: string; value?: string }
    | undefined,
): Money | undefined {
  // Payouts v1 uses `currency`; every other API uses `currency_code`.
  const code = a?.currency_code ?? a?.currencyCode ?? a?.currency;
  if (!code || a?.value === undefined) return undefined;
  if (!isCurrency(code)) throw new Error(`Unsupported currency from PayPal: ${code}`);
  return parseDecimal(a.value, code);
}

export function requireAmount(a: Parameters<typeof fromPayPalAmount>[0], what: string): Money {
  const m = fromPayPalAmount(a);
  if (!m) throw new Error(`PayPal response is missing ${what}`);
  return m;
}
