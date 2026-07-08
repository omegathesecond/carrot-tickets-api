import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { WristbandDesign } from '@models/wristbandDesign.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('persists a design with template snapshot and elements', async () => {
  const doc = await WristbandDesign.create({
    eventId: new mongoose.Types.ObjectId(),
    name: 'VIP Gold',
    sheetTemplate: { key: 'a4-10up-25mm', pageWidthMm: 210, pageHeightMm: 297, bandWidthMm: 254, bandHeightMm: 25.4, marginTopMm: 12, marginLeftMm: 8, gapYMm: 2, bandsPerSheet: 10, tabZoneMm: 20 },
    designJson: { background: '#ff6600', elements: [{ id: 'e1', type: 'text', text: 'VIP' }] },
  });
  expect(doc.name).toBe('VIP Gold');
  expect((doc.designJson as any).elements).toHaveLength(1);
  expect((doc.sheetTemplate as any).bandsPerSheet).toBe(10);
});

it('requires eventId and name', async () => {
  await expect(WristbandDesign.create({ designJson: {} })).rejects.toThrow();
});
