import { Emitter } from '@socket.io/mongo-emitter';
import type { Collection, Document } from 'mongodb';

let emitter: Emitter | null = null;

/**
 * Called once at API boot, after the adapter collection exists.
 *
 * @socket.io/mongo-emitter publishes with a fire-and-forget insertOne —
 * no await, no .catch(). Left raw, a transient Mongo error on that write
 * becomes an unhandled rejection, and this codebase's process-wide handler
 * exits on those. The Proxy intercepts insertOne so bus-write failures are
 * contained and LOUD instead of fatal: delivery is best-effort by design
 * (the message is already durable; clients recover via resync).
 */
export function initSocketEmitter(collection: Collection<Document>): void {
  const safeCollection = new Proxy(collection, {
    get(target, prop, receiver) {
      if (prop === 'insertOne') {
        return (...args: unknown[]) =>
          (target.insertOne as (...a: unknown[]) => Promise<unknown>)(...args).catch((err: unknown) => {
            console.error('[realtime-emit] bus write failed (clients recover via resync):', err);
            return { acknowledged: false };
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  emitter = new Emitter(safeCollection as any);
}

export function isSocketEmitterInitialized(): boolean {
  return emitter !== null;
}

/**
 * Broadcast to a channel room via the adapter bus. Callers treat this as
 * best-effort delivery ON TOP of an already-persisted write: the message is
 * durable in MongoDB and clients recover via REST resync (?after=<id>), so
 * a bus failure must never fail the request — but it must be LOUD in logs.
 */
export function emitToChannel(channelId: string, event: string, payload: unknown): void {
  if (!emitter) throw new Error('Socket emitter not initialized');
  emitter.to(`channel:${channelId}`).emit(event, payload);
}
