/**
 * Decimal-safe arithmetic utilities for Binance order sizing and precision rounding.
 * Avoids JavaScript IEEE-754 floating-point inaccuracies.
 */

/**
 * Calculates the number of decimal places in a number or numeric string.
 */
export function getPrecision(value: number | string): number {
  const s = typeof value === 'number' ? value.toString() : value;
  if (s.includes('e-')) {
    const parts = s.split('e-');
    return parseInt(parts[1], 10);
  }
  const decimalIndex = s.indexOf('.');
  return decimalIndex >= 0 ? s.length - decimalIndex - 1 : 0;
}

/**
 * Rounds a quantity down to the nearest exchange stepSize (LOT_SIZE filter).
 * E.g., qty = 1.2345678, stepSize = 0.001 -> 1.234
 */
export function floorToStep(qty: number, stepSize: number): number {
  if (!stepSize || stepSize <= 0) return qty;
  const precision = getPrecision(stepSize);
  const factor = Math.pow(10, precision);
  const stepped = Math.floor(Math.round(qty * factor * 1e6) / 1e6) / factor;
  return Number(stepped.toFixed(precision));
}

/**
 * Rounds a price to the nearest tickSize (PRICE_FILTER).
 * E.g., price = 50123.4567, tickSize = 0.01 -> 50123.45
 */
export function roundToTick(price: number, tickSize: number): number {
  if (!tickSize || tickSize <= 0) return price;
  const precision = getPrecision(tickSize);
  const factor = Math.pow(10, precision);
  const ticked = Math.round(price * factor) / factor;
  return Number(ticked.toFixed(precision));
}

/**
 * Validates whether quote notional meets minNotional / NOTIONAL filter.
 */
export function meetsMinNotional(price: number, qty: number, minNotional: number): boolean {
  if (!minNotional || minNotional <= 0) return true;
  const notional = price * qty;
  return notional >= minNotional * 0.9999;
}

/**
 * Safe multiplication with decimal formatting.
 */
export function safeMultiply(a: number, b: number, decimals = 8): number {
  const res = a * b;
  return Number(res.toFixed(decimals));
}

/**
 * Safe subtraction avoiding floating point artifacts (e.g. 1.0 - 0.9 = 0.09999999999999998).
 */
export function safeSubtract(a: number, b: number, decimals = 8): number {
  const res = a - b;
  return Number(res.toFixed(decimals));
}

/**
 * Safe addition avoiding floating point artifacts.
 */
export function safeAdd(a: number, b: number, decimals = 8): number {
  const res = a + b;
  return Number(res.toFixed(decimals));
}
