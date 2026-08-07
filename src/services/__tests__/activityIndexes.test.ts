import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { Membership } from '@models/membership.model';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';

/** Mongoose exposes declared indexes as [keySpec, options] tuples. */
function hasIndex(model: any, key: Record<string, number>): boolean {
  return model.schema.indexes().some(([spec]: [Record<string, number>]) =>
    JSON.stringify(spec) === JSON.stringify(key)
  );
}

describe('activity feed recency indexes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('declares a newest-first index on every source the activity feed scans', () => {
    expect(hasIndex(Ticket, { status: 1, createdAt: -1 })).toBe(true);
    // Following tab: goingCandidates() filters live tickets by
    // customerPhone: { $in: [...] } sorted newest-first — see going.ts.
    expect(hasIndex(Ticket, { customerPhone: 1, status: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(Membership, { createdAt: -1 })).toBe(true);
    expect(hasIndex(Follow, { createdAt: -1 })).toBe(true);
    expect(hasIndex(EventReaction, { type: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(UpdateReaction, { type: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(Event, { status: 1, publishedAt: -1 })).toBe(true);
    // Join source: joinCandidates() scans Buyer by createdAt newest-first.
    expect(hasIndex(Buyer, { createdAt: -1 })).toBe(true);
  });
});
