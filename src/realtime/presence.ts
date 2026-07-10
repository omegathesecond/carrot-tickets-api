import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { BuyerPresence } from '@models/buyerPresence.model';

export const INSTANCE_ID = randomUUID();
const HEARTBEAT_MS = 45_000;

/** Presence writes are best-effort: a failure must never take down a socket
 *  or the process - offline-only push then just errs toward pushing. */
export function trackConnection(socket: Socket): void {
  const socketId = socket.id;
  BuyerPresence.create({
    buyerId: socket.data.buyerId,
    socketId,
    instanceId: INSTANCE_ID,
    lastSeenAt: new Date(),
  })
    .then(async () => {
      // Close the create/disconnect race: if the socket vanished while the
      // insert was in flight, the disconnect handler found nothing to delete
      // — clean up now so no phantom row survives.
      if (socket.disconnected) {
        await BuyerPresence.deleteOne({ socketId });
      }
    })
    .catch((err) => console.error('[presence] track failed', err));

  socket.on('disconnect', () => {
    BuyerPresence.deleteOne({ socketId }).catch((err) =>
      console.error('[presence] untrack failed', err)
    );
  });
}

/** Refresh only rows whose socket is still open on this instance — a blind
 *  instance-wide refresh would keep phantom rows alive forever. */
export function startPresenceHeartbeat(io: Server): NodeJS.Timeout {
  const timer = setInterval(() => {
    const liveIds = [...io.sockets.sockets.keys()];
    if (liveIds.length === 0) return;
    BuyerPresence.updateMany(
      { instanceId: INSTANCE_ID, socketId: { $in: liveIds } },
      { $set: { lastSeenAt: new Date() } }
    ).catch((err) => console.error('[presence] heartbeat failed', err));
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
