import { randomUUID } from 'crypto';
import { Socket } from 'socket.io';
import { BuyerPresence } from '@models/buyerPresence.model';

export const INSTANCE_ID = randomUUID();
const HEARTBEAT_MS = 45_000;

/** Presence writes are best-effort: a failure must never take down a socket
 *  or the process - offline-only push then just errs toward pushing. */
export function trackConnection(socket: Socket): void {
  BuyerPresence.create({
    buyerId: socket.data.buyerId,
    socketId: socket.id,
    instanceId: INSTANCE_ID,
    lastSeenAt: new Date(),
  }).catch((err) => console.error('[presence] track failed', err));

  socket.on('disconnect', () => {
    BuyerPresence.deleteOne({ socketId: socket.id }).catch((err) =>
      console.error('[presence] untrack failed', err)
    );
  });
}

/** Refresh every row this instance owns so they never go stale while alive. */
export function startPresenceHeartbeat(): NodeJS.Timeout {
  const timer = setInterval(() => {
    BuyerPresence.updateMany({ instanceId: INSTANCE_ID }, { $set: { lastSeenAt: new Date() } }).catch(
      (err) => console.error('[presence] heartbeat failed', err)
    );
  }, HEARTBEAT_MS);
  timer.unref();
  return timer;
}

/** Shutdown hygiene: drop this instance's rows so buyers go push-eligible fast. */
export async function clearInstancePresence(): Promise<void> {
  await BuyerPresence.deleteMany({ instanceId: INSTANCE_ID }).catch((err) =>
    console.error('[presence] shutdown cleanup failed', err)
  );
}
