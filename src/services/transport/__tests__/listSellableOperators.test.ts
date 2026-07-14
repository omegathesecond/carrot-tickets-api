import { connectTestDb, disconnectTestDb, clearTestDb } from '../../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Route } from '@models/transport/route.model';
import { VehicleType } from '@models/transport/vehicleType.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { SeatScheme } from '@interfaces/transport.interface';
import { TripService } from '@services/transport/trip.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

/**
 * Creates a sellable (SCHEDULED, future-departing) trip for a vendor, mirroring
 * the route -> vehicleType -> trip setup used by pos.smoke.test.ts.
 */
async function createSellableTripFor(vendorId: string) {
  const route = await Route.create({ vendorId, name: 'MZ→MB', originCity: 'Manzini', destinationCity: 'Mbabane', farePerSeat: 35 });
  const vt = await VehicleType.create({ vendorId, name: 'Kombi', totalSeats: 15, seatScheme: SeatScheme.SEQUENTIAL });
  return TripService.createTrip({ vendorId, routeId: route._id.toString(), vehicleTypeId: vt._id.toString(), departureTime: new Date(Date.now() + 86400000) });
}

it('lists only active transport/both vendors that have a sellable trip', async () => {
  const busWithTrip = await Vendor.create({ businessName: 'Kombi Co', phoneNumber: '+268760000021', password: 'secret1', operatorType: OperatorType.TRANSPORT });
  const busNoTrip = await Vendor.create({ businessName: 'Idle Bus', phoneNumber: '+268760000022', password: 'secret1', operatorType: OperatorType.TRANSPORT });
  const eventsVendor = await Vendor.create({ businessName: 'Event Co', email: 'e@e.co', password: 'secret1', operatorType: OperatorType.EVENTS });
  await createSellableTripFor(busWithTrip._id.toString());
  await createSellableTripFor(eventsVendor._id.toString()); // events vendor: excluded even with a trip

  const ops = await TripService.listSellableOperators();
  const ids = ops.map((o) => o.id);
  expect(ids).toContain(busWithTrip._id.toString());
  expect(ids).not.toContain(busNoTrip._id.toString()); // no sellable trip
  expect(ids).not.toContain(eventsVendor._id.toString()); // not a bus operator
});
