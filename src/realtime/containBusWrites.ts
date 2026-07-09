import { ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';

/**
 * Both bus writers (@socket.io/mongo-emitter's publish AND
 * @socket.io/mongo-adapter's fetchSockets/ack/server-side-emit paths) fire
 * insertOne without awaiting or catching — a transient Mongo error would
 * become an unhandled rejection and kill the process. This Proxy contains
 * those rejections at the source, loudly. The resolved fallback carries a
 * fresh insertedId because the adapter chains
 * `.then(result => result.insertedId.toString("hex"))` — a bare
 * `{ acknowledged: false }` would just move the crash.
 */
export function containBusWrites(collection: Collection<Document>): Collection<Document> {
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (prop === 'insertOne') {
        return (...args: unknown[]) =>
          (target.insertOne as (...a: unknown[]) => Promise<unknown>)(...args).catch((err: unknown) => {
            console.error('[realtime-bus] write failed (contained; clients recover via resync):', err);
            return { acknowledged: false, insertedId: new ObjectId() };
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
