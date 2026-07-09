import type { Collection, Db, Document } from 'mongodb';

export const SOCKET_COLLECTION = 'socketio_events';
export const SOCKET_COLLECTION_SIZE_BYTES = 1_048_576; // 1 MiB ring buffer

/**
 * The Socket.io mongo adapter fans events out across instances by opening a
 * CHANGE STREAM on this capped collection — which means MongoDB MUST be a
 * replica set (Atlas always is; standalone mongod is NOT enough, and the
 * adapter's failure mode is a silent 1s retry loop, so a wrong environment
 * looks like "fan-out never happens" with no error). Both the gateway
 * (adapter) and the API (emitter) call this at boot; error code 48
 * (NamespaceExists) means another instance won the create race, which is fine.
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
