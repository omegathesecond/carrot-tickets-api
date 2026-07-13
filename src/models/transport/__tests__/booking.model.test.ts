import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { Booking } from '@models/transport/booking.model';
import { BookingStatus } from '@interfaces/booking.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('Booking model', () => {
  it('auto-generates a unique bookingRef + qrCode and defaults status PENDING', async () => {
    const b = await Booking.create({
      tripId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      passengerName: 'Thabo M.',
      passengerPhone: '+26876111111',
      seatNumber: 'A1',
      fareAmount: 35,
      platformFee: 0,
      totalAmount: 35,
    });
    expect(b.status).toBe(BookingStatus.PENDING);
    expect(b.bookingRef).toMatch(/^[A-Z0-9]{8}$/);
    expect(b.qrCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(b.bookingRef).not.toEqual(b.qrCode);
  });
});
