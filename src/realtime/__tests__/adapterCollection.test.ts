import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import {
  SOCKET_COLLECTION,
  ensureAdapterCollection,
} from '../adapterCollection';

describe('ensureAdapterCollection', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it('creates a capped collection and is idempotent', async () => {
    const db = mongoose.connection.db!;
    const first = await ensureAdapterCollection(db as any);
    expect(first.collectionName).toBe(SOCKET_COLLECTION);
    expect(await first.isCapped()).toBe(true);

    // Second call must not throw (NamespaceExists is swallowed) and must
    // return the same collection.
    const second = await ensureAdapterCollection(db as any);
    expect(second.collectionName).toBe(SOCKET_COLLECTION);
  });
});
