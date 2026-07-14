// src/controllers/__tests__/bookingPaymentDispatch.test.ts
//
// SP1c Task 5: the MoMo callback + card webhook currently only finalize
// TICKET sales. When a referenceId/paymentId belongs to a bus BookingSale
// instead, the ticket finalizer throws "not found" — this suite asserts the
// controllers fall through to BookingService.finalize{Momo,Card}Booking so
// bus bookings actually confirm, and that a genuinely-unknown reference still
// never breaks the webhook's always-200 contract.
//
// Real in-memory Mongo (mirrors booking.momo.test.ts / booking.card.test.ts);
// only the gateway CLIENTS are spied so BookingService's DB-backed logic runs
// for real.

import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
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

import { MomoController } from '@controllers/momo.controller';
import { CardController } from '@controllers/card.controller';
import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { Trip } from '@models/transport/trip.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus } from '@interfaces/booking.interface';
import { PaymentStatus } from '@interfaces/ticket.interface';

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

async function seedTrip() {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: `VT-${Date.now()}-${Math.random()}`, totalSeats: 4, seatScheme: SeatScheme.SEQUENTIAL });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  return { vendorId, trip };
}
const bookingArgs = (extra: any) => ({
  passengerName: 'T', passengerPhone: '76707421',
  soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator' as const,
  ...extra,
});

function mockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res as Response;
}

// MomoController.callback logs req.method/originalUrl/ip/get(...)/params/query
// before it even looks at referenceId — a plain `{ body }` fake req isn't
// enough (unlike the card controller, which only reads req.body/req.headers).
function mockMomoReq(body: any): Request {
  return {
    body,
    method: 'POST',
    originalUrl: '/api/public/purchase/momo/callback',
    ip: '127.0.0.1',
    params: {},
    query: {},
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as Request;
}

describe('MoMo callback dispatches to the bus booking finalizer', () => {
  it('confirms a PENDING bus booking when the referenceId only matches a BookingSale', async () => {
    momo.isConfigured.mockReturnValue(true);
    momo.requestToPay.mockResolvedValue({ referenceId: 'BUS-MOMO-1' });
    const { trip } = await seedTrip();
    await BookingService.initiateMomoBooking(bookingArgs({ tripId: trip._id.toString(), seatNumber: '1', momoPhone: '76707421' }));

    momo.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '35', currency: 'SZL' } });

    const req = mockMomoReq({ referenceId: 'BUS-MOMO-1' });
    const res = mockRes();
    await MomoController.callback(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ momoReferenceId: 'BUS-MOMO-1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('still returns 200 and does not throw for a reference matching neither a ticket sale nor a booking sale', async () => {
    const req = mockMomoReq({ referenceId: 'GHOST-REF' });
    const res = mockRes();
    await expect(MomoController.callback(req, res)).resolves.not.toThrow();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('Card webhook dispatches to the bus booking finalizer', () => {
  it('confirms a PENDING bus booking when the paymentId only matches a BookingSale', async () => {
    peach.isConfigured.mockReturnValue(true);
    peach.createPayment.mockResolvedValue({ id: 'BUS-CARD-1', code: '000.000.000', redirect: { url: 'https://pay' } });
    const { trip } = await seedTrip();
    await BookingService.initiateCardBooking(bookingArgs({ tripId: trip._id.toString(), seatNumber: '1' }));

    peach.getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '35', currency: 'ZAR' });

    const req = { body: { id: 'BUS-CARD-1' }, headers: {} } as unknown as Request;
    const res = mockRes();
    await CardController.webhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const booking = await Booking.findOne({ tripId: trip._id });
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    const sale = await BookingSale.findOne({ peachPaymentId: 'BUS-CARD-1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('still returns 200 and does not throw for a paymentId matching neither a ticket sale nor a booking sale', async () => {
    const req = { body: { id: 'GHOST-PAY' }, headers: {} } as unknown as Request;
    const res = mockRes();
    await expect(CardController.webhook(req, res)).resolves.not.toThrow();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
