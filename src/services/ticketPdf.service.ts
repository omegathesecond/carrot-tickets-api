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
   * PDF. Mirrors the on-screen stub in PrintableTicket.tsx (My Profile >
   * Tickets) — same orange brand, same poster-flush-against-QR layout.
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

    // Poster is a nice-to-have, not the QR — a broken/unreachable image must
    // never take down the download itself, so a fetch/decode failure just
    // means no poster on this stub (see catch below), not a failed PDF.
    const posterBuffer = event?.posterUrl ? await this.fetchImageBuffer(event.posterUrl) : null;

    // Carrot's official orange (see landing/src/index.css --primary: 16 100% 60%).
    const brand = '#FF6B35';
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
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111')
      .text(eventName, 50, y, { width: pageWidth });
    y = doc.y + 6;
    if (venue) {
      doc.fontSize(12).font('Helvetica').fillColor(brand)
        .text(venue, 50, y, { width: pageWidth });
      y = doc.y;
    }

    // Event date / time
    const eventDate = this.fmtDate(event?.eventDate);
    const timeRange = this.fmtTimeRange(event?.startTime, event?.endTime);
    const whenLine = [eventDate, timeRange].filter(Boolean).join('   •   ');
    if (whenLine) {
      doc.fillColor(brand).fontSize(12).font('Helvetica')
        .text(whenLine, 50, y + 2, { width: pageWidth });
      y = doc.y;
    }

    y += 20;
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).dash(3, { space: 2 }).strokeColor(brand).opacity(0.4).stroke();
    doc.undash().opacity(1);
    y += 20;

    // Poster (left) flush against the QR (right) — same block height, zero
    // gap between them, so the two read as one strip (matches the web stub).
    // Decode BEFORE laying out the strip: posters can be uploaded as WebP
    // (allowed by the upload middleware) but PDFKit's image() only decodes
    // JPEG/PNG and throws synchronously on anything else — decoding first
    // lets an unsupported format fall back to a QR-only strip instead of
    // taking down the whole PDF mid-draw.
    // @types/pdfkit doesn't declare openImage even though it exists at
    // runtime (used internally by .image()) — hence the `any`.
    let posterImage: any = null;
    if (posterBuffer) {
      try {
        posterImage = (doc as any).openImage(posterBuffer);
      } catch (error) {
        console.error('[ticket-pdf] poster image could not be decoded (unsupported format?):', error);
      }
    }

    const blockH = 170;
    const qrSize = blockH - 30; // leaves room for the ticket-id line beneath it
    const posterW = posterImage ? 150 : 0;
    const qrColW = pageWidth - posterW;
    const stripX = 50;

    doc.rect(stripX, y, pageWidth, blockH).fillColor('#FFF3EC').fill();

    if (posterImage) {
      doc.save();
      doc.rect(stripX, y, posterW, blockH).clip();
      doc.image(posterImage, stripX, y, { cover: [posterW, blockH], align: 'center', valign: 'center' });
      doc.restore();
    }

    const qrX = stripX + posterW + (qrColW - qrSize) / 2;
    const qrY = y + (blockH - qrSize - 22) / 2;
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
    doc.fillColor('#111').fontSize(12).font('Courier-Bold')
      .text(ticket.ticketId, stripX + posterW, qrY + qrSize + 8, { width: qrColW, align: 'center' });

    const belowStrip = y + blockH + 24;

    // Detail rows
    const rows: Array<[string, string]> = [
      ['Ticket Type', ticket.ticketType || 'General'],
      ['Ticket Number', ticket.ticketId],
      ['Price', this.fmtPrice(ticket.price)],
      ['Status', this.fmtStatus(ticket.status)]
    ];
    if (ticket.customerName) rows.push(['Holder', ticket.customerName]);
    if (ticket.customerPhone) rows.push(['Phone', ticket.customerPhone]);

    let ry = belowStrip;
    for (const [label, value] of rows) {
      doc.fillColor(brand).fontSize(11).font('Helvetica-Bold').text(label, 50, ry, { width: 160 });
      doc.fillColor('#111').fontSize(12).font('Helvetica')
        .text(value, 210, ry, { width: pageWidth - 160 });
      ry = doc.y + 10;
    }

    // Admission details
    ry += 6;
    doc.fillColor(brand).fontSize(11).font('Helvetica-Bold').text('Admission', 50, ry, { width: pageWidth });
    ry = doc.y + 2;
    doc.fillColor('#111').fontSize(11).font('Helvetica')
      .text('Show this code or QR at the entrance. Non-refundable.', 50, ry, { width: pageWidth });

    // Footer
    doc.fillColor('#999').fontSize(9).font('Helvetica')
      .text('Powered by Carrot Tickets', 50, doc.page.height - 60, { width: pageWidth, align: 'center' });
  }

  /**
   * Fetch a remote image (event poster) into a Buffer for embedding via
   * doc.image(). Non-critical: any failure (network, 404, an unsupported
   * format PDFKit can't decode) resolves to null rather than throwing, so a
   * bad poster never blocks the ticket PDF the buyer actually needs.
   */
  private static async fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('[ticket-pdf] poster fetch failed:', error);
      return null;
    }
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
