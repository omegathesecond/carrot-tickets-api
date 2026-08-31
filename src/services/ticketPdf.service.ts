import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { ITicket } from '@interfaces/ticket.interface';

/**
 * TicketPdfService — renders a branded, QR-coded PDF for one or more tickets,
 * on demand, for the buyer "Download" action on My Profile > Tickets.
 *
 * Generated fresh per request (no caching): a single ticket's PDF is one
 * PDFKit page plus one QR render, which is cheap enough to redo on every
 * download rather than add a storage/cache layer for it.
 */
export class TicketPdfService {
  /** Render ONE ticket into a Buffer (QR code + event/holder details). */
  static async buildTicketPdfBuffer(ticket: ITicket): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.drawTicketPage(doc, ticket)
        .then(() => doc.end())
        .catch(reject);
    });
  }

  /**
   * Render MULTIPLE tickets into ONE Buffer — one ticket per page, in the
   * order given. Backs the "Download all" bundle (every ticket in a booking,
   * or the whole filtered wallet) so the buyer gets a single PDF file instead
   * of one per ticket.
   */
  static async buildBundlePdfBuffer(tickets: ITicket[]): Promise<Buffer> {
    if (tickets.length === 0) {
      throw new Error('No tickets to bundle');
    }
    return await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      (async () => {
        for (let i = 0; i < tickets.length; i++) {
          if (i > 0) doc.addPage();
          await this.drawTicketPage(doc, tickets[i]!);
        }
        doc.end();
      })().catch(reject);
    });
  }

  /**
   * Draw ONE ticket (QR code + event/holder details) onto the document's
   * CURRENT page. Shared by the single-ticket and bundle builders above — one
   * drawing routine, so a bundle page looks identical to a standalone ticket
   * PDF.
   */
  private static async drawTicketPage(doc: PDFKit.PDFDocument, ticket: ITicket): Promise<void> {
    const event: any = ticket.eventId && typeof ticket.eventId === 'object' ? ticket.eventId : null;
    const eventName: string = event?.name || 'Event Ticket';
    const venue: string = event?.venue || '';

    // The TKT-… code is what entry scanners read.
    const qrPng = await QRCode.toBuffer(ticket.ticketId, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 600
    });

    const brand = '#6B2FB3';
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Header band
    doc.rect(0, 0, doc.page.width, 90).fill(brand);
    doc.fillColor('white').fontSize(26).font('Helvetica-Bold')
      .text('Carrot Tickets', 50, 32);
    doc.fontSize(11).font('Helvetica')
      .text('E-Ticket — present the QR code below at the entrance', 50, 64);

    doc.fillColor('black');
    let y = 120;

    // Event title
    doc.fontSize(20).font('Helvetica-Bold').text(eventName, 50, y, { width: pageWidth });
    y = doc.y + 6;
    if (venue) {
      doc.fontSize(12).font('Helvetica').fillColor('#555')
        .text(venue, 50, y, { width: pageWidth });
      y = doc.y;
    }

    // Event date / time
    const eventDate = this.fmtDate(event?.eventDate);
    const timeRange = this.fmtTimeRange(event?.startTime, event?.endTime);
    const whenLine = [eventDate, timeRange].filter(Boolean).join('   •   ');
    if (whenLine) {
      doc.fillColor('#555').fontSize(12).font('Helvetica')
        .text(whenLine, 50, y + 2, { width: pageWidth });
      y = doc.y;
    }

    y += 24;
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor('#e0e0e0').stroke();
    y += 24;

    // QR code, centered
    const qrSize = 220;
    const qrX = (doc.page.width - qrSize) / 2;
    doc.image(qrPng, qrX, y, { width: qrSize, height: qrSize });
    let belowQr = y + qrSize + 14;

    doc.fillColor('#111').fontSize(13).font('Courier-Bold')
      .text(ticket.ticketId, 50, belowQr, { width: pageWidth, align: 'center' });
    belowQr = doc.y + 24;

    // Detail rows
    const rows: Array<[string, string]> = [
      ['Ticket Type', ticket.ticketType || 'General'],
      ['Price', this.fmtPrice(ticket.price)],
      ['Status', this.fmtStatus(ticket.status)]
    ];
    if (ticket.customerName) rows.push(['Holder', ticket.customerName]);
    if (ticket.customerPhone) rows.push(['Phone', ticket.customerPhone]);

    let ry = belowQr;
    for (const [label, value] of rows) {
      doc.fillColor('#777').fontSize(11).font('Helvetica').text(label, 50, ry, { width: 160 });
      doc.fillColor('#111').fontSize(12).font('Helvetica-Bold')
        .text(value, 210, ry, { width: pageWidth - 160 });
      ry = doc.y + 10;
    }

    // Footer
    doc.fillColor('#999').fontSize(9).font('Helvetica')
      .text('Powered by Carrot Tickets', 50, doc.page.height - 60, { width: pageWidth, align: 'center' });
  }

  private static fmtDate(d?: Date | string): string {
    if (!d) return '';
    const date = new Date(d);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }

  private static fmtTimeRange(start?: Date | string, end?: Date | string): string {
    const t = (d?: Date | string) => {
      if (!d) return '';
      const date = new Date(d);
      if (isNaN(date.getTime())) return '';
      return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    };
    const s = t(start);
    const e = t(end);
    if (s && e) return `${s} - ${e}`;
    return s || e || '';
  }

  private static fmtPrice(price?: number): string {
    if (price === undefined || price === null) return '';
    if (price === 0) return 'Free';
    return `E${price.toFixed(2)}`;
  }

  private static fmtStatus(status?: string): string {
    if (!status) return '';
    return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
