// GET /api/public/payment-methods?eventId=… — fee display for absorbing events.
//
// The invariant: the amount the checkout DISPLAYS must equal the amount the
// buyer is CHARGED. On an event whose organizer covers the booking fee, the
// purchase path charges face, so this endpoint must report a zero fee for
// every method — otherwise the modal shows a surcharge that never lands.

import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/db';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

beforeEach(async () => {
  await PaymentConfigService.update({
    mtnMomoEnabled: true, momoServiceFee: 5, cardServiceFee: 10, deltapayServiceFee: 5,
  });
});

async function seedEvent(organizerAbsorbsServiceFee: boolean) {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Fee Display Test',
    venue: 'Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 7200000),
    status: EventStatus.PUBLISHED,
    organizerAbsorbsServiceFee,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return event;
}

describe('GET /api/public/payment-methods', () => {
  it('reports zero fees for an event whose organizer absorbs them', async () => {
    const event = await seedEvent(true);
    const res = await request(app).get(`/api/public/payment-methods?eventId=${event._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.serviceFees).toEqual({
      keshless_wallet: 0, mtn_momo: 0, peach_card: 0, deltapay: 0, yoco: 0,
    });
  });

  it('reports the configured fees for an ordinary event', async () => {
    const event = await seedEvent(false);
    const res = await request(app).get(`/api/public/payment-methods?eventId=${event._id}`);
    expect(res.body.data.serviceFees.mtn_momo).toBe(5);
    expect(res.body.data.serviceFees.peach_card).toBe(10);
  });

  it('reports the configured fees when no event is named', async () => {
    const res = await request(app).get('/api/public/payment-methods');
    expect(res.body.data.serviceFees.mtn_momo).toBe(5);
  });

  it('reports the configured fees for an unknown event id rather than hiding them', async () => {
    const res = await request(app).get(`/api/public/payment-methods?eventId=${new mongoose.Types.ObjectId()}`);
    expect(res.body.data.serviceFees.mtn_momo).toBe(5);
  });
});
