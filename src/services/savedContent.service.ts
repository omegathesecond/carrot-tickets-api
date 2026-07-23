import { UpdateReaction } from '@models/updateReaction.model';
import { EventReaction } from '@models/eventReaction.model';
import { Update } from '@models/update.model';

export class SavedContentService {
  /** Event ids the buyer saved (= liked), newest-first. */
  static async savedEventIds(buyerId: string): Promise<string[]> {
    const rows = await EventReaction.find({ actorType: 'buyer', buyerId, type: 'like' }).sort({ createdAt: -1 }).select('eventId');
    return rows.map((r) => String(r.eventId));
  }
  /** Update ids the buyer saved, newest-first. */
  static async savedUpdateIds(buyerId: string): Promise<string[]> {
    const rows = await UpdateReaction.find({ actorType: 'buyer', buyerId, type: 'save' }).sort({ createdAt: -1 }).select('updateId');
    return rows.map((r) => String(r.updateId));
  }
  /** Visible saved updates (active + media ready) in saved order. */
  static async listSavedUpdates(buyerId: string): Promise<any[]> {
    const ids = await SavedContentService.savedUpdateIds(buyerId);
    if (ids.length === 0) return [];
    const docs = await Update.find({ _id: { $in: ids }, status: 'active', 'media.status': 'ready' });
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return ids.map((id) => byId.get(id)).filter(Boolean) as any[];
  }
}
