import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';
import { PeachClient } from '@services/payments/peach.client';

const momo = { isConfigured: jest.fn(), requestToPay: jest.fn(), getStatus: jest.fn() };
jest.spyOn(MtnMomoClient.prototype, 'isConfigured').mockImplementation(() => momo.isConfigured());
jest.spyOn(MtnMomoClient.prototype, 'requestToPay').mockImplementation((...a: any[]) => momo.requestToPay(...a));
jest.spyOn(MtnMomoClient.prototype, 'getStatus').mockImplementation((...a: any[]) => momo.getStatus(...a));

const peach = { isConfigured: jest.fn(), createPayment: jest.fn(), getPaymentStatus: jest.fn() };
jest.spyOn(PeachClient.prototype, 'isConfigured').mockImplementation(() => peach.isConfigured());
jest.spyOn(PeachClient.prototype, 'createPayment').mockImplementation((...a: any[]) => peach.createPayment(...a));
jest.spyOn(PeachClient.prototype, 'getPaymentStatus').mockImplementation((...a: any[]) => peach.getPaymentStatus(...a));

import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { TransportPosController } from '@controllers/transportPos.controller';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { Reseller } from '@models/reseller.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(connectTestDb);
beforeEach(async () => {
  // peachCardEnabled defaults to false — re-seeded each time since
  // clearTestDb() (in the previous afterEach) wipes the config document.
  await PaymentConfigService.update({ peachCardEnabled: true, platformFeePercent: 0 });
});
afterEach(async () => {
  await clearTestDb();
  momo.isConfigured.mockReset(); momo.requestToPay.mockReset(); momo.getStatus.mockReset();
  peach.isConfigured.mockReset(); peach.createPayment.mockReset(); peach.getPaymentStatus.mockReset();
});
afterAll(disconnectTestDb);

async function seedTrip(scheme = SeatScheme.SEQUENTIAL, totalSeats = 4) {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${scheme}-${totalSeats}`, totalSeats, seatScheme: scheme });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}

// Guards the contract the new POS async endpoints expose:
// POST /bookings/momo -> initiateMomoBooking, GET /bookings/momo/:referenceId/status -> finalizeMomoBooking (poll)
// POST /bookings/card -> initiateCardBooking, GET /bookings/card/:paymentId/status -> finalizeCardBooking (poll)
describe('POS async booking flow (initiate + status poll)', () => {
  it('MoMo: initiate then poll status until CONFIRMED', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'REF-1' });
    const { trip } = await seedTrip();

    const initiated = await BookingService.initiateMomoBooking({
      tripId: trip._id.toString(), seatNumber: '1', passengerName: 'Passenger', passengerPhone: '76707421',
      momoPhone: '76707421', soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator',
    });
    expect(initiated.referenceId).toBe('REF-1');
    expect(initiated.saleId).toBeTruthy();
    expect(initiated.expiresAt).toBeInstanceOf(Date);

    // Poll while MTN is still pending — the status endpoint just re-runs finalize.
    momo.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });
    expect((await BookingService.finalizeMomoBooking(initiated.referenceId)).status).toBe('pending');

    // Poll again once MTN reports success.
    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });
    expect((await BookingService.finalizeMomoBooking(initiated.referenceId)).status).toBe('completed');

    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ momoReferenceId: initiated.referenceId });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('Card: initiate then poll status until CONFIRMED', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'PAY-1', code: '000.000.000', redirect: { url: 'https://pay.example/PAY-1' } });
    const { trip } = await seedTrip();

    const initiated = await BookingService.initiateCardBooking({
      tripId: trip._id.toString(), seatNumber: '1', passengerName: 'Passenger', passengerPhone: '76707421',
      soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator',
    });
    expect(initiated.paymentId).toBe('PAY-1');
    expect(initiated.redirectUrl).toBe('https://pay.example/PAY-1');
    expect(initiated.saleId).toBeTruthy();
    expect(initiated.expiresAt).toBeInstanceOf(Date);

    // Poll while Peach is still pending.
    peach.getPaymentStatus.mockResolvedValue({ code: '000.200.000', amount: '35', currency: 'ZAR' });
    expect((await BookingService.finalizeCardBooking(initiated.paymentId)).status).toBe('pending');

    // Poll again once Peach reports success.
    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '35', currency: 'ZAR' });
    expect((await BookingService.finalizeCardBooking(initiated.paymentId)).status).toBe('completed');

    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ peachPaymentId: initiated.paymentId });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });
});

// Guards the SP1c Task 6 authorization gap: momoStatus/cardStatus previously
// looked up the sale by provider reference ALONE, so any reseller with
// SELL_TICKETS could poll another reseller's booking status. Mirrors the
// events precedent (public.controller getMomoStatus/getCardStatus, scoped by
// the authenticated buyer's phone) — here scoped by resellerId instead.
describe('TransportPosController status polls are scoped to the owning reseller', () => {
  function fakeReqRes(params: Record<string, string>, reseller: { operatorId: string; resellerId: string; hubId?: string } | undefined) {
    const req: any = { params, reseller, originalUrl: '/test' };
    const res: any = { req };
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return { req, res };
  }

  it('MoMo: a different reseller polling another reseller\'s referenceId gets 404 and finalize never runs', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'REF-ISO-1' });
    const { trip } = await seedTrip();
    const resellerA = await Reseller.create({ businessName: 'Reseller A', status: 'active', isActive: true });
    const resellerB = await Reseller.create({ businessName: 'Reseller B', status: 'active', isActive: true });

    const initiated = await BookingService.initiateMomoBooking({
      tripId: trip._id.toString(), seatNumber: '1', passengerName: 'Passenger', passengerPhone: '76707421',
      momoPhone: '76707421', soldBy: resellerA._id.toString(), soldByType: 'reseller-operator',
      resellerId: resellerA._id.toString(),
    });

    // MTN would report success if asked — proves the 404 comes from the
    // ownership check short-circuiting BEFORE finalize, not from MTN denying.
    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });

    const { req, res } = fakeReqRes(
      { referenceId: initiated.referenceId },
      { operatorId: new mongoose.Types.ObjectId().toString(), resellerId: resellerB._id.toString() },
    );
    await TransportPosController.momoStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(momo.getStatus).not.toHaveBeenCalled();

    const sale = await BookingSale.findOne({ momoReferenceId: initiated.referenceId });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.PENDING);
  });

  it('MoMo: the owning reseller polling their own referenceId gets the status', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'REF-ISO-2' });
    const { trip } = await seedTrip();
    const resellerA = await Reseller.create({ businessName: 'Reseller A2', status: 'active', isActive: true });

    const initiated = await BookingService.initiateMomoBooking({
      tripId: trip._id.toString(), seatNumber: '1', passengerName: 'Passenger', passengerPhone: '76707421',
      momoPhone: '76707421', soldBy: resellerA._id.toString(), soldByType: 'reseller-operator',
      resellerId: resellerA._id.toString(),
    });

    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });

    const { req, res } = fakeReqRes(
      { referenceId: initiated.referenceId },
      { operatorId: new mongoose.Types.ObjectId().toString(), resellerId: resellerA._id.toString() },
    );
    await TransportPosController.momoStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { status: 'completed' } }));

    const sale = await BookingSale.findOne({ momoReferenceId: initiated.referenceId });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('Card: a different reseller polling another reseller\'s paymentId gets 404 and finalize never runs', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'PAY-ISO-1', code: '000.000.000', redirect: { url: 'https://pay.example/PAY-ISO-1' } });
    const { trip } = await seedTrip();
    const resellerA = await Reseller.create({ businessName: 'Reseller A3', status: 'active', isActive: true });
    const resellerB = await Reseller.create({ businessName: 'Reseller B3', status: 'active', isActive: true });

    const initiated = await BookingService.initiateCardBooking({
      tripId: trip._id.toString(), seatNumber: '1', passengerName: 'Passenger', passengerPhone: '76707421',
      soldBy: resellerA._id.toString(), soldByType: 'reseller-operator', resellerId: resellerA._id.toString(),
    });

    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '35', currency: 'ZAR' });

    const { req, res } = fakeReqRes(
      { paymentId: initiated.paymentId },
      { operatorId: new mongoose.Types.ObjectId().toString(), resellerId: resellerB._id.toString() },
    );
    await TransportPosController.cardStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(peach.getPaymentStatus).not.toHaveBeenCalled();

    const sale = await BookingSale.findOne({ peachPaymentId: initiated.paymentId });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.PENDING);
  });

  it('Card: the owning reseller polling their own paymentId gets the status', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'PAY-ISO-2', code: '000.000.000', redirect: { url: 'https://pay.example/PAY-ISO-2' } });
    const { trip } = await seedTrip();
    const resellerA = await Reseller.create({ businessName: 'Reseller A4', status: 'active', isActive: true });

    const initiated = await BookingService.initiateCardBooking({
      tripId: trip._id.toString(), seatNumber: '1', passengerName: 'Passenger', passengerPhone: '76707421',
      soldBy: resellerA._id.toString(), soldByType: 'reseller-operator', resellerId: resellerA._id.toString(),
    });

    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '35', currency: 'ZAR' });

    const { req, res } = fakeReqRes(
      { paymentId: initiated.paymentId },
      { operatorId: new mongoose.Types.ObjectId().toString(), resellerId: resellerA._id.toString() },
    );
    await TransportPosController.cardStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { status: 'completed' } }));

    const sale = await BookingSale.findOne({ peachPaymentId: initiated.paymentId });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });
});
