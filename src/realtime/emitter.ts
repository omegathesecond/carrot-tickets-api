import { Emitter } from '@socket.io/mongo-emitter';
import type { Collection, Document } from 'mongodb';
import { containBusWrites } from './containBusWrites';
import { channelRoom } from './rooms';

let emitter: Emitter | null = null;

/**
 * Called once at API boot, after the adapter collection exists.
 *
 * @socket.io/mongo-emitter publishes with a fire-and-forget insertOne —
 * no await, no .catch(). Left raw, a transient Mongo error on that write
 * becomes an unhandled rejection, and this codebase's process-wide handler
 * exits on those. containBusWrites() intercepts insertOne so bus-write
 * failures are contained and LOUD instead of fatal: delivery is best-effort
 * by design (the message is already durable; clients recover via resync).
 */
export function initSocketEmitter(collection: Collection<Document>): void {
  emitter = new Emitter(containBusWrites(collection) as any);
}

export function isSocketEmitterInitialized(): boolean {
  return emitter !== null;
}

/**
 * Broadcast to any room via the adapter bus. Callers treat this as
 * best-effort delivery ON TOP of an already-persisted write: the message is
 * durable in MongoDB and clients recover via REST resync (?after=<id>), so
 * a bus failure must never fail the request — but it must be LOUD in logs.
 */
export function emitToRoom(room: string, event: string, payload: unknown): void {
  if (!emitter) throw new Error('Socket emitter not initialized');
  emitter.to(room).emit(event, payload);
}

export function emitToChannel(channelId: string, event: string, payload: unknown): void {
  emitToRoom(channelRoom(channelId), event, payload);
}
