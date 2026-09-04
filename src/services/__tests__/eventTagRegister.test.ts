import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { EventTagService, UNREGISTERED_TAG_MESSAGE } from '@services/eventTag.service';
import { WalletService } from '@services/wallet.service';
import { EventTag } from '@models/eventTag.model';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';

const eventId = new mongoose.Types.ObjectId().toString();
const otherEventId = new mongoose.Types.ObjectId().toString();

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('EventTagService.registerTag', () => {
  it('enrols a tag into the event and reports it as newly registered', async () => {
    const res = await EventTagService.registerTag({ eventId, bandUid: '04A2:2B:1C', registeredBy: 'op1' });

    expect(res.outcome).toBe('registered');
    // Stored canonical, not as typed — a reader that hands back `04:A2:2B:1C`
    // and one that hands back `04a22b1c` must find the same row.
    expect(res.bandUid).toBe('04a22b1c');
    expect(await EventTag.countDocuments({ eventId, bandUid: '04a22b1c', status: 'active' })).toBe(1);
  });

  it('is idempotent — a second tap of the same tag says "already", not an error', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    const again = await EventTagService.registerTag({ eventId, bandUid: '04A22B1C' });

    expect(again.outcome).toBe('already_registered');
    expect(await EventTag.countDocuments({ eventId })).toBe(1);
  });

  it('brings a retired tag back rather than leaving the desk stuck', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    await EventTagService.retireTag({ eventId, bandUid: '04a22b1c', reason: 'damaged' });

    const back = await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    expect(back.outcome).toBe('reactivated');

    const row = await EventTag.findOne({ eventId, bandUid: '04a22b1c' });
    expect(row?.status).toBe('active');
    expect(row?.retiredAt).toBeUndefined();
    expect(row?.retiredReason).toBeUndefined();
  });

  it('refuses a uid that is not a real NFC id', async () => {
    await expect(EventTagService.registerTag({ eventId, bandUid: 'not-hex!' })).rejects.toThrow(/hex/i);
    await expect(EventTagService.registerTag({ eventId, bandUid: '04a2' })).rejects.toThrow(/4 bytes/i);
  });

  it('registers the same physical tag independently for two events', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    const other = await EventTagService.registerTag({ eventId: otherEventId, bandUid: '04a22b1c' });

    // Tags are wiped and re-used between shows, so the same plastic being in two
    // registers is normal — NOT a conflict.
    expect(other.outcome).toBe('registered');
    expect(await EventTag.countDocuments({ bandUid: '04a22b1c' })).toBe(2);
  });

  it('lets only one of two simultaneous enrolments create the row', async () => {
    const results = await Promise.all([
      EventTagService.registerTag({ eventId, bandUid: '04a22b1c' }),
      EventTagService.registerTag({ eventId, bandUid: '04a22b1c' }),
    ]);

    expect(results.filter((r) => r.outcome === 'registered')).toHaveLength(1);
    expect(await EventTag.countDocuments({ eventId, bandUid: '04a22b1c' })).toBe(1);
  });
});

describe('EventTagService.registerTags (a pasted tag order)', () => {
  it('splits the batch into registered / already / rejected without losing a line', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });

    const res = await EventTagService.registerTags({
      eventId,
      bandUids: ['04a22b1c', '04a22b1d', '04a22b1d', 'garbage', '04a2'],
    });

    expect(res.alreadyRegistered).toEqual(['04a22b1c']);
    // The repeated line is de-duplicated, not counted twice.
    expect(res.registered).toEqual(['04a22b1d']);
    expect(res.rejected.map((r) => r.bandUid)).toEqual(['garbage', '04a2']);
    expect(res.rejected[0]?.reason).toMatch(/hex/i);
  });
});

describe('EventTagService.assertTagRegistered', () => {
  it('passes an enrolled tag', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    await expect(EventTagService.assertTagRegistered(eventId, '04a22b1c')).resolves.toBeUndefined();
  });

  it('refuses a tag that was never enrolled', async () => {
    await expect(EventTagService.assertTagRegistered(eventId, '04a22b1c'))
      .rejects.toThrow(UNREGISTERED_TAG_MESSAGE);
  });

  it('refuses a tag registered for a DIFFERENT event — the whole point of the register', async () => {
    await EventTagService.registerTag({ eventId: otherEventId, bandUid: '04a22b1c' });
    await expect(EventTagService.assertTagRegistered(eventId, '04a22b1c'))
      .rejects.toThrow(UNREGISTERED_TAG_MESSAGE);
  });

  it('refuses a retired tag', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    await EventTagService.retireTag({ eventId, bandUid: '04a22b1c', reason: 'stolen' });
    await expect(EventTagService.assertTagRegistered(eventId, '04a22b1c'))
      .rejects.toThrow(UNREGISTERED_TAG_MESSAGE);
  });
});

describe('EventTagService.retireTag', () => {
  it('stamps the reason and drops the tag out of the active count', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    const { tag, releasedWalletId } = await EventTagService.retireTag({ eventId, bandUid: '04A2:2B:1C', reason: 'snapped' });

    expect(tag.status).toBe('retired');
    expect(tag.retiredReason).toBe('snapped');
    expect(releasedWalletId).toBeNull(); // nothing was wearing it
    expect(await EventTagService.counts(eventId)).toEqual({ active: 0, retired: 1, total: 1 });
  });

  it('refuses to retire a tag that is not in this event’s register', async () => {
    await EventTagService.registerTag({ eventId: otherEventId, bandUid: '04a22b1c' });
    await expect(EventTagService.retireTag({ eventId, bandUid: '04a22b1c' }))
      .rejects.toThrow(/not in this event/i);
  });

  // Retiring only flipped the register row; a wallet already wearing the tag
  // kept topping up, spending and checking in, because the money paths look
  // the wallet up by uid and never consult the register again.
  it('releases the wallet wearing the tag so it stops working everywhere, balance intact', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), '04a22b1c', 'desk-1');
    await Wallet.updateOne({ _id: w._id }, { $set: { balance: 4000, cashFundedBalance: 4000 } });

    const { releasedWalletId } = await EventTagService.retireTag({ eventId, bandUid: '04A2:2B:1C', reason: 'stolen' });

    expect(releasedWalletId).toBe(String(w._id));
    // The cashier / merchant / gate lookup by uid now finds nothing.
    expect(await Wallet.findOne({ eventId, bandUid: '04a22b1c' })).toBeNull();
    expect(await WalletService.getWalletViewByBand('04a22b1c', eventId)).toBeNull();
    // The money stays on the wallet — a later reissue is possible.
    const fresh = await Wallet.findById(w._id);
    expect(fresh?.bandUid).toBeNull();
    expect(fresh?.balance).toBe(4000);
    // The binding trail says why.
    const row = await BandBinding.findOne({ walletId: w._id, bandUid: '04a22b1c' });
    expect(row?.unboundAt).toBeInstanceOf(Date);
    expect(row?.unboundReason).toBe('retired: stolen');
  });

  it('does not touch a wallet wearing the same uid at ANOTHER event', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });
    await EventTagService.registerTag({ eventId: otherEventId, bandUid: '04a22b1c' });
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId: otherEventId });
    await WalletService.bindBand(String(w._id), '04a22b1c');

    const { releasedWalletId } = await EventTagService.retireTag({ eventId, bandUid: '04a22b1c' });

    expect(releasedWalletId).toBeNull();
    expect((await Wallet.findById(w._id))?.bandUid).toBe('04a22b1c');
  });
});

describe('EventTagService.list', () => {
  it('returns only this event’s tags, newest first, with counts', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b01' });
    await EventTagService.registerTag({ eventId, bandUid: '04a22b02' });
    await EventTagService.registerTag({ eventId: otherEventId, bandUid: '04a22b03' });
    await EventTagService.retireTag({ eventId, bandUid: '04a22b01' });

    const res = await EventTagService.list(eventId);
    expect(res.tags.map((t) => t.bandUid).sort()).toEqual(['04a22b01', '04a22b02']);
    expect(res.counts).toEqual({ active: 1, retired: 1, total: 2 });
  });

  it('searches on the CANONICAL uid so a colon-formatted query still finds the tag', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b1c' });

    const res = await EventTagService.list(eventId, { q: '04:A2' });
    expect(res.tags.map((t) => t.bandUid)).toEqual(['04a22b1c']);
  });

  it('filters by status', async () => {
    await EventTagService.registerTag({ eventId, bandUid: '04a22b01' });
    await EventTagService.registerTag({ eventId, bandUid: '04a22b02' });
    await EventTagService.retireTag({ eventId, bandUid: '04a22b01' });

    const res = await EventTagService.list(eventId, { status: 'retired' });
    expect(res.tags.map((t) => t.bandUid)).toEqual(['04a22b01']);
    expect(res.total).toBe(1);
  });
});
