import { Server, Socket } from 'socket.io';
import { DmThreadService } from '@services/dmThread.service';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor } from '@utils/socialActor.util';
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
      const actor = socket.data.actor as SocialActor | undefined;
      if (!actor) throw new HttpError(401, 'Please sign in first');
      // Actor-aware: a vendor joins its brand↔buyer + brand↔brand rooms, a buyer
      // its own — requireDmAccess 404s a non-member (hides existence).
      await DmThreadService.requireDmAccess(threadId, actor);
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
