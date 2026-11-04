import { IVenueTender, TenderMethod } from '@interfaces/venuePayment.interface';

/** A tender as the POS sends it. */
export interface TenderInput { method: TenderMethod; amount: number; tip?: number; reference?: string }

/** As stored: a tip defaults to 0; a slip reference is kept only on a card tender, and only if there is one. */
export function normalizeTenders(input: TenderInput[]): IVenueTender[] {
  return input.map((t) => {
    const reference = t.method === 'card' ? (t.reference ?? '').trim() : '';
    return { method: t.method, amount: t.amount, tip: t.tip ?? 0, ...(reference ? { reference } : {}) };
  });
}

export interface TenderSums { applied: number; tips: number; cash: number; card: number; cashTips: number; cardTips: number }

/** `applied` is what came off the bill; tips are counted apart, per method (the day close needs both). */
export function sumTenders(tenders: ReadonlyArray<{ method: TenderMethod; amount: number; tip: number }>): TenderSums {
  const sums: TenderSums = { applied: 0, tips: 0, cash: 0, card: 0, cashTips: 0, cardTips: 0 };
  for (const t of tenders) {
    sums.applied += t.amount;
    sums.tips += t.tip;
    sums[t.method] += t.amount;
    sums[t.method === 'cash' ? 'cashTips' : 'cardTips'] += t.tip;
  }
  return sums;
}
