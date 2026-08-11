import mongoose from 'mongoose';
import { Event } from '@models/event.model';

export interface AllocationBlock {
  eventId: string;
  eventName: string;
  tierName: string;
  price: number;
  quantity: number;
  sold: number;
  remaining: number;
  collected: number;
}

/**
 * A reseller's read-only view of the ticket blocks they pre-bought and resell.
 * Strictly scoped by resellerId — a reseller only ever sees tiers tagged to
 * them, never the organizer's other tiers or another reseller's blocks.
 *
 * Every allocation sale is at face (the fee is waived), so a block's `collected`
 * is exactly `sold × price` — no sale aggregation needed, and it stays precise
 * per-tier even when a reseller holds several blocks.
 */
export class AllocationService {
  static async getForReseller(resellerId: string): Promise<{ blocks: AllocationBlock[] }> {
    const rid = new mongoose.Types.ObjectId(resellerId);
    const events = await Event.find({ 'ticketTypes.resellerId': rid })
      .select('name ticketTypes')
      .lean();

    const blocks: AllocationBlock[] = [];
    for (const ev of events) {
      for (const tt of (ev.ticketTypes || [])) {
        if (tt.isAllocation && tt.resellerId && String(tt.resellerId) === resellerId) {
          const sold = tt.sold || 0;
          blocks.push({
            eventId: String(ev._id),
            eventName: ev.name,
            tierName: tt.name,
            price: tt.price,
            quantity: tt.quantity,
            sold,
            remaining: Math.max(0, tt.quantity - sold),
            collected: sold * tt.price,
          });
        }
      }
    }
    return { blocks };
  }
}
