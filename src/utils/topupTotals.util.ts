import { TopupMethod } from '@models/walletTopup.model';

export const TOPUP_TOTAL_FIELDS = {
  cash: 'cashTopups',
  card: 'cardTopups',
  deltapay: 'deltapayTopups',
  mobile_money: 'mobileMoneyTopups',
} as const satisfies Record<TopupMethod, string>;
export type TopupTotals = Record<typeof TOPUP_TOTAL_FIELDS[TopupMethod], number>;

/** Conditional sums keep each external receipt separate from physical cash. */
export const sumTopupMethod = (method: TopupMethod) => ({
  $sum: { $cond: [{ $eq: ['$method', method] }, '$amount', 0] },
});

export const topupTotalsGroup = () => Object.fromEntries(
  Object.entries(TOPUP_TOTAL_FIELDS).map(([method, field]) => [field, sumTopupMethod(method as TopupMethod)]),
);

/** An empty aggregate has zero receipts; database failures still propagate. */
export function readTopupTotals(row?: Partial<TopupTotals>): TopupTotals {
  return Object.fromEntries(Object.values(TOPUP_TOTAL_FIELDS).map(field => [field, row?.[field] ?? 0])) as TopupTotals;
}

export function sumTopupTotals(rows: readonly Partial<TopupTotals>[]): TopupTotals {
  return Object.fromEntries(Object.values(TOPUP_TOTAL_FIELDS).map(field => [
    field, rows.reduce((sum, row) => sum + (row[field] ?? 0), 0),
  ])) as TopupTotals;
}

export function totalRecordedTopups(rows: readonly { method: TopupMethod; amount: number }[]): TopupTotals {
  const totals = readTopupTotals();
  for (const row of rows) totals[TOPUP_TOTAL_FIELDS[row.method]] += row.amount;
  return totals;
}
