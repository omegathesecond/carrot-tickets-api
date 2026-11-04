import { normalizeTenders, sumTenders } from '@utils/tenders.util';

describe('tenders', () => {
  it('defaults a missing tip to 0 and keeps a reference only on a card tender', () => {
    expect(normalizeTenders([
      { method: 'cash', amount: 3000, reference: 'ignored' },
      { method: 'card', amount: 4500, tip: 500, reference: ' 0192 ' },
      { method: 'card', amount: 100, reference: '  ' },
    ])).toEqual([
      { method: 'cash', amount: 3000, tip: 0 },
      { method: 'card', amount: 4500, tip: 500, reference: '0192' },
      { method: 'card', amount: 100, tip: 0 },
    ]);
  });
  it('sums what came off the bill separately from tips, by method', () => {
    expect(sumTenders([
      { method: 'cash', amount: 3000, tip: 200 }, { method: 'card', amount: 4500, tip: 500 }, { method: 'cash', amount: 500, tip: 0 },
    ])).toEqual({ applied: 8000, tips: 700, cash: 3500, card: 4500, cashTips: 200, cardTips: 500 });
  });
});
