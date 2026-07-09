import { Server, Socket } from 'socket.io';
import { Buyer } from '@models/buyer.model';
import { MessageService } from '@services/message.service';
import { HttpError } from '@utils/httpError.util';

export const channelRoom = (channelId: string): string => `channel:${channelId}`;

const CHANNEL_ID_REGEX = /^[0-9a-f]{24}$/i;

interface JoinAck {
  ok: boolean;
  error?: string;
  presence?: number;
}

/** Distinct buyers currently in a channel room — adapter-aware, so the count
 *  spans every gateway instance, not just this one. */
async function presenceCount(io: Server, channelId: string): Promise<number> {
  const sockets = await io.in(channelRoom(channelId)).fetchSockets();
  return new Set(sockets.map((s) => (s.data as any).buyerId)).size;
}

async function broadcastPresence(io: Server, channelId: string): Promise<void> {
  const count = await presenceCount(io, channelId);
  io.to(channelRoom(channelId)).emit('presence:update', { channelId, count });
}

export function registerChannelHandlers(io: Server, socket: Socket): void {
  socket.on(
    'channel:join',
    async (payload: { channelId?: string }, ack?: (a: JoinAck) => void) => {
      try {
        const channelId = String(payload?.channelId || '');
        if (!CHANNEL_ID_REGEX.test(channelId)) {
          throw new HttpError(400, 'channelId must be a channel id');
        }
        const buyer = await Buyer.findById(socket.data.buyerId);
        if (!buyer) throw new HttpError(401, 'Account not found');

        // The exact same authz as the REST message endpoints — membership,
        // ban, gating with on-demand ticket re-verify.
        await MessageService.requireChannelAccess(channelId, buyer);
        await socket.join(channelRoom(channelId));

        const count = await presenceCount(io, channelId);
        socket.to(channelRoom(channelId)).emit('presence:update', { channelId, count });
        ack?.({ ok: true, presence: count });
      } catch (err: any) {
        ack?.({ ok: false, error: err?.message || 'Failed to join channel' });
      }
    }
  );

  socket.on('channel:leave', async (payload: { channelId?: string }) => {
    try {
      const channelId = String(payload?.channelId || '');
      if (!CHANNEL_ID_REGEX.test(channelId)) return;
      // Only sockets actually in the room trigger a broadcast — a stranger
      // "leaving" a room they never joined must not fan out adapter queries.
      if (!socket.rooms.has(channelRoom(channelId))) return;
      await socket.leave(channelRoom(channelId));
      await broadcastPresence(io, channelId);
    } catch (err) {
      // No ack channel on leave; the global unhandledRejection handler
      // exits the process, so failures must be contained + loud here.
      console.error('[realtime] channel:leave failed', err);
    }
  });

  socket.on('typing', (payload: { channelId?: string }) => {
    const channelId = String(payload?.channelId || '');
    // Ephemeral + high-frequency: non-room senders are dropped without an
    // ack by design (not a silent data fallback — nothing is persisted).
    if (!socket.rooms.has(channelRoom(channelId))) return;
    socket.to(channelRoom(channelId)).volatile.emit('typing', {
      channelId,
      username: socket.data.username ?? null,
    });
  });

  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (!room.startsWith('channel:')) continue;
      const channelId = room.slice('channel:'.length);
      // Runs after the socket has actually left; failure is loud in logs.
      setImmediate(() => {
        broadcastPresence(io, channelId).catch((err) =>
          console.error('[realtime] presence update on disconnect failed', err)
        );
      });
    }
  });
}
