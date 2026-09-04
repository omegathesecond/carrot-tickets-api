/**
 * Case → base-unit conversion, shared by the organizer's receive endpoint and
 * the POS stock writes so the two can never disagree about what "5 cases"
 * means. Returns null when packs were asked for on a product that has no pack
 * size — the caller turns that into a 400 rather than silently receiving 5
 * bottles instead of 5 cases.
 */
export function toBaseUnits(
  product: { unitsPerPack?: number | null },
  quantity: number,
  unit: 'unit' | 'pack',
): number | null {
  const perPack = product.unitsPerPack && product.unitsPerPack > 0 ? product.unitsPerPack : 1;
  if (unit === 'pack') return perPack === 1 ? null : quantity * perPack;
  return quantity;
}
