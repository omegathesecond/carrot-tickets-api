import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { EventCouponService } from '@services/eventCoupon.service';
import { resolveCart } from '@services/cart.service';
import { TicketService } from '@services/ticket.service';
import { ReservationService } from '@services/reservation.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EventCoupon } from '@models/eventCoupon.model';
import { TicketSale } from '@models/ticketSale.model';
import { TicketReservation } from '@models/ticketReservation.model';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';

beforeAll(connectLedgerTestDb, 60000);
afterAll(disconnectTestDb);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
beforeEach(() => {
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
});

async function fixture(discountType: 'percentage' | 'fixed' = 'percentage', discountValue = 50) {
  const seed = await seedEventWithTiers([{ name: 'General', price: 100, quantity: 20 }, { name: 'VIP', price: 250, quantity: 20 }]);
  const [coupon] = await EventCouponService.create(seed.eventId, seed.vendorId, {
    count: 1, label: 'Guest', discountType, discountValue, ticketTypeIds: [],
  });
  return { ...seed, coupon: coupon!, couponCode: coupon!.code,
    items: [{ ticketTypeId: seed.ticketTypeIds[0]!, quantity: 1 }], buyerId: String(new mongoose.Types.ObjectId()), channel: SalesChannel.ONLINE };
}

function newSale(f: Awaited<ReturnType<typeof fixture>>) {
  return new TicketSale({ eventId: f.eventId, vendorId: f.vendorId, ticketIds: [], quantity: 1,
    totalAmount: 50, paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING,
    soldBy: f.vendorId, soldByType: 'Vendor', channel: SalesChannel.ONLINE });
}

it('generates unique event-scoped codes and rejects another organizer', async () => {
  const f = await fixture();
  const batch = await EventCouponService.create(f.eventId, f.vendorId, { count: 100, label: 'Guests', discountType: 'fixed', discountValue: 20, ticketTypeIds: [] });
  expect(new Set(batch.map(c => c.code)).size).toBe(100);
  await expect(EventCouponService.create(f.eventId, String(new mongoose.Types.ObjectId()), { count: 1, label: '', discountType: 'percentage', discountValue: 10, ticketTypeIds: [] })).rejects.toThrow('Event not found');
  await expect(EventCouponService.list(f.eventId, String(new mongoose.Types.ObjectId()), 1)).rejects.toThrow('Event not found');
});

it('discounts exactly one highest-priced ticket and freezes real ticket prices', async () => {
  const f = await fixture();
  const cart = await resolveCart({ ...f, items: [{ ticketTypeId: f.ticketTypeIds[0]!, quantity: 2 }, { ticketTypeId: f.ticketTypeIds[1]!, quantity: 2 }], method: PaymentMethod.MTN_MOMO });
  expect(cart.faceTotal).toBe(575); // 700 - 125 (one VIP only)
  expect(cart.coupon).toMatchObject({ originalAmount: 700, discountAmount: 125, ticketTypeId: f.ticketTypeIds[1] });
  expect(cart.lines.map(l => [l.unitPrice, l.quantity])).toEqual([[100, 2], [250, 1], [125, 1]]);
});

it('honors eligible ticket types, normalizes code case and excludes other events', async () => {
  const f = await fixture();
  await EventCoupon.updateOne({ _id: f.coupon._id }, { ticketTypeIds: [f.ticketTypeIds[0]] });
  const cart = await resolveCart({ ...f, couponCode: ` ${f.couponCode.toLowerCase()} `, items: [{ ticketTypeId: f.ticketTypeIds[0]!, quantity: 1 }, { ticketTypeId: f.ticketTypeIds[1]!, quantity: 1 }], method: PaymentMethod.MTN_MOMO });
  expect(cart.coupon!.discountAmount).toBe(50);
  const other = await seedEventWithTiers([{ name: 'Other', price: 100, quantity: 10 }]);
  await expect(resolveCart({ ...other, couponCode: f.couponCode, items: [{ ticketTypeId: other.ticketTypeIds[0]!, quantity: 1 }], method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/not valid for this event/);
});

it('caps fixed discounts at one ticket price and charges fees only for remaining paid tickets', async () => {
  const f = await fixture('fixed', 150);
  await PaymentConfigService.update({ momoServiceFee: 5 });
  const cart = await resolveCart({ ...f, items: [{ ticketTypeId: f.ticketTypeIds[0]!, quantity: 3 }], method: PaymentMethod.MTN_MOMO });
  expect(cart.faceTotal).toBe(200);
  expect(cart.serviceFeeAmount).toBe(10);
  expect(cart.amountCharged).toBe(210);
  expect(cart.coupon!.discountAmount).toBe(100);
});

it.each(['expired', 'disabled', 'ineligible'] as const)('rejects a %s coupon', async state => {
  const f = await fixture();
  const update = state === 'expired' ? { expiresAt: new Date(Date.now() - 1000) } : state === 'disabled' ? { disabled: true } : { ticketTypeIds: [f.ticketTypeIds[1]] };
  await EventCoupon.updateOne({ _id: f.coupon._id }, update);
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/expired|disabled|does not apply/);
});

it('atomically allows only one checkout to reserve a code, with no losing sale left behind', async () => {
  const f = await fixture();
  const cart = await resolveCart({ ...f, method: PaymentMethod.MTN_MOMO });
  const attempts = await Promise.allSettled([EventCouponService.saveCheckout(newSale(f), cart.coupon), EventCouponService.saveCheckout(newSale(f), cart.coupon)]);
  expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
  expect(await TicketSale.countDocuments()).toBe(1);
  expect((await EventCoupon.findById(f.coupon._id))!.saleId).toBeTruthy();
});

it('rolls the code lock back when saving the sale fails', async () => {
  const f = await fixture();
  const cart = await resolveCart({ ...f, method: PaymentMethod.MTN_MOMO });
  const invalid = newSale(f); invalid.totalAmount = -1;
  await expect(EventCouponService.saveCheckout(invalid, cart.coupon)).rejects.toThrow();
  expect((await EventCoupon.findById(f.coupon._id))!.saleId).toBeNull();
  expect(await TicketSale.countDocuments()).toBe(0);
});

it('releases confirmed failed payments, but completed/refunded sales permanently consume the code', async () => {
  const f = await fixture();
  const cart = await resolveCart({ ...f, method: PaymentMethod.MTN_MOMO });
  const first = newSale(f); await EventCouponService.saveCheckout(first, cart.coupon);
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/reserved/);
  first.paymentStatus = PaymentStatus.FAILED; await first.save();
  const nextCart = await resolveCart({ ...f, method: PaymentMethod.MTN_MOMO });
  const second = newSale(f); await EventCouponService.saveCheckout(second, nextCart.coupon);
  second.paymentStatus = PaymentStatus.COMPLETED; second.refundedQuantity = 1; await second.save();
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/already been used/);
});

it('makes a 100% coupon free without a gateway call and reports who redeemed it', async () => {
  const f = await fixture('percentage', 100);
  const wallet = jest.spyOn(KeshlessPaymentService, 'acceptPayment');
  const result = await TicketService.claimFreeTicket({ ...f, customerName: 'Sarah' });
  expect(result.totalAmount).toBe(0);
  expect(result.tickets).toHaveLength(1);
  expect(wallet).not.toHaveBeenCalled();
  const ticket = await Ticket.findOne(); expect(ticket!.price).toBe(0);
  const page = await EventCouponService.list(f.eventId, f.vendorId, 1);
  expect(page.coupons[0]).toMatchObject({ status: 'used', redemption: { customerName: 'Sarah', discountAmount: 100 } });
  expect(page.coupons[0]!.redemption!.usedAt).toBeInstanceOf(Date);
  await expect(TicketService.claimFreeTicket(f)).rejects.toThrow(/already been used/);
});

it('refuses to claim a partially discounted paid ticket for free', async () => {
  const f = await fixture();
  await expect(TicketService.claimFreeTicket(f)).rejects.toThrow(/not free/);
  expect(await Ticket.countDocuments()).toBe(0);
  expect((await EventCoupon.findById(f.coupon._id))!.saleId).toBeNull();
});

it('wallet checkout charges the discounted amount, persists that price, and reopens a declined code', async () => {
  const f = await fixture();
  const charge = jest.spyOn(KeshlessPaymentService, 'acceptPayment').mockResolvedValueOnce({ status: 'failed', message: 'Declined' } as any)
    .mockResolvedValueOnce({ status: 'completed', transactionId: 'wallet-test' } as any);
  await expect(TicketService.purchaseForCustomer({ ...f, keshlessCardNumber: 'TEST0001', keshlessPin: '1234' })).rejects.toThrow('Declined');
  const result = await TicketService.purchaseForCustomer({ ...f, keshlessCardNumber: 'TEST0001', keshlessPin: '1234' });
  expect(charge).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 50 }));
  expect(result.totalAmount).toBe(50);
  expect((await Ticket.findOne())!.price).toBe(50);
  expect((await Event.findById(f.eventId))!.totalRevenue).toBe(50);
});

it('MoMo charges the discount and fee, finalizes once, and does not unlock on an expired inventory hold', async () => {
  const f = await fixture();
  await PaymentConfigService.update({ momoServiceFee: 5 });
  const client = (TicketService as any).momoClient;
  jest.spyOn(client, 'isConfigured').mockReturnValue(true);
  const request = jest.spyOn(client, 'requestToPay').mockResolvedValue({ referenceId: 'coupon-momo' });
  const status = jest.spyOn(client, 'getStatus').mockResolvedValue({ status: 'PENDING' });
  const result = await TicketService.initiateMomoPurchase({ ...f, momoPhone: '26878422613' });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ amount: 55 }));
  await TicketReservation.updateOne({ saleId: result.saleId }, { expiresAt: new Date(0) });
  await ReservationService.sweepExpired();
  expect((await TicketSale.findById(result.saleId))!.paymentStatus).toBe(PaymentStatus.PENDING);
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/reserved/);
  status.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '55', currency: 'SZL' } });
  await TicketService.finalizeMomoSale('coupon-momo');
  await TicketService.finalizeMomoSale('coupon-momo');
  expect(await Ticket.countDocuments()).toBe(1);
  expect((await Ticket.findOne())!.price).toBe(50);
  expect((await Event.findById(f.eventId))!.totalRevenue).toBe(50);
});

it('keeps uncertain provider errors locked instead of letting a potentially paid code be reused', async () => {
  const f = await fixture();
  const client = (TicketService as any).momoClient;
  jest.spyOn(client, 'isConfigured').mockReturnValue(true);
  jest.spyOn(client, 'requestToPay').mockRejectedValue(new Error('Network timeout'));
  await expect(TicketService.initiateMomoPurchase({ ...f, momoPhone: '26878422613' })).rejects.toThrow(/remains reserved/);
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/reserved/);
});

it.each([
  ['peachClient', 'createPayment', 'initiateCardPurchase', { id: 'coupon-card', redirect: {} }],
  ['deltapayClient', 'createSession', 'initiateDeltapayPurchase', { checkoutSessionId: 'coupon-delta', checkoutUrl: 'https://checkout.test' }],
  ['yocoClient', 'createCheckout', 'initiateYocoPurchase', { id: 'coupon-yoco', redirectUrl: 'https://checkout.test' }],
  ['yebopayClient', 'createCheckout', 'initiateYeboPayPurchase', { id: 'coupon-yebopay', hostedUrl: 'https://checkout.test' }],
] as const)('%s receives the discounted price, freezes it on the sale and reserves the code', async (clientKey, createKey, initiateKey, response) => {
  const f = await fixture();
  await PaymentConfigService.update({ peachCardEnabled: true, deltapayEnabled: true, yocoEnabled: true, yebopayEnabled: true,
    cardServiceFee: 5, deltapayServiceFee: 5, yocoServiceFee: 5, yebopayServiceFee: 5 });
  process.env['CARD_RESULT_URL'] = 'https://carrot.test/return';
  process.env['DELTAPAY_RETURN_URL'] = 'https://carrot.test/return';
  process.env['YOCO_RETURN_URL'] = 'https://carrot.test/return';
  process.env['YEBOPAY_RETURN_URL'] = 'https://carrot.test/return';
  const client = (TicketService as any)[clientKey];
  jest.spyOn(client, 'isConfigured').mockReturnValue(true);
  const create = jest.spyOn(client, createKey).mockResolvedValue(response);
  const result = await (TicketService[initiateKey] as Function)(f);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 55 }));
  const sale = await TicketSale.findById(result.saleId);
  expect(sale).toMatchObject({ totalAmount: 50, serviceFeeAmount: 5, amountCharged: 55,
    coupon: { code: f.couponCode, discountAmount: 50 }, lines: [{ unitPrice: 50, quantity: 1 }] });
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/reserved/);
});

it('keeps the coupon locked when a settled payment reports the wrong amount', async () => {
  const f = await fixture();
  const client = (TicketService as any).momoClient;
  jest.spyOn(client, 'isConfigured').mockReturnValue(true);
  jest.spyOn(client, 'requestToPay').mockResolvedValue({ referenceId: 'coupon-wrong-amount' });
  jest.spyOn(client, 'getStatus').mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '1', currency: 'SZL' } });
  await TicketService.initiateMomoPurchase({ ...f, momoPhone: '26878422613' });
  await expect(TicketService.finalizeMomoSale('coupon-wrong-amount')).rejects.toThrow(/remains reserved/);
  expect(await Ticket.countDocuments()).toBe(0);
  await expect(resolveCart({ ...f, method: PaymentMethod.MTN_MOMO })).rejects.toThrow(/reserved/);
});
