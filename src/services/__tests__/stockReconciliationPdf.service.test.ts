// src/services/__tests__/stockReconciliationPdf.service.test.ts
import {
  StockReconciliationPdfService,
  fmtQty,
  groupByStall,
  RECON_COLUMNS,
  type ReconciliationData,
  type ReconciliationRow,
} from '@services/stockReconciliationPdf.service';
import { extractPdfText } from '@/__tests__/helpers/pdfText';

function row(overrides: Partial<ReconciliationRow> = {}): ReconciliationRow {
  return {
    merchantId: 'm1',
    merchantName: 'Main Bar',
    productId: 'p1',
    productName: 'Castle Lite',
    opening: 100,
    added: 20,
    transferIn: 0,
    transferOut: 5,
    sold: 40,
    countAdjust: 0,
    spoilage: 0,
    manual: 0,
    expectedClosing: 75,
    physicalCount: null,
    variance: null,
    ...overrides,
  };
}

function data(overrides: Partial<ReconciliationData> = {}): ReconciliationData {
  const perBar = overrides.perBar ?? [row()];
  return {
    perBar,
    byProduct: overrides.byProduct ?? [
      { productId: 'p1', productName: 'Castle Lite', opening: 100, added: 20, transferIn: 0, transferOut: 5, sold: 40, countAdjust: 0, spoilage: 0, manual: 0, expectedClosing: 75, physicalCount: null, variance: null },
    ],
    total: overrides.total ?? { opening: 100, added: 20, transferIn: 0, transferOut: 5, sold: 40, countAdjust: 0, spoilage: 0, manual: 0, expectedClosing: 75, physicalCount: null, variance: null },
  };
}

describe('fmtQty', () => {
  // "Not counted yet" and "counted zero units" are materially different facts —
  // the report service is careful to keep physicalCount/variance null rather
  // than 0 for an uncounted row, and the PDF must not flatten that back to 0.
  it('renders null as an em dash, not zero', () => {
    expect(fmtQty(null)).toBe('—');
  });

  it('renders a real zero as 0', () => {
    expect(fmtQty(0)).toBe('0');
  });

  it('keeps the sign on a negative variance', () => {
    expect(fmtQty(-5)).toBe('-5');
  });
});

describe('groupByStall', () => {
  it('groups rows under their stall, stalls A-Z and products A-Z within each', () => {
    const groups = groupByStall([
      row({ merchantId: 'm2', merchantName: 'VIP Bar', productId: 'p2', productName: 'Savanna' }),
      row({ merchantId: 'm1', merchantName: 'Main Bar', productId: 'p2', productName: 'Savanna' }),
      row({ merchantId: 'm1', merchantName: 'Main Bar', productId: 'p1', productName: 'Castle Lite' }),
    ]);

    expect(groups.map((g) => g.merchantName)).toEqual(['Main Bar', 'VIP Bar']);
    expect(groups[0]!.rows.map((r) => r.productName)).toEqual(['Castle Lite', 'Savanna']);
    expect(groups[1]!.rows).toHaveLength(1);
  });

  it('returns no groups for an event with no stock rows', () => {
    expect(groupByStall([])).toEqual([]);
  });
});

describe('StockReconciliationPdfService.buildPdfBuffer', () => {
  const event = { name: 'Ocean Summer Vibes', subtitle: 'Ocean Cuisine' };

  it('renders a PDF', async () => {
    const buffer = await StockReconciliationPdfService.buildPdfBuffer(event, data());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('prints the event name, every column heading and the as-at timestamp', async () => {
    const generatedAt = new Date('2026-09-29T15:30:00Z'); // 17:30 in Eswatini
    const text = extractPdfText(await StockReconciliationPdfService.buildPdfBuffer(event, data(), generatedAt));

    expect(text).toContain('Ocean Summer Vibes');
    expect(text).toContain('Ocean Cuisine');
    // Headings are drawn uppercased; the assertion is that the column reached
    // the page, not how it was cased.
    const upper = text.toUpperCase();
    for (const col of RECON_COLUMNS) expect(upper).toContain(col.label.toUpperCase());
    // Printed recons get filed and argued over — the moment they describe has
    // to be on the page, in Eswatini time, not the API's UTC.
    expect(text).toContain('17:30');
  });

  it('prints an uncounted physical/variance as a dash rather than a zero', async () => {
    const text = extractPdfText(
      await StockReconciliationPdfService.buildPdfBuffer(event, data({ perBar: [row({ physicalCount: null, variance: null })] })),
    );
    expect(text).toContain('—');
  });

  it('prints a counted stall’s physical count and variance', async () => {
    const text = extractPdfText(
      await StockReconciliationPdfService.buildPdfBuffer(
        event,
        data({ perBar: [row({ expectedClosing: 75, physicalCount: 70, variance: -5 })] }),
      ),
    );
    expect(text).toContain('70');
    expect(text).toContain('-5');
  });

  it('gives every stall its own section', async () => {
    const text = extractPdfText(
      await StockReconciliationPdfService.buildPdfBuffer(
        event,
        data({
          perBar: [
            row({ merchantId: 'm1', merchantName: 'Main Bar' }),
            row({ merchantId: 'm2', merchantName: 'VIP Bar' }),
          ],
        }),
      ),
    );
    expect(text).toContain('Main Bar');
    expect(text).toContain('VIP Bar');
  });

  it('renders an event with no stock at all without throwing', async () => {
    const empty = data({ perBar: [], byProduct: [], total: { opening: 0, added: 0, transferIn: 0, transferOut: 0, sold: 0, countAdjust: 0, spoilage: 0, manual: 0, expectedClosing: 0, physicalCount: null, variance: null } });
    const text = extractPdfText(await StockReconciliationPdfService.buildPdfBuffer(event, empty));
    expect(text).toContain('No stock recorded');
  });

  it('paginates a stall with more products than fit on one page', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      row({ productId: `p${i}`, productName: `Product ${String(i).padStart(3, '0')}` }),
    );
    const text = extractPdfText(await StockReconciliationPdfService.buildPdfBuffer(event, data({ perBar: many })));
    // The first and last product must BOTH survive — a table that silently
    // stops at the page break would under-report the stall's stock.
    expect(text).toContain('Product 000');
    expect(text).toContain('Product 119');
  });

  it('carries the event and a page number onto continuation pages', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      row({ productId: `p${i}`, productName: `Product ${String(i).padStart(3, '0')}` }),
    );
    const text = extractPdfText(await StockReconciliationPdfService.buildPdfBuffer(event, data({ perBar: many })));
    // A printed recon gets separated; a loose page with no event on it is
    // unfileable, and one with no page number hides a missing sheet.
    expect(text).toContain('Page 2 of');
    expect(text.match(/Ocean Summer Vibes/g)!.length).toBeGreaterThan(1);
  });

  it('does not paginate a report that fits on one page', async () => {
    const text = extractPdfText(await StockReconciliationPdfService.buildPdfBuffer(event, data()));
    expect(text).not.toContain('Page 1 of');
  });
});
