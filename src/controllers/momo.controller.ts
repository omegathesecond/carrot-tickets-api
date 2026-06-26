import { Request, Response } from 'express';
import { TicketService } from '@services/ticket.service';

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

    // MTN's requesttopay callback keys on `externalId` (= our sale.saleId), and
    // carries NO X-Reference-Id at all. When referenceId is absent, correlate the
    // sale by externalId and pull its stored momoReferenceId.
    const externalId = req.body?.externalId;
    if (!referenceId && externalId) {
      const sale = await TicketService.getMomoSaleByExternalId(externalId);
      referenceId = sale?.momoReferenceId;
      console.log('[momo callback] resolved referenceId via externalId', {
        externalId,
        referenceId: referenceId ?? null,
        saleFound: !!sale,
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

    console.log('[momo callback] → finalizing sale', { referenceId, receivedAt });
    try {
      const result = await TicketService.finalizeMomoSale(referenceId);
      console.log('[momo callback] ✓ finalized', {
        referenceId,
        status: result.status,
        receivedAt,
        durationMs: Date.now() - Date.parse(receivedAt),
      });
    } catch (e) {
      console.error('[momo callback] ✗ finalize threw', {
        referenceId,
        receivedAt,
        error: e instanceof Error ? e.message : e,
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
    return res.status(200).json({ ok: true }); // always 200 so MTN doesn't retry-storm
  }
}
