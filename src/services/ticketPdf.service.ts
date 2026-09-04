import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import mongoose from 'mongoose';
import { Ticket } from '@models/ticket.model';
import { R2Service } from '@utils/r2.service';
import { ITicket, TicketPdfStatus } from '@interfaces/ticket.interface';

/**
 * TicketPdfService — renders a branded, QR-coded PDF for one or more tickets.
 *
 * Two delivery modes share ONE drawing routine (drawTicketPage), so every
 * surface gets the identical card:
 *
 *  - On demand (buildTicketPdfBuffer / buildBundlePdfBuffer): the buyer
 *    "Download" action on My Profile > Tickets. Generated fresh per request —
 *    a single ticket's PDF is one PDFKit page plus one QR render, which is
 *    cheap enough to redo on every download rather than add a cache for it.
 *
 *  - Cached + shareable (ensureTicketPdf): one stored artifact in Cloudflare
 *    R2, shared by the Keshless wallet user-app (via the main keshless-api
 *    proxy) and the dashboard (vendor JWT). Generation is lazy and idempotent
 *    — the first request renders + uploads, every later request returns the
 *    cached URL. Generation runs inside the triggering request — reliable on
 *    Cloud Run where CPU is throttled outside request handling, unlike
 *    fire-and-forget background work. The status envelope ({ status, pdfUrl })
 *    still lets clients poll, and a concurrent second request gets
 *    `generating` instead of rendering a duplicate.
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
   * CURRENT page. Shared by the single-ticket, bundle and R2-cached builders
   * above — one drawing routine, so a bundle page looks identical to a
   * standalone ticket PDF. Mirrors the on-screen ticket card in
   * PrintableTicket.tsx (My Profile > Tickets), which is the master design:
   * card + orange header, a left info column, and a QR box on the right — no
   * poster in any of the three surfaces (on-screen card, preview dialog, PDF).
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

    // Carrot's official orange (see landing/src/index.css --primary: 16 100% 60%).
    const brand = '#FF6B35';
    const brandDark = '#E85A2A';
    const cardX = 50;
    const cardY = 40;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cardW = pageWidth;
    const pad = 20;

    // Header band (gradient primary -> orange-600, same as the web card).
    const headerH = 74;
    doc.save();
    doc.roundedRect(cardX, cardY, cardW, headerH + 14, 14).clip();
    doc.rect(cardX, cardY, cardW, headerH)
      .fill(doc.linearGradient(cardX, cardY, cardX + cardW, cardY).stop(0, brand).stop(1, brandDark) as any);
    doc.restore();

    doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
      .text('CARROT TICKETS', cardX + pad, cardY + 14, { characterSpacing: 1 });
    doc.fontSize(17).font('Helvetica-Bold')
      .text(eventName, cardX + pad, cardY + 30, { width: cardW - pad * 2 });

    // Body — two columns: ticket details (left) and the QR box (right),
    // flush against each other with no poster between them.
    const bodyY = cardY + headerH + pad;
    const qrColW = 150;
    const infoColW = cardW - pad * 2 - qrColW - 16;
    const infoX = cardX + pad;
    const qrColX = cardX + cardW - pad - qrColW;

    let iy = bodyY;
    doc.fillColor('#111').fontSize(10.5).font('Helvetica');

    const eventDate = this.fmtDate(event?.eventDate);
    const timeRange = this.fmtTimeRange(event?.startTime, event?.endTime);
    const whenLine = [eventDate, timeRange].filter(Boolean).join(' · ');
    if (whenLine) {
      doc.text(whenLine, infoX, iy, { width: infoColW });
      iy = doc.y + 6;
    }
    if (venue) {
      doc.text(venue, infoX, iy, { width: infoColW });
      iy = doc.y + 10;
    }

    doc.moveTo(infoX, iy).lineTo(infoX + infoColW, iy).dash(3, { space: 2 }).strokeColor('#DDD').stroke();
    doc.undash();
    iy += 12;

    const detailRows: Array<[string, string]> = [['Ticket type', ticket.ticketType || 'General']];
    if (ticket.customerName) detailRows.push(['Holder', ticket.customerName]);
    if (typeof ticket.price === 'number') detailRows.push(['Paid', this.fmtPrice(ticket.price)]);

    for (const [label, value] of detailRows) {
      doc.fillColor('#888').fontSize(8).font('Helvetica-Bold')
        .text(label.toUpperCase(), infoX, iy, { characterSpacing: 0.5 });
      doc.fillColor('#111').fontSize(11).font('Helvetica-Bold')
        .text(value, infoX, doc.y + 1, { width: infoColW });
      iy = doc.y + 8;
    }

    // QR box — light background block, same as the web card's
    // `bg-muted/40 rounded-lg` box (poster-free on every surface).
    const qrBoxH = qrColW + 44;
    doc.roundedRect(qrColX, bodyY, qrColW, qrBoxH, 8).fillColor('#F5F5F4').fill();
    const qrSize = qrColW - 24;
    doc.image(qrPng, qrColX + 12, bodyY + 12, { width: qrSize, height: qrSize });
    doc.fillColor('#888').fontSize(7.5).font('Helvetica')
      .text('TICKET CODE', qrColX, bodyY + qrSize + 18, { width: qrColW, align: 'center', characterSpacing: 0.5 });
    doc.fillColor('#111').fontSize(9).font('Courier-Bold')
      .text(ticket.ticketId, qrColX, bodyY + qrSize + 29, { width: qrColW, align: 'center' });

    const bodyBottom = Math.max(iy, bodyY + qrBoxH) + pad;

    // Footer strip — dashed top border, admission note left / non-refundable
    // right, matching the on-screen card footer exactly.
    const footerH = 30;
    doc.moveTo(cardX, bodyBottom).lineTo(cardX + cardW, bodyBottom).dash(3, { space: 2 }).strokeColor('#DDD').stroke();
    doc.undash();
    doc.roundedRect(cardX, bodyBottom, cardW, footerH, 0).fillColor('#FAFAF9').fill();
    doc.fillColor('#888').fontSize(8.5).font('Helvetica')
      .text('Show this code or QR at entry', cardX + pad, bodyBottom + 10, { width: cardW / 2 })
      .text('Non-refundable', cardX + pad, bodyBottom + 10, { width: cardW - pad * 2, align: 'right' });

    // Card border (drawn last so it sits on top of the fills).
    doc.roundedRect(cardX, cardY, cardW, bodyBottom + footerH - cardY, 14).strokeColor('#FFD9C2').lineWidth(2).stroke();

    doc.fillColor('#999').fontSize(9).font('Helvetica')
      .text('Powered by Carrot Tickets', cardX, bodyBottom + footerH + 16, { width: cardW, align: 'center' });
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
}
