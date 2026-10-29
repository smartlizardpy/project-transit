// Display currency. The simulation uses one neutral base unit (≈ euros, see docs/economy.md);
// prices are shown in the local currency of the chosen city using a fixed game exchange factor
// that also roughly reflects local price levels. These are game values, not live rates.

export interface Currency {
  code: string;
  symbol: string;
  /** base units → display units */
  factor: number;
  /** symbol after the number */
  suffix?: boolean;
  decimals: number;
}

const EUR: Currency = { code: 'EUR', symbol: '€', factor: 1, decimals: 0 };

const BY_COUNTRY: Record<string, Currency> = {
  TR: { code: 'TRY', symbol: '₺', factor: 17, decimals: 0 },
  GB: { code: 'GBP', symbol: '£', factor: 0.88, decimals: 0 },
  US: { code: 'USD', symbol: '$', factor: 1.1, decimals: 0 },
  JP: { code: 'JPY', symbol: '¥', factor: 130, decimals: 0 },
  CH: { code: 'CHF', symbol: 'CHF ', factor: 1.05, decimals: 0 },
  SE: { code: 'SEK', symbol: ' kr', factor: 9.5, suffix: true, decimals: 0 },
  NO: { code: 'NOK', symbol: ' kr', factor: 10, suffix: true, decimals: 0 },
  DK: { code: 'DKK', symbol: ' kr', factor: 7.5, suffix: true, decimals: 0 },
  PL: { code: 'PLN', symbol: ' zł', factor: 3.4, suffix: true, decimals: 0 },
  CZ: { code: 'CZK', symbol: ' Kč', factor: 20, suffix: true, decimals: 0 },
};

export function currencyFor(country: string | undefined): Currency {
  return (country && BY_COUNTRY[country.toUpperCase()]) || EUR;
}

/** Format a base-unit amount for display. `fine` shows decimals for small amounts (fares). */
export function formatMoney(c: Currency, base: number, opts: { fine?: boolean; sign?: boolean; compact?: boolean } = {}): string {
  const v = base * c.factor;
  const neg = v < 0;
  const a = Math.abs(v);
  let body: string;
  if (opts.compact && a >= 1e6) body = `${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  else if (opts.compact && a >= 1e4) body = `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  else if (opts.fine && a < 100) body = a.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else body = Math.round(a).toLocaleString('en-GB');
  const s = c.suffix ? `${body}${c.symbol}` : `${c.symbol}${body}`;
  return neg ? `−${s}` : opts.sign && v > 0 ? `+${s}` : s;
}
