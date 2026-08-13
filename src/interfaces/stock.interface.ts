/**
 * Cashless stock/inventory (design 2026-08-12). Stock is tracked in integer
 * base units (bottles/cans/items). Money stays in ZAR cents on the money ledger.
 */

/** Product taxonomy — "not limited to alcohol" (design §1). */
export enum ProductCategory {
  BEER = 'beer',
  SPIRITS = 'spirits',
  WINE = 'wine',
  SOFT_DRINK = 'soft_drink',
  WATER = 'water',
  FOOD = 'food',
  MERCH = 'merch',
  CIGARETTES = 'cigarettes',
  OTHER = 'other',
}
