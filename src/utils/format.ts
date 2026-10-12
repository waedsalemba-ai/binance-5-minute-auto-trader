/**
 * Safe numeric and percentage formatting helpers.
 * Prevents any NaN, null, undefined, or Infinity values from being rendered
 * into the React DOM tree (preventing "Received NaN for children" React warnings).
 */

export function safeNum(val: unknown, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) ? num : fallback;
}

export function formatCurrency(val: unknown, decimals = 2, fallback = '0.00'): string {
  const num = safeNum(val, Number.NaN);
  if (Number.isNaN(num)) return fallback;
  return num.toFixed(decimals);
}

export function formatSignedCurrency(val: unknown, decimals = 2): string {
  const num = safeNum(val, 0);
  const formatted = Math.abs(num).toFixed(decimals);
  if (num > 0) return `+$${formatted}`;
  if (num < 0) return `-$${formatted}`;
  return `$${formatted}`;
}

export function formatPercent(val: unknown, decimals = 2, includeSign = false): string {
  const num = safeNum(val, 0);
  const formatted = num.toFixed(decimals);
  if (includeSign && num > 0) {
    return `+${formatted}%`;
  }
  return `${formatted}%`;
}

export function formatQty(val: unknown, decimals = 4): string {
  const num = safeNum(val, 0);
  return num.toFixed(decimals);
}
