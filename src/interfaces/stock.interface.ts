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

/** Why a stock quantity changed. The append-only journal's reason codes. */
export enum StockMovementReason {
  RECEIVE = 'receive',
  SALE = 'sale',
  TRANSFER_IN = 'transfer_in',
  TRANSFER_OUT = 'transfer_out',
  COUNT_ADJUST = 'count_adjust',
  SPOILAGE = 'spoilage',
  MANUAL = 'manual',
}

/**
 * Who initiated a movement (for the audit trail). 'Waiter' is its own value,
 * not 'Organizer' or 'Merchant': a waiter is neither the event's own admin
 * action nor the stall's till, and attributing their movement to either would
 * misreport who actually took the stock.
 */
export type StockMovementByType = 'Organizer' | 'Merchant' | 'Platform' | 'Waiter';
