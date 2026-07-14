import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../../__tests__/helpers/mongo';
import { BoardingScan } from '@models/transport/boardingScan.model';
import { BoardingScanResult } from '@interfaces/booking.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('persists a boarding scan with a result', async () => {
  const scan = await BoardingScan.create({
    tripId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    scannedBy: new mongoose.Types.ObjectId(),
    scannedByType: 'ResellerOperator',
    result: BoardingScanResult.SUCCESS,
  });
  expect(scan.result).toBe(BoardingScanResult.SUCCESS);
  expect(scan.scannedAt).toBeInstanceOf(Date);
});
