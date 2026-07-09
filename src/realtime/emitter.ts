import { Emitter } from '@socket.io/mongo-emitter';
import type { Collection, Document } from 'mongodb';

let emitter: Emitter | null = null;

/** Called once at API boot, after the adapter collection exists. */
export function initSocketEmitter(collection: Collection<Document>): void {
  emitter = new Emitter(collection as any);
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
