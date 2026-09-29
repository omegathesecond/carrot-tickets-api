// api/src/services/stockReconciliationPdf.service.ts
import PDFDocument from 'pdfkit';
import { EVENT_TIMEZONE } from '@utils/eventTime.util';

/**
 * StockReconciliationPdfService — renders the organiser's stock reconciliation
 * as a printable PDF.
 *
 * It owns NO figures. Every number on the page comes from
 * `StockReportService.reconciliation`, the same call that backs the on-screen
 * Reconciliation tab, so the paper and the screen cannot disagree. This module
 * is layout only.
 *
 * Generated fresh per request — no R2 upload, no cache. A reconciliation is a
 * handful of table pages, which is cheap enough to redo on every download, and
 * caching it would be actively wrong: the report is "as at the moment you asked"
 * and a cached copy would hand back a stale position under a fresh filename.
 */

/** One reconciliation row for a single product at a single stall. */
export interface ReconciliationRow {
  merchantId: string;
  merchantName: string;
  productId: string;
  productName: string;
  opening: number;
  added: number;
  transferIn: number;
  transferOut: number;
  sold: number;
  countAdjust: number;
  spoilage: number;
  manual: number;
  expectedClosing: number;
  /** null = no closing count taken yet. NOT the same as a counted zero. */
  physicalCount: number | null;
  variance: number | null;
}

/** The same figures rolled up across every stall, per product. */
export type ReconciliationRollupRow = Omit<ReconciliationRow, 'merchantId' | 'merchantName'>;

/** The grand total across every stall and product. */
export type ReconciliationTotal = Omit<ReconciliationRollupRow, 'productId' | 'productName'>;

export interface ReconciliationData {
  perBar: ReconciliationRow[];
  byProduct: ReconciliationRollupRow[];
  total: ReconciliationTotal;
}

export interface ReconciliationPdfEvent {
  name: string;
  venue?: string | undefined;
}

/**
 * The numeric columns, in the order the ledger reads: what you started with,
 * what came in, what went out, what you should have, what you actually have.
 */
export const RECON_COLUMNS = [
  { key: 'opening', label: 'Opening' },
  { key: 'added', label: 'Added' },
  { key: 'transferIn', label: 'In' },
  { key: 'transferOut', label: 'Out' },
  { key: 'sold', label: 'Sold' },
  { key: 'countAdjust', label: 'Adjust' },
  { key: 'spoilage', label: 'Spoilage' },
  { key: 'manual', label: 'Manual' },
  { key: 'expectedClosing', label: 'Expected' },
  { key: 'physicalCount', label: 'Physical' },
  { key: 'variance', label: 'Variance' },
] as const satisfies readonly { key: keyof ReconciliationTotal; label: string }[];

/** Carrot's official orange (landing/src/index.css --primary: 16 100% 60%). */
const BRAND = '#FF6B35';
const INK = '#111111';
const MUTED = '#777777';
const RULE = '#DDDDDD';
const ZEBRA = '#FAFAF9';
const NEGATIVE = '#C0392B';

const PAGE_MARGIN = 36;
const ROW_HEIGHT = 16;
const HEADER_ROW_HEIGHT = 18;
const NAME_COL_WIDTH = 168;

/**
 * Render a quantity for the page. `null` means the count has not been taken,
 * which prints as an em dash: showing it as `0` would claim someone counted the
 * shelf and found nothing there, and an organiser chasing shrinkage would read
 * a whole uncounted stall as a total loss.
 */
export function fmtQty(value: number | null): string {
  return value == null ? '—' : String(value);
}

export interface StallGroup {
  merchantId: string;
  merchantName: string;
  rows: ReconciliationRow[];
}

/**
 * Regroup the report's rows by stall. The report service sorts by product name
 * first (it drives a flat on-screen table); the PDF is read stall by stall,
 * because that is how the stock is physically counted and handed over.
 */
export function groupByStall(perBar: ReconciliationRow[]): StallGroup[] {
  const byId = new Map<string, StallGroup>();
  for (const row of perBar) {
    let group = byId.get(row.merchantId);
    if (!group) {
      group = { merchantId: row.merchantId, merchantName: row.merchantName, rows: [] };
      byId.set(row.merchantId, group);
    }
    group.rows.push(row);
  }
  const groups = [...byId.values()];
  for (const group of groups) group.rows.sort((a, b) => a.productName.localeCompare(b.productName));
  return groups.sort((a, b) => a.merchantName.localeCompare(b.merchantName));
}

/** Eswatini-local "29 Sep 2026, 17:30" for the as-at line. */
function formatAsAt(at: Date): string {
  return at.toLocaleString('en-GB', {
    timeZone: EVENT_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export class StockReconciliationPdfService {
  /**
   * Render the whole reconciliation into one Buffer: a cover header, one
   * section per stall, the per-product rollup across all stalls, and the grand
   * total.
   */
  static async buildPdfBuffer(
    event: ReconciliationPdfEvent,
    data: ReconciliationData,
    generatedAt: Date = new Date(),
  ): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      // bufferPages so the "Page n of m" stamp can be applied once the total is
      // known — a printed reconciliation gets separated, and a loose page with
      // no event and no page number is unfileable.
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Fires for every page AFTER the first (the constructor already made
      // page 1), so continuation pages carry the event forward.
      doc.on('pageAdded', () => this.drawContinuationHeader(doc, event, generatedAt));

      try {
        this.draw(doc, event, data, generatedAt);
        this.stampPageNumbers(doc);
        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  private static draw(
    doc: PDFKit.PDFDocument,
    event: ReconciliationPdfEvent,
    data: ReconciliationData,
    generatedAt: Date,
  ): void {
    this.drawHeader(doc, event, generatedAt);

    const stalls = groupByStall(data.perBar);
    if (stalls.length === 0) {
      doc.moveDown(2);
      doc.fillColor(MUTED).fontSize(11).font('Helvetica')
        .text('No stock recorded for this event yet.', PAGE_MARGIN, doc.y);
      this.drawFooter(doc);
      return;
    }

    for (const stall of stalls) {
      this.drawTable(doc, {
        title: stall.merchantName,
        nameHeader: 'Product',
        rows: stall.rows.map((r) => ({ name: r.productName, values: r })),
      });
    }

    this.drawTable(doc, {
      title: 'All stalls combined',
      nameHeader: 'Product',
      rows: data.byProduct.map((r) => ({ name: r.productName, values: r })),
      totalRow: data.total,
    });

    this.drawFooter(doc);
  }

  private static drawHeader(doc: PDFKit.PDFDocument, event: ReconciliationPdfEvent, generatedAt: Date): void {
    const width = doc.page.width - PAGE_MARGIN * 2;

    doc.rect(PAGE_MARGIN, PAGE_MARGIN, width, 4).fillColor(BRAND).fill();
    doc.fillColor(INK).fontSize(18).font('Helvetica-Bold')
      .text('Stock reconciliation', PAGE_MARGIN, PAGE_MARGIN + 16);
    doc.fillColor(INK).fontSize(12).font('Helvetica')
      .text(event.name, PAGE_MARGIN, doc.y + 2);
    if (event.venue) {
      doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(event.venue, PAGE_MARGIN, doc.y + 1);
    }
    // A printed reconciliation gets filed, emailed and argued over weeks later.
    // Without the moment it describes it is just a page of numbers.
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
      .text(`As at ${formatAsAt(generatedAt)} (Eswatini time)`, PAGE_MARGIN, doc.y + 4);
    doc.y += 8;
  }

  /** Slim header for pages 2+ — enough to identify a page on its own. */
  private static drawContinuationHeader(
    doc: PDFKit.PDFDocument,
    event: ReconciliationPdfEvent,
    generatedAt: Date,
  ): void {
    const width = doc.page.width - PAGE_MARGIN * 2;
    doc.rect(PAGE_MARGIN, PAGE_MARGIN, width, 2).fillColor(BRAND).fill();
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
      .text(
        `Stock reconciliation — ${event.name} — as at ${formatAsAt(generatedAt)} (Eswatini time)`,
        PAGE_MARGIN,
        PAGE_MARGIN + 6,
        { width, lineBreak: false },
      );
    doc.y = PAGE_MARGIN + 20;
  }

  /** "Page n of m" on every page, once the total is known. */
  private static stampPageNumbers(doc: PDFKit.PDFDocument): void {
    const range = doc.bufferedPageRange();
    if (range.count < 2) return; // A one-page report does not need paginating.

    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Writing into the bottom margin would otherwise make PDFKit spill onto a
      // fresh page — and each fresh page would want a stamp of its own.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor(MUTED).fontSize(8).font('Helvetica')
        .text(`Page ${i + 1} of ${range.count}`, PAGE_MARGIN, doc.page.height - PAGE_MARGIN + 4, {
          width: doc.page.width - PAGE_MARGIN * 2,
          align: 'right',
          lineBreak: false,
        });
      doc.page.margins.bottom = bottom;
    }
  }

  private static drawFooter(doc: PDFKit.PDFDocument): void {
    doc.moveDown(1);
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
      .text(
        'Expected is the stock ledger’s position. Physical and Variance come from the latest closing count — a dash means that stall has not been counted.',
        PAGE_MARGIN,
        doc.y,
        { width: doc.page.width - PAGE_MARGIN * 2 },
      );
  }

  /** x offset + width of each column, name column first. */
  private static layout(doc: PDFKit.PDFDocument): { nameX: number; nameW: number; colX: number[]; colW: number } {
    const usable = doc.page.width - PAGE_MARGIN * 2;
    const colW = (usable - NAME_COL_WIDTH) / RECON_COLUMNS.length;
    return {
      nameX: PAGE_MARGIN,
      nameW: NAME_COL_WIDTH,
      colX: RECON_COLUMNS.map((_, i) => PAGE_MARGIN + NAME_COL_WIDTH + i * colW),
      colW,
    };
  }

  private static drawTable(
    doc: PDFKit.PDFDocument,
    table: {
      title: string;
      nameHeader: string;
      rows: { name: string; values: ReconciliationTotal }[];
      totalRow?: ReconciliationTotal;
    },
  ): void {
    const { nameX, nameW, colX, colW } = this.layout(doc);
    const bottom = doc.page.height - PAGE_MARGIN - ROW_HEIGHT;

    const needRoom = (needed: number) => {
      if (doc.y + needed > bottom) {
        // `pageAdded` draws the continuation header and leaves doc.y beneath it.
        doc.addPage();
        return true;
      }
      return false;
    };

    // Title + column headings must not be orphaned at the foot of a page.
    needRoom(ROW_HEIGHT * 3);
    doc.moveDown(0.6);
    doc.fillColor(BRAND).fontSize(11).font('Helvetica-Bold').text(table.title, nameX, doc.y);
    doc.y += 4;

    const drawHeadings = () => {
      const y = doc.y;
      doc.fillColor(MUTED).fontSize(7.5).font('Helvetica-Bold');
      doc.text(table.nameHeader.toUpperCase(), nameX, y + 5, { width: nameW, ellipsis: true });
      RECON_COLUMNS.forEach((col, i) => {
        doc.text(col.label.toUpperCase(), colX[i]!, y + 5, { width: colW, align: 'right' });
      });
      doc.y = y + HEADER_ROW_HEIGHT;
      doc.moveTo(nameX, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).strokeColor(RULE).lineWidth(1).stroke();
      doc.y += 2;
    };
    drawHeadings();

    const drawRow = (name: string, values: ReconciliationTotal, opts: { bold?: boolean; zebra?: boolean } = {}) => {
      // A table that silently stopped at the page break would under-report the
      // stall, so every row re-checks the remaining room and carries its
      // headings onto the next page.
      if (needRoom(ROW_HEIGHT)) drawHeadings();
      const y = doc.y;
      if (opts.zebra) {
        doc.rect(nameX, y, doc.page.width - PAGE_MARGIN * 2, ROW_HEIGHT).fillColor(ZEBRA).fill();
      }
      const font = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
      doc.fillColor(INK).fontSize(8.5).font(font)
        .text(name, nameX + 2, y + 4, { width: nameW - 4, ellipsis: true, lineBreak: false });
      RECON_COLUMNS.forEach((col, i) => {
        const value = values[col.key];
        // Shrinkage is the one figure an organiser is scanning for.
        const negative = typeof value === 'number' && value < 0 && col.key === 'variance';
        doc.fillColor(negative ? NEGATIVE : INK)
          .font(negative || opts.bold ? 'Helvetica-Bold' : 'Helvetica')
          .text(fmtQty(value), colX[i]!, y + 4, { width: colW - 4, align: 'right', lineBreak: false });
      });
      doc.y = y + ROW_HEIGHT;
    };

    table.rows.forEach((r, i) => drawRow(r.name, r.values, { zebra: i % 2 === 1 }));

    if (table.totalRow) {
      if (needRoom(ROW_HEIGHT * 2)) drawHeadings();
      doc.moveTo(nameX, doc.y).lineTo(doc.page.width - PAGE_MARGIN, doc.y).strokeColor(RULE).lineWidth(1).stroke();
      doc.y += 2;
      drawRow('Total', table.totalRow, { bold: true });
    }
  }
}
