import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Route } from '@models/transport/route.model';
import { TripService } from '@services/transport/trip.service';
import { BookingService } from '@services/transport/booking.service';
import { SeatScheme } from '@interfaces/transport.interface';
import { BoardingScanResult } from '@interfaces/booking.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('POS flow: browse sellable trips → sell a seat → board it', async () => {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const route = await Route.create({ vendorId, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15, seatScheme: SeatScheme.SEQUENTIAL });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });

  const sellable = await TripService.listSellable({});
  expect(sellable.map((t) => t._id.toString())).toContain(trip._id.toString());

  const { booking } = await BookingService.sellSeat({
    tripId: trip._id.toString(), seatNumber: '1', passengerName: 'T', passengerPhone: '76707421',
    paymentMethod: PaymentMethod.CASH, soldBy: new mongoose.Types.ObjectId().toString(), soldByType: 'reseller-operator',
  });

  const scan = await BookingService.board({ qrCode: booking.qrCode, tripId: trip._id.toString(), scannedBy: new mongoose.Types.ObjectId().toString(), scannedByType: 'ResellerOperator' });
  expect(scan.result).toBe(BoardingScanResult.SUCCESS);
});
