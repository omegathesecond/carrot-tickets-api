import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { WaiterToken, WaiterPermission } from '@interfaces/waiter.interface';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';
import { HEX24, hexId } from '@utils/controllerHelpers.util';
import { TableService, TableLabelTakenError, TableAlreadySettledError, TableFulfilmentNotFoundError, TableFulfilmentStateError, WaiterTableView } from '@services/table.service';
import { PosCatalogService } from '@services/posCatalog.service';
import {
  VenueTableService, WalkoutNeedsManagerError, RoundOutOfStockError, LineLockedError,
  PaymentRefusedError, BillChangedError, PaymentIdempotencyMismatchError, RoundItem,
} from '@services/venueTable.service';
import { StockAlertService } from '@services/stockAlert.service';
import { roundSchema, tablePaymentSchema } from '@validators/venueSelling.validator';

export interface WaiterVenue { _id: unknown; name: string; currency: 'SZL' | 'ZAR'; vendorId: unknown; status: string }

/** The venue authenticateWaiter loaded for this request (venue waiters only). */
export const venueOf = (req: Request): WaiterVenue => (req as any).waiterVenue as WaiterVenue;
export const waiterOf = (req: Request): WaiterToken => (req as any).waiter as WaiterToken;

export const TABLE_STATUSES = ['open', 'settled', 'voided'] as const;
const venueIdOf = (req: Request): string => String(venueOf(req)._id);

/**
 * May this waiter work this table? Their own — or any, for a shift lead — and
 * ALWAYS one of this venue's. 404 otherwise: a waiter has no business learning
 * that an id exists. Returns true to proceed; otherwise it has answered.
 */
export async function mayWorkTable(req: Request, res: Response, tableId: string): Promise<boolean> {
  const waiter = waiterOf(req);
  const table = HEX24.test(tableId)
    ? await Table.findOne({ _id: tableId, venueId: venueOf(req)._id }, { openedBy: 1 }).lean<{ openedBy: string } | null>()
    : null;
  const allowed = !!table && (table.openedBy === waiter.waiterId || waiter.permissions.includes(WaiterPermission.MANAGE_ALL_TABLES));
  if (!allowed) ApiResponseUtil.notFound(res, 'Table not found');
  return allowed;
}

/**
 * The table this request addresses, as a normalised id, once this waiter may
 * work it — or null after the 404. The URL id is lower-cased because
 * `String(ObjectId)` always is: compared as a string, an uppercase id would
 * match nothing and read as "not found" deep in a service.
 */
async function workableTable(req: Request, res: Response): Promise<string | null> {
  const tableId = String(req.params['id']).toLowerCase();
  return (await mayWorkTable(req, res, tableId)) ? tableId : null;
}

/** One table as the waiter's app shows it (names resolved). */
export async function presentOne(table: ITable): Promise<WaiterTableView> {
  const [view] = await TableService.present([TableService.plain(table)]);
  return view!;
}

/** Answer a venue table error. Known cases get their status; anything else is a loud 500. */
export function answerTableError(res: Response, e: any, fallback: string): Response {
  if (e instanceof TableLabelTakenError) return ApiResponseUtil.error(res, e.message, 409);
  if (e instanceof WalkoutNeedsManagerError) return ApiResponseUtil.forbidden(res, e.message);
  if (e instanceof RoundOutOfStockError) {
    return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason, productId: e.productId, name: e.productName, available: e.available });
  }
  if (e instanceof LineLockedError || e instanceof TableFulfilmentStateError) return ApiResponseUtil.error(res, e.message, 409);
  if (e instanceof PaymentRefusedError) return ApiResponseUtil.error(res, e.message, 400, { reason: e.reason, ...e.detail });
  if (e instanceof BillChangedError || e instanceof PaymentIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason });
  if (e instanceof TableAlreadySettledError) return ApiResponseUtil.error(res, e.message, 409);
  if (e instanceof TableFulfilmentNotFoundError) return ApiResponseUtil.notFound(res, e.message);
  const message: string = e?.message || fallback;
  if (/is required/i.test(message)) return ApiResponseUtil.badRequest(res, message);
  if (/not found at this venue|is not sold at that stall/i.test(message)) return ApiResponseUtil.badRequest(res, message);
  if (/not open/i.test(message)) return ApiResponseUtil.error(res, message, 409);
  if (/table not found/i.test(message)) return ApiResponseUtil.notFound(res, 'Table not found');
  if (/line not found/i.test(message)) return ApiResponseUtil.notFound(res, message);
  console.error(fallback, e);
  return ApiResponseUtil.error(res, message, 500);
}

/**
 * The venue waiter's app (venue trading Phase 3). Reached only through
 * byWaiterKind, so every handler here has a venue. Handlers answer; they never
 * throw (Express 4 does not await them).
 */
export class VenueWaiterController {
  /** GET /api/waiter/venue — where this waiter works, and what they may do NOW. */
  static async venue(req: Request, res: Response): Promise<any> {
    const venue = venueOf(req);
    return ApiResponseUtil.success(res, {
      venue: { id: String(venue._id), name: venue.name, currency: venue.currency },
      // The row-derived set from authenticateWaiter, not the token's copy.
      permissions: waiterOf(req).permissions,
    });
  }

  /** GET /api/waiter/products — the venue's whole menu, each product with its stall. */
  static async getProducts(req: Request, res: Response): Promise<any> {
    const products = await PosCatalogService.forScope({ venueId: venueIdOf(req) });
    return ApiResponseUtil.success(res, { products });
  }

  /** POST /api/waiter/tables { label } */
  static async openTable(req: Request, res: Response): Promise<any> {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) return ApiResponseUtil.badRequest(res, 'label is required');
    try {
      const table = await TableService.open({ venueId: venueIdOf(req), label, openedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.created(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not open the table'); }
  }

  /** GET /api/waiter/tables?status=open|settled|voided&q= — own tables; the floor for a shift lead. */
  static async listTables(req: Request, res: Response): Promise<any> {
    const raw = req.query['status'];
    const status = TABLE_STATUSES.find((s) => s === raw);
    if (raw !== undefined && !status) return ApiResponseUtil.badRequest(res, 'Unknown table status');
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
    const waiter = waiterOf(req);
    const wholeFloor = waiter.permissions.includes(WaiterPermission.MANAGE_ALL_TABLES);
    const tables = await TableService.list({ venueId: venueIdOf(req) }, { status, q, ...(wholeFloor ? {} : { openedBy: waiter.waiterId }) });
    return ApiResponseUtil.success(res, { tables });
  }

  /** POST /api/waiter/tables/:id/void { reason } — cancel an EMPTY table. A walkout is a manager's. */
  static async cancelTable(req: Request, res: Response): Promise<any> {
    const tableId = await workableTable(req, res);
    if (!tableId) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    try {
      const table = await VenueTableService.cancelEmptyTable({ venueId: venueIdOf(req), tableId, reason, voidedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not cancel the table'); }
  }

  /** POST /api/waiter/tables/:id/orders { clientTxnId, items: [{ merchantId, productId, qty }] } — send a round. */
  static async sendOrder(req: Request, res: Response): Promise<any> {
    const { error, value } = roundSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const tableId = await workableTable(req, res);
    if (!tableId) return;
    try {
      const table = await VenueTableService.sendOrder({ venueId: venueIdOf(req), tableId, clientTxnId: value.clientTxnId, items: value.items, sentBy: waiterOf(req).waiterId });
      // Best-effort, off the money path: a round takes stock off the shelf, so one evaluation per stall in it.
      const vendorId = String(venueOf(req).vendorId);
      const byStall = new Map<string, string[]>();
      for (const item of value.items as RoundItem[]) byStall.set(item.merchantId, [...(byStall.get(item.merchantId) ?? []), item.productId]);
      for (const [merchantId, productIds] of byStall) {
        StockAlertService.evaluateAfterSale({ vendorId, merchantId, productIds }).catch((err) => console.error('[low-stock] evaluateAfterSale failed', err));
      }
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not send the round'); }
  }

  /** POST /api/waiter/tables/:id/payments { clientTxnId, tenders, lines? } — needs waiter:settle_tables. */
  static async pay(req: Request, res: Response): Promise<any> {
    const { error, value } = tablePaymentSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const tableId = await workableTable(req, res);
    if (!tableId) return;
    try {
      const waiter = waiterOf(req);
      const result = await VenueTableService.pay({
        venueId: venueIdOf(req), tableId, clientTxnId: value.clientTxnId, tenders: value.tenders, lines: value.lines,
        takenBy: waiter.waiterId, staffName: waiter.fullName,
      });
      return ApiResponseUtil.success(res, { payment: result.payment, table: await presentOne(result.table), closed: result.closed });
    } catch (e) { return answerTableError(res, e, 'Could not take the payment'); }
  }

  /** POST /api/waiter/tables/:id/orders/:orderId/accept — the waiter collects a handed-out round. */
  static async acceptOrder(req: Request, res: Response): Promise<any> {
    const tableId = await workableTable(req, res);
    if (!tableId) return;
    const orderId = hexId(req.params['orderId']);
    if (!orderId) return ApiResponseUtil.notFound(res, 'no handover for this stall on that table');
    try {
      const table = await VenueTableService.acceptOrder({ venueId: venueIdOf(req), tableId, orderId, acceptedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not accept the order'); }
  }

  /** DELETE /api/waiter/tables/:id/items/:lineId — only while the round is still at the counter. */
  static async removeLine(req: Request, res: Response): Promise<any> {
    const tableId = await workableTable(req, res);
    if (!tableId) return;
    const lineId = hexId(req.params['lineId']);
    if (!lineId) return ApiResponseUtil.notFound(res, 'line not found on this table');
    try {
      const table = await VenueTableService.removeLine({ venueId: venueIdOf(req), tableId, lineId, removedBy: waiterOf(req).waiterId });
      return ApiResponseUtil.success(res, await presentOne(table));
    } catch (e) { return answerTableError(res, e, 'Could not remove that line'); }
  }
}
