import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import mongoose from 'mongoose';
import { Ticket } from '@models/ticket.model';
import { R2Service } from '@utils/r2.service';
import { ITicket, TicketPdfStatus } from '@interfaces/ticket.interface';

/**
 * TicketPdfService — generates a branded, QR-coded PDF for a single ticket and
 * caches it in Cloudflare R2.
 *
 * One generator, one stored artifact, many consumers: the Keshless wallet
 * user-app (via the main keshless-api proxy), the keshless-tickets dashboard
 * (vendor JWT) and the keshless-tickets website (buyer token) all hit the same
 * endpoint and share the SAME R2 PDF. Generation is lazy and idempotent — the
 * first request renders + uploads, every later request returns the cached URL.
 *
 * "Async to avoid timeouts": generation is fast (one ticket, one QR) so it runs
 * inside the triggering request — reliable on Cloud Run where CPU is throttled
 * outside request handling, unlike fire-and-forget background work. The status
 * envelope ({ status, pdfUrl }) still lets clients poll, and a concurrent second
 * request gets `generating` instead of rendering a duplicate.
 */

// A 'generating' marker older than this is treated as stalled (e.g. an instance
// died mid-render) and the next request restarts generation.
const STALE_GENERATING_MS = 60_000;

export interface TicketPdfResult {
  status: TicketPdfStatus;
  pdfUrl?: string;
}

export class TicketPdfService {
  /**
   * Resolve a ticket by its human ticket code (TKT-…) or Mongo _id, with the
   * event populated for rendering. Returns null if not found.
   */
  static async resolveTicket(idOrCode: string): Promise<ITicket | null> {
    let ticket = await Ticket.findOne({ ticketId: idOrCode }).populate('eventId');
    if (!ticket && mongoose.isValidObjectId(idOrCode)) {
      ticket = await Ticket.findById(idOrCode).populate('eventId');
    }
    return ticket;
  }

  /**
   * Return the ticket's PDF URL, generating + uploading it on first request.
   * Idempotent: a cached READY url is returned immediately; an in-flight
   * GENERATING returns `generating` so the caller can poll.
   */
  static async ensureTicketPdf(ticket: ITicket): Promise<TicketPdfResult> {
    if (ticket.pdfStatus === TicketPdfStatus.READY && ticket.pdfUrl) {
      return { status: TicketPdfStatus.READY, pdfUrl: ticket.pdfUrl };
    }

    const requestedAt = ticket.pdfRequestedAt ? ticket.pdfRequestedAt.getTime() : 0;
    const isStale = Date.now() - requestedAt > STALE_GENERATING_MS;
    if (ticket.pdfStatus === TicketPdfStatus.GENERATING && !isStale) {
      return { status: TicketPdfStatus.GENERATING };
    }

    // Claim generation for this request.
    ticket.pdfStatus = TicketPdfStatus.GENERATING;
    ticket.pdfRequestedAt = new Date();
    await ticket.save();

    try {
      const buffer = await this.buildTicketPdfBuffer(ticket);
      const eventId = this.eventIdOf(ticket);
      const { url } = await R2Service.uploadFile(
        `tickets/${eventId}`,
        `${ticket.ticketId}.pdf`,
        buffer,
        'application/pdf'
      );

      ticket.pdfUrl = url;
      ticket.pdfStatus = TicketPdfStatus.READY;
      await ticket.save();

      return { status: TicketPdfStatus.READY, pdfUrl: url };
    } catch (error: any) {
      // Surface the failure loudly — never hand back a stale/placeholder URL.
      ticket.pdfStatus = TicketPdfStatus.FAILED;
      await ticket.save().catch(() => {});
      console.error(`[ticket-pdf] generation failed for ${ticket.ticketId}:`, error);
      throw new Error(error?.message || 'Failed to generate ticket PDF');
    }
  }

  /** ObjectId of the event, whether eventId is populated or a raw id. */
  private static eventIdOf(ticket: ITicket): string {
    const e: any = ticket.eventId;
    if (e && typeof e === 'object' && e._id) return e._id.toString();
    return e?.toString() || 'unknown';
  }

  /**
   * Render the ticket PDF into a Buffer (QR code + event/holder details).
   */
  static async buildTicketPdfBuffer(ticket: ITicket): Promise<Buffer> {
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

    return await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const brand = '#6B2FB3';
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // Header band
      doc.rect(0, 0, doc.page.width, 90).fill(brand);
      doc.fillColor('white').fontSize(26).font('Helvetica-Bold')
        .text('Keshless Tickets', 50, 32);
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
        .text('Powered by Keshless', 50, doc.page.height - 60, { width: pageWidth, align: 'center' });

      doc.end();
    });
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
