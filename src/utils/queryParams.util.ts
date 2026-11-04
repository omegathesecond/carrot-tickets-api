/**
 * A query value as trimmed text: '' when the param is absent, null when it is
 * not a string at all (a repeated `x=1&x=2`, `x[]=1`, or `x[k]=v` arrives as an
 * array or object). Express parses with allowPrototypes, so `x[toString]=y` is
 * an object whose String() THROWS - never stringify an unchecked value.
 */
export function textParam(value: unknown): string | null {
  if (value === undefined) return '';
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * Absent/empty = "not sent". A value outside `allowed`, or one that is not text
 * at all (null), is invalid: null back, and the caller answers 400.
 */
export function enumParam<T extends string>(raw: string | null, allowed: readonly T[]): { value: T | undefined } | null {
  if (raw === null) return null;
  if (!raw) return { value: undefined };
  const match = allowed.find((a) => a === raw);
  return match ? { value: match } : null;
}
