import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventFinancialsService } from '@services/eventFinancials.service';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const VENDOR = new mongoose.Types.ObjectId();

async function makeEvent(currency: 'SZL' | 'ZAR' = 'SZL') {
  return Event.create({
    vendorId: VENDOR,
    name: 'Piano Republic : Marked Money',
    venue: 'Sibanesami Hotel',
    eventDate: new Date('2026-08-22T00:00:00.000Z'),
    startTime: new Date('2026-08-22T13:00:00.000Z'),
    endTime: new Date('2026-08-23T04:00:00.000Z'),
    status: EventStatus.PUBLISHED,
    currency,
    ticketTypes: [{ name: 'General', price: 150, quantity: 100 }],
  });
}

/** One sale. Defaults describe a plain cash box-office sale so each test only
 *  states the fields its assertion actually depends on. */
async function sale(
  eventId: mongoose.Types.ObjectId,
  over: Partial<{
    method: PaymentMethod;
    channel: SalesChannel;
    status: PaymentStatus;
    quantity: number;
    face: number;
    bookingFee: number;
    absorbedFee: number;
    platformFee: number;
    resellerCommission: number;
    custody: 'carrot' | 'reseller' | 'vendor';
    resellerRemitted: boolean;
  }> = {}
) {
  const face = over.face ?? 150;
  const bookingFee = over.bookingFee ?? 0;
  const absorbedFee = over.absorbedFee ?? 0;
  const platformFee = over.platformFee ?? 0;
  const resellerCommission = over.resellerCommission ?? 0;

  return TicketSale.create({
    eventId,
    vendorId: VENDOR,
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: over.quantity ?? 1,
    totalAmount: face,
    currency: 'SZL',
    paymentMethod: over.method ?? PaymentMethod.CASH,
    paymentStatus: over.status ?? PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel: over.channel ?? SalesChannel.BOX_OFFICE,
    faceAmount: face,
    serviceFeeAmount: bookingFee,
    absorbedServiceFeeAmount: absorbedFee,
    platformFeeAmount: platformFee,
    resellerCommissionAmount: resellerCommission,
    amountCharged: face + bookingFee,
    organizerProceeds: face - platformFee - resellerCommission - absorbedFee,
    fundsCustody: over.custody ?? 'vendor',
    resellerRemitted: over.resellerRemitted ?? false,
    soldAt: new Date('2026-08-22T18:00:00.000Z'),
  });
}

describe('EventFinancialsService.getEventFinancials — payment method breakdown', () => {
  it('reports every payment method on its own row instead of collapsing them', async () => {
    const ev = await makeEvent();
    await sale(ev._id, { method: PaymentMethod.MTN_MOMO, channel: SalesChannel.ONLINE, face: 7490, quantity: 40, bookingFee: 320, custody: 'carrot' });
    await sale(ev._id, { method: PaymentMethod.PEACH_CARD, channel: SalesChannel.ONLINE, face: 15020, quantity: 68, bookingFee: 1020, custody: 'carrot' });
    await sale(ev._id, { method: PaymentMethod.CASH, face: 1850, quantity: 11 });

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), String(VENDOR), false);

    const methods = fin.byMethod.map((m) => m.method).sort();
    expect(methods).toEqual(['cash', 'mtn_momo', 'peach_card']);

    const momo = fin.byMethod.find((m) => m.method === 'mtn_momo')!;
    expect(momo.face).toBe(7490);
    expect(momo.tickets).toBe(40);
    expect(momo.bookingFee).toBe(320);
    expect(momo.charged).toBe(7810);
  });
});

describe('EventFinancialsService.getEventFinancials — free entries', () => {
  it('keeps zero-amount tickets out of the paid average', async () => {
    const ev = await makeEvent();
    await sale(ev._id, { method: PaymentMethod.MTN_MOMO, channel: SalesChannel.ONLINE, face: 7490, quantity: 40, bookingFee: 320, custody: 'carrot' });
    await sale(ev._id, { method: PaymentMethod.PEACH_CARD, channel: SalesChannel.ONLINE, face: 15020, quantity: 68, bookingFee: 1020, custody: 'carrot' });
    await sale(ev._id, { face: 1850, quantity: 11 });
    // Platform-printed wristband batch — 2,360 people in, zero money.
    await sale(ev._id, { channel: SalesChannel.WRISTBAND, face: 0, quantity: 2360 });
    // A price-0 tier claimed online is just as free, on a different channel.
    await sale(ev._id, { channel: SalesChannel.ONLINE, face: 0, quantity: 2, custody: 'carrot' });

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), String(VENDOR), false);

    expect(fin.comps.tickets).toBe(2362);
    expect(fin.comps.sales).toBe(2);
    expect(fin.paid.tickets).toBe(119);
    expect(fin.paid.sales).toBe(3);
    // 24,360 over 119 paid tickets — NOT over all 2,481.
    expect(fin.paid.averageTicketPrice).toBe(204.71);
  });
});

describe('EventFinancialsService.getEventFinancials — custody', () => {
  it('separates money Carrot holds from cash resellers and the organizer still hold', async () => {
    const ev = await makeEvent();
    // Online card/MoMo — Carrot has the money and can pay it out.
    await sale(ev._id, { method: PaymentMethod.PEACH_CARD, channel: SalesChannel.ONLINE, face: 15020, quantity: 68, bookingFee: 1020, custody: 'carrot' });
    // Reseller cash still in the reseller's pocket — owed, but not collectable yet.
    await sale(ev._id, { channel: SalesChannel.RESELLER_POS, face: 41800, quantity: 185, resellerCommission: 836, custody: 'reseller', resellerRemitted: false });
    // Reseller cash already handed in.
    await sale(ev._id, { channel: SalesChannel.RESELLER_POS, face: 600, quantity: 3, resellerCommission: 12, custody: 'reseller', resellerRemitted: true });
    // Box-office cash the organizer took at the gate — already in their hands.
    await sale(ev._id, { face: 1850, quantity: 11 });

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), String(VENDOR), false);

    expect(fin.custody.withCarrot).toBe(15020);
    expect(fin.custody.withResellersUnremitted).toBe(40964);
    expect(fin.custody.withResellersRemitted).toBe(588);
    expect(fin.custody.withVendor).toBe(1850);
    // What the organizer could actually be paid today: Carrot's balance plus
    // reseller cash that has come in. NOT the E40,964 still in a pocket.
    expect(fin.custody.availableNow).toBe(15608);
  });
});

describe('EventFinancialsService.getEventFinancials — sales channels', () => {
  it('breaks the same money down by where the ticket was bought', async () => {
    const ev = await makeEvent();
    await sale(ev._id, { method: PaymentMethod.MTN_MOMO, channel: SalesChannel.ONLINE, face: 7490, quantity: 40, bookingFee: 320, custody: 'carrot' });
    await sale(ev._id, { method: PaymentMethod.PEACH_CARD, channel: SalesChannel.ONLINE, face: 15020, quantity: 68, bookingFee: 1020, custody: 'carrot' });
    await sale(ev._id, { channel: SalesChannel.RESELLER_POS, face: 41800, quantity: 185, resellerCommission: 836, custody: 'reseller' });
    await sale(ev._id, { face: 1850, quantity: 11 });

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), String(VENDOR), false);

    const online = fin.byChannel.find((c) => c.channel === 'online')!;
    expect(online.face).toBe(22510);
    expect(online.bookingFee).toBe(1340);
    expect(online.tickets).toBe(108);

    const reseller = fin.byChannel.find((c) => c.channel === 'reseller_pos')!;
    expect(reseller.face).toBe(41800);
    expect(reseller.resellerCommission).toBe(836);
    expect(reseller.organizerProceeds).toBe(40964);

    // Highest-earning channel first, so the table leads with what matters.
    expect(fin.byChannel[0]!.channel).toBe('reseller_pos');
  });
});

describe('EventFinancialsService.getEventFinancials — totals', () => {
  it('rolls the ladder up from face value to what the organizer keeps', async () => {
    const ev = await makeEvent();
    await sale(ev._id, { method: PaymentMethod.MTN_MOMO, channel: SalesChannel.ONLINE, face: 7490, quantity: 40, bookingFee: 320, custody: 'carrot' });
    await sale(ev._id, { channel: SalesChannel.RESELLER_POS, face: 41800, quantity: 185, resellerCommission: 836, platformFee: 400, custody: 'reseller' });
    // Organizer covered this buyer's booking fee instead of charging it on top.
    await sale(ev._id, { method: PaymentMethod.PEACH_CARD, channel: SalesChannel.ONLINE, face: 1000, quantity: 5, absorbedFee: 75, custody: 'carrot' });

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), String(VENDOR), false);

    expect(fin.totals.face).toBe(50290);
    expect(fin.totals.bookingFees).toBe(320);
    expect(fin.totals.absorbedFees).toBe(75);
    expect(fin.totals.platformFees).toBe(400);
    expect(fin.totals.resellerCommission).toBe(836);
    // Buyers paid face + the fee they were charged; the absorbed one was not
    // added on top, so it must not inflate this.
    expect(fin.totals.charged).toBe(50610);
    expect(fin.totals.organizerProceeds).toBe(48979);
    // What Carrot earned on the event: fees the buyer paid, fees the organizer
    // covered, and commission — one number the organizer can reconcile against.
    expect(fin.totals.carrotEarned).toBe(795);
  });
});

describe('EventFinancialsService.getEventFinancials — failed payments', () => {
  it('reports attempted revenue that never completed', async () => {
    const ev = await makeEvent();
    await sale(ev._id, { method: PaymentMethod.MTN_MOMO, channel: SalesChannel.ONLINE, face: 7490, quantity: 40, bookingFee: 320, custody: 'carrot' });
    await sale(ev._id, { method: PaymentMethod.MTN_MOMO, channel: SalesChannel.ONLINE, face: 900, quantity: 6, status: PaymentStatus.FAILED });
    await sale(ev._id, { method: PaymentMethod.PEACH_CARD, channel: SalesChannel.ONLINE, face: 450, quantity: 3, status: PaymentStatus.FAILED });

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), String(VENDOR), false);

    expect(fin.failed.sales).toBe(2);
    expect(fin.failed.tickets).toBe(9);
    expect(fin.failed.face).toBe(1350);
    // Failed money must never leak into the completed figures.
    expect(fin.totals.face).toBe(7490);
  });
});

describe('EventFinancialsService.getEventFinancials — access', () => {
  it("404s rather than exposing another organizer's event", async () => {
    const ev = await makeEvent();
    const otherVendor = String(new mongoose.Types.ObjectId());

    await expect(
      EventFinancialsService.getEventFinancials(String(ev._id), otherVendor, false)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets a super-admin read an event they do not own', async () => {
    const ev = await makeEvent();
    await sale(ev._id, { face: 1850, quantity: 11 });
    const otherVendor = String(new mongoose.Types.ObjectId());

    const fin = await EventFinancialsService.getEventFinancials(String(ev._id), otherVendor, true);

    expect(fin.totals.face).toBe(1850);
  });
});
