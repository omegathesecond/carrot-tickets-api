import { Server, Socket } from 'socket.io';
import { Buyer } from '@models/buyer.model';
import { DmThreadService } from '@services/dmThread.service';
import { HttpError } from '@utils/httpError.util';
import { dmRoom } from './rooms';

interface DmJoinAck {
  ok: boolean;
  error?: string;
}

/**
 * DM rooms on the gateway. No presence counts for DMs (v1) — just room
 * membership for live message delivery plus ephemeral typing.
 */
export function registerDmHandlers(io: Server, socket: Socket): void {
  void io;

  socket.on('dm:join', async (payload: { threadId?: string }, ack?: (a: DmJoinAck) => void) => {
    try {
      const threadId = String(payload?.threadId || '');
      const buyer = await Buyer.findById(socket.data.buyerId);
      if (!buyer) throw new HttpError(401, 'Account not found');
      await DmThreadService.requireDmAccess(threadId, { type: 'buyer', id: String(buyer._id) }); // 404s hide existence
      await socket.join(dmRoom(threadId));
      ack?.({ ok: true });
    } catch (err: any) {
      const message = err instanceof HttpError ? err.message : 'Failed to join conversation';
      ack?.({ ok: false, error: message });
    }
  });

  socket.on('dm:leave', async (payload: { threadId?: string }) => {
    try {
      const threadId = String(payload?.threadId || '');
      if (!socket.rooms.has(dmRoom(threadId))) return;
      await socket.leave(dmRoom(threadId));
    } catch (err) {
      console.error('[realtime] dm:leave failed', err);
    }
  });

  socket.on('dm:typing', (payload: { threadId?: string }) => {
    const threadId = String(payload?.threadId || '');
    // Ephemeral + high-frequency: non-room senders dropped without ack.
    if (!socket.rooms.has(dmRoom(threadId))) return;
    socket.to(dmRoom(threadId)).volatile.emit('dm:typing', {
      threadId,
      username: socket.data.username ?? null,
    });
  });
}
