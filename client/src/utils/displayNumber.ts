/** Format numeric values for display only. Never use this for model serialization. */
export function displayNumber(value: number | string): string {
  const raw = String(value).trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return String(value);
  const number = Number(raw);
  if (!Number.isFinite(number)) return String(value);
  // Avoid showing negative zero and unnecessary trailing zeroes.
  return String(Number(number.toFixed(3)));
}
