import { Request, Response } from 'express';
import { TicketService } from '@services/ticket.service';
import { BookingService } from '@services/transport/booking.service';
import { MenuOrderService } from '@services/menuOrder.service';

type MomoFinalizeResult = { status: 'completed' | 'failed' | 'pending'; reason?: string };

/**
 * Every domain that collects via MTN MoMo, in the order the callback tries
 * them. A callback carries only a referenceId (or an externalId we resolve to
 * one), never which domain it belongs to, so the finalisers are walked in
 * turn: each throws a "... not found ..." error when the reference is not its
 * own, and each is idempotent, so a retried callback can walk the chain again
 * safely.
 */
const MOMO_FINALIZERS: ReadonlyArray<{ label: string; run: (referenceId: string) => Promise<MomoFinalizeResult> }> = [
  { label: 'ticket sale', run: (ref) => TicketService.finalizeMomoSale(ref) },
  { label: 'bus booking', run: (ref) => BookingService.finalizeMomoBooking(ref) },
  { label: 'menu order', run: (ref) => MenuOrderService.finalizeMomoOrder(ref) },
];

export class MomoController {
  /**
   * MTN MoMo callback: MTN PUTs/POSTs the requesttopay result to X-Callback-Url.
   * Body contains referenceId/externalId. Always returns 200 so MTN doesn't retry-storm.
   */
  static async callback(req: Request, res: Response): Promise<any> {
    const receivedAt = new Date().toISOString();
    // MTN's callback is fire-and-forget (we always 200), so this is the ONLY
    // place we capture what MTN actually sent. Log the whole envelope verbosely.
    console.log('[momo callback] ⇩ received', {
      receivedAt,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      headers: {
        'x-reference-id': req.get('X-Reference-Id'),
        'x-callback-url': req.get('X-Callback-Url'),
        'content-type': req.get('Content-Type'),
        'user-agent': req.get('User-Agent'),
      },
      params: req.params,
      query: req.query,
      body: req.body,
    });

    let referenceId =
      (req.body?.referenceId) ||
      (req.params as any)?.referenceId ||
      req.get('X-Reference-Id');

    // MTN's requesttopay callback keys on `externalId` (= what WE sent: a
    // TicketSale's saleId, a BookingSale's saleRef, or a MenuOrder's orderId)
    // and carries NO X-Reference-Id at all. When referenceId is absent,
    // correlate by externalId and pull the stored momoReferenceId.
    const externalId = req.body?.externalId;
    if (!referenceId && externalId) {
      const sale = await TicketService.getMomoSaleByExternalId(externalId);
      referenceId = sale?.momoReferenceId;
      let bookingSaleFound = false;
      let menuOrderFound = false;
      if (!referenceId) {
        const bSale = await BookingService.getMomoBookingSaleByExternalId(externalId);
        referenceId = bSale?.momoReferenceId;
        bookingSaleFound = !!bSale;
      }
      if (!referenceId) {
        const order = await MenuOrderService.getMomoOrderByExternalId(externalId);
        referenceId = order?.momoReferenceId;
        menuOrderFound = !!order;
      }
      console.log('[momo callback] resolved referenceId via externalId', {
        externalId,
        referenceId: referenceId ?? null,
        saleFound: !!sale,
        bookingSaleFound,
        menuOrderFound,
        receivedAt,
      });
    }

    if (!referenceId) {
      console.warn('[momo callback] ✗ could not resolve referenceId (no referenceId/externalId match) — ignoring', {
        receivedAt,
        externalId: externalId ?? null,
        body: req.body,
        params: req.params,
      });
      return res.status(400).json({ ok: false });
    }

    console.log('[momo callback] → finalizing', { referenceId, receivedAt });
    await MomoController.finalizeAcrossDomains(referenceId, receivedAt);
    return res.status(200).json({ ok: true }); // always 200 so MTN doesn't retry-storm
  }

  /**
   * Walk MOMO_FINALIZERS until one owns the reference. A "not found" from a
   * finaliser means "not mine" — fall through. Any other failure is real:
   * log it loudly and stop; MTN's retry and the domain's reconciler sweep
   * will come back for it.
   */
  private static async finalizeAcrossDomains(referenceId: string, receivedAt: string): Promise<void> {
    for (const { label, run } of MOMO_FINALIZERS) {
      try {
        const result = await run(referenceId);
        console.log(`[momo callback] ✓ ${label} finalized`, {
          referenceId,
          status: result.status,
          receivedAt,
          durationMs: Date.now() - Date.parse(receivedAt),
        });
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(message)) {
          console.log(`[momo callback] ↩ no ${label} for reference — trying next finalizer`, { referenceId, receivedAt });
          continue;
        }
        console.error(`[momo callback] ✗ ${label} finalize threw`, {
          referenceId,
          receivedAt,
          error: message,
          stack: e instanceof Error ? e.stack : undefined,
        });
        return;
      }
    }
    console.error('[momo callback] ✗ no ticket sale, bus booking or menu order for reference', { referenceId, receivedAt });
  }
}
