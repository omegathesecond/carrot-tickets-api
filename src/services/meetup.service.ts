import { MeetupRequest, MeetupStatus } from '@models/meetupRequest.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { BlockService } from '@services/block.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { HttpError } from '@utils/httpError.util';
import { consumeToken } from '@utils/rateLimit.util';
import { HEX24 } from '@utils/controllerHelpers.util';

export interface MeetupRow {
  id: string;
  status: MeetupStatus;
  createdAt: Date;
  user: { id: string; name: string | null; username: string | null; avatarUrl: string | null };
}

const displayName = (b: IBuyer): string => b.username ?? b.name ?? 'Someone';

export class MeetupService {
  /** Create a pending request, or re-open a previously declined one. Idempotent
   *  while already pending/accepted (returns the existing row, no re-notify). */
  static async request(requester: IBuyer, targetId: string): Promise<{ id: string; status: MeetupStatus }> {
    const requesterId = String(requester._id);
    if (!HEX24.test(targetId)) throw new HttpError(400, 'Invalid user id');
    if (requesterId === targetId) throw new HttpError(400, 'You cannot meet up with yourself');

    const target = await Buyer.findById(targetId).select('username');
    if (!target || !target.username) throw new HttpError(404, 'User not found');
    if (await BlockService.isBlockedEitherWay(requesterId, targetId)) {
      throw new HttpError(403, 'You cannot send this request');
    }
    if (!consumeToken(`meetup:${requesterId}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
    }

    const existing = await MeetupRequest.findOne({ requesterId, targetId });
    if (existing && existing.status !== 'declined') {
      return { id: String(existing._id), status: existing.status };
    }
    let row = existing;
    if (row) {
      row.status = 'pending';
      row.respondedAt = undefined;
      await row.save();
    } else {
      try {
        row = await MeetupRequest.create({ requesterId, targetId });
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        // Lost a create race to a concurrent request for the same pair — the
        // winner already notified, so just return its row, no re-notify.
        const winner = await MeetupRequest.findOne({ requesterId, targetId });
        if (!winner) throw err; // shouldn't happen, but don't swallow silently
        return { id: String(winner._id), status: winner.status };
      }
    }

    NotificationDispatcher.dispatchAsync(
      [targetId],
      'meetup_request',
      displayName(requester),
      'wants to meet up',
      { buyerId: requesterId, username: requester.username ?? null, meetupId: String(row._id) },
      requesterId
    );
    return { id: String(row._id), status: 'pending' };
  }

  /** Load a request and assert the acting buyer is the expected party. */
  private static async loadFor(id: string, buyerId: string, role: 'requester' | 'target') {
    if (!HEX24.test(id)) throw new HttpError(400, 'Invalid request id');
    const row = await MeetupRequest.findById(id);
    if (!row) throw new HttpError(404, 'Request not found');
    const owner = role === 'target' ? String(row.targetId) : String(row.requesterId);
    if (owner !== buyerId) throw new HttpError(403, 'Not your request');
    return row;
  }

  static async accept(target: IBuyer, id: string): Promise<void> {
    const row = await MeetupService.loadFor(id, String(target._id), 'target');
    if (row.status === 'accepted') return; // idempotent
    if (row.status !== 'pending') throw new HttpError(409, 'This request is no longer pending');
    // Atomic pending->accepted transition: if two accept() calls race, only
    // the one that actually flips the row proceeds to notify.
    const updated = await MeetupRequest.findOneAndUpdate(
      { _id: row._id, status: 'pending' },
      { $set: { status: 'accepted', respondedAt: new Date() } },
      { new: true }
    );
    if (!updated) return;
    NotificationDispatcher.dispatchAsync(
      [String(updated.requesterId)],
      'meetup_accepted',
      displayName(target),
      'accepted your meetup',
      { buyerId: String(target._id), username: target.username ?? null, meetupId: id },
      String(target._id)
    );
  }

  static async decline(target: IBuyer, id: string): Promise<void> {
    const row = await MeetupService.loadFor(id, String(target._id), 'target');
    if (row.status === 'declined') return; // idempotent, silent
    if (row.status !== 'pending') throw new HttpError(409, 'This request is no longer pending');
    // Atomic pending->declined transition (same race protection as accept()).
    // No notification either way (spec: silent).
    await MeetupRequest.findOneAndUpdate(
      { _id: row._id, status: 'pending' },
      { $set: { status: 'declined', respondedAt: new Date() } }
    );
  }

  static async cancel(requester: IBuyer, id: string): Promise<void> {
    const row = await MeetupService.loadFor(id, String(requester._id), 'requester');
    if (row.status !== 'pending') throw new HttpError(409, 'Only a pending request can be cancelled');
    await MeetupRequest.deleteOne({ _id: row._id });
  }

  static async listIncoming(target: IBuyer, status: MeetupStatus): Promise<MeetupRow[]> {
    const rows = await MeetupRequest.find({ targetId: target._id, status }).sort({ _id: -1 }).limit(50);
    if (rows.length === 0) return [];
    const requesterIds = rows.map((r) => String(r.requesterId));
    const buyers = await Buyer.find({ _id: { $in: requesterIds } }).select('name username avatarUrl');
    const byId = new Map(buyers.map((b: any) => [String(b._id), b]));
    const out: MeetupRow[] = [];
    for (const r of rows) {
      const b: any = byId.get(String(r.requesterId));
      if (!b) continue; // requester account gone — drop silently, same as follow lists
      out.push({
        id: String(r._id),
        status: r.status,
        createdAt: r.createdAt,
        user: { id: String(b._id), name: b.name ?? null, username: b.username ?? null, avatarUrl: b.avatarUrl ?? null },
      });
    }
    return out;
  }

  static async outgoingStatusMap(
    requesterId: string,
    targetIds: string[]
  ): Promise<Map<string, { id: string; status: MeetupStatus }>> {
    const map = new Map<string, { id: string; status: MeetupStatus }>();
    if (targetIds.length === 0) return map;
    const rows = await MeetupRequest.find({ requesterId, targetId: { $in: targetIds } }).select('targetId status');
    for (const r of rows) map.set(String(r.targetId), { id: String(r._id), status: r.status });
    return map;
  }
}
