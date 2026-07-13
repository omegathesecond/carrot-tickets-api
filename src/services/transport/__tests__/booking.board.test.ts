import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BookingService } from '@services/transport/booking.service';
import { TripService } from '@services/transport/trip.service';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { Booking } from '@models/transport/booking.model';
import { BoardingScan } from '@models/transport/boardingScan.model';
import { SeatScheme } from '@interfaces/transport.interface';
import { BookingStatus, BoardingScanResult } from '@interfaces/booking.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function sellOne() {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'R', originCity: 'A', destinationCity: 'B', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 4, seatScheme: SeatScheme.SEQUENTIAL });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  const { booking } = await BookingService.sellSeat({
    tripId: trip._id.toString(), seatNumber: '1', passengerName: 'T', passengerPhone: '76707421',
    paymentMethod: PaymentMethod.CASH, soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator',
  });
  return { trip, booking, scannedBy: new mongoose.Types.ObjectId().toString() };
}

describe('BookingService.board', () => {
  it('SUCCESS on first scan, marks BOARDED, writes a scan', async () => {
    const { trip, booking, scannedBy } = await sellOne();
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.SUCCESS);
    const fresh = await Booking.findById(booking._id);
    expect(fresh!.status).toBe(BookingStatus.BOARDED);
    expect(await BoardingScan.countDocuments({ bookingId: booking._id })).toBe(1);
  });

  it('ALREADY_BOARDED on the second scan', async () => {
    const { trip, booking, scannedBy } = await sellOne();
    await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.ALREADY_BOARDED);
  });

  it('WRONG_TRIP when the QR belongs to a different trip', async () => {
    const { booking, scannedBy } = await sellOne();
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: new mongoose.Types.ObjectId().toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.WRONG_TRIP);
  });

  it('INVALID for an unknown QR', async () => {
    const { trip, scannedBy } = await sellOne();
    const r = await BookingService.board({ qrCode: 'ZZZZ9999', tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.INVALID);
  });

  it('CANCELLED_BOOKING for a cancelled booking', async () => {
    const { trip, booking, scannedBy } = await sellOne();
    await Booking.updateOne({ _id: booking._id }, { $set: { status: BookingStatus.CANCELLED } });
    const r = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy, scannedByType: 'ResellerOperator' });
    expect(r.result).toBe(BoardingScanResult.CANCELLED_BOOKING);
  });
});
