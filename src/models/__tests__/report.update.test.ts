import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Report } from '@models/report.model';
import mongoose from 'mongoose';

describe('Report supports update targets', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a report against an update', async () => {
    const r = await Report.create({
      reporterId: new mongoose.Types.ObjectId(),
      targetType: 'update',
      targetUpdateId: new mongoose.Types.ObjectId(),
      reason: 'spam',
    });
    expect(r.targetType).toBe('update');
  });

  it('still rejects a report with no target id', async () => {
    await expect(
      Report.create({ reporterId: new mongoose.Types.ObjectId(), targetType: 'update', reason: 'x' })
    ).rejects.toThrow();
  });
});
