import { Request, Response } from 'express';
import { TicketService } from '@services/ticket.service';

export class MomoController {
  /**
   * MTN MoMo callback: MTN PUTs/POSTs the requesttopay result to X-Callback-Url.
   * Body contains referenceId/externalId. Always returns 200 so MTN doesn't retry-storm.
   */
  static async callback(req: Request, res: Response): Promise<any> {
    const referenceId = (req.body?.referenceId) || (req.params as any)?.referenceId;
    if (!referenceId) return res.status(400).json({ ok: false });
    try {
      await TicketService.finalizeMomoSale(referenceId);
    } catch (e) {
      console.error('[momo callback]', e);
    }
    return res.status(200).json({ ok: true }); // always 200 so MTN doesn't retry-storm
  }
}
