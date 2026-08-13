import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { migrateMediaToArray } from '../../../scripts/migrate-update-media-array';

describe('migrateMediaToArray', () => {
  beforeAll(connectTestDb);
  // We insert straight through the native `Db` handle (not a Mongoose model,
  // so we can store the old single-object shape), which mongoose's own
  // connection.collections cache never sees — the shared clearTestDb helper
  // wouldn't touch it. Clear the raw collection directly instead.
  afterEach(async () => {
    await db().collection('updates').deleteMany({});
  });
  afterAll(disconnectTestDb);

  const oldShapeMedia = { rawKey: 'k', status: 'ready', image: { url: 'u', width: 0, height: 0 } };

  function db() {
    const handle = mongoose.connection.db;
    if (!handle) throw new Error('no db handle');
    return handle;
  }

  it('wraps a pre-migration single-object media into a length-1 array', async () => {
    const inserted = await db().collection('updates').insertOne({ media: oldShapeMedia });

    const res = await migrateMediaToArray(db());

    expect(res.migrated).toBe(1);
    const reloaded = await db().collection('updates').findOne({ _id: inserted.insertedId });
    expect(Array.isArray(reloaded?.['media'])).toBe(true);
    expect(reloaded?.['media']).toHaveLength(1);
    expect(reloaded?.['media'][0]).toEqual(oldShapeMedia);
  });

  it('is idempotent — a second run touches nothing and reports 0', async () => {
    await db().collection('updates').insertOne({ media: oldShapeMedia });

    await migrateMediaToArray(db());
    const second = await migrateMediaToArray(db());

    expect(second.migrated).toBe(0);
    const docs = await db().collection('updates').find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.['media']).toEqual([oldShapeMedia]);
  });

  it('leaves docs whose media is already an array untouched', async () => {
    const already = [oldShapeMedia];
    const inserted = await db().collection('updates').insertOne({ media: already });

    const res = await migrateMediaToArray(db());

    expect(res.migrated).toBe(0);
    const reloaded = await db().collection('updates').findOne({ _id: inserted.insertedId });
    expect(reloaded?.['media']).toEqual(already);
  });
});
