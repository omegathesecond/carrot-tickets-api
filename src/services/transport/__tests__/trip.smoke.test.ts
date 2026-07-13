import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { VehicleTypeService } from '@services/transport/vehicleType.service';
import { RouteService } from '@services/transport/route.service';
import { TripService } from '@services/transport/trip.service';
import { SeatScheme } from '@interfaces/transport.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('vendor can set up fleet → route → trip and read availability end to end', async () => {
  const vendorId = new mongoose.Types.ObjectId().toString();
  const vt = await VehicleTypeService.create({ vendorId, name: 'Kombi', totalSeats: 15, seatScheme: SeatScheme.SEQUENTIAL });
  const route = await RouteService.create({ vendorId, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
  const trip = await TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
  const sellable = await TripService.listSellable({ vendorId });
  expect(sellable.map((t) => t._id.toString())).toContain(trip._id.toString());
  const { availableSeats } = await TripService.getWithAvailability(vendorId, trip._id.toString());
  expect(availableSeats).toBe(15);
});
