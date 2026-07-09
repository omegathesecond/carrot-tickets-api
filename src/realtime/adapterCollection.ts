import type { Collection, Db, Document } from 'mongodb';

export const SOCKET_COLLECTION = 'socketio_events';
export const SOCKET_COLLECTION_SIZE_BYTES = 1_048_576; // 1 MiB ring buffer

/**
 * The Socket.io mongo adapter fans events out across instances by tailing a
 * capped collection — a fixed-size ring buffer MongoDB serves with a tailable
 * cursor (no replica set / change streams needed). Both the gateway (adapter)
 * and the API (emitter) call this at boot; error code 48 (NamespaceExists)
 * means another instance won the create race, which is fine.
 */
export async function ensureAdapterCollection(db: Db): Promise<Collection<Document>> {
  try {
    await db.createCollection(SOCKET_COLLECTION, {
      capped: true,
      size: SOCKET_COLLECTION_SIZE_BYTES,
    });
  } catch (err: any) {
    if (err?.code !== 48) throw err; // 48 = NamespaceExists
  }
  return db.collection(SOCKET_COLLECTION);
}
