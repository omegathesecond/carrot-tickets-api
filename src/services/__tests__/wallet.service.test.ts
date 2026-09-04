import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { EventTagService } from '@services/eventTag.service';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';
import { enrolTags } from '@/__tests__/helpers/eventTags';

const eventId = new mongoose.Types.ObjectId().toString();
const ticketId = new mongoose.Types.ObjectId().toString();

describe('WalletService.ensureWalletForTicket', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('creates an active empty wallet for a new ticket', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId, eventId });
    expect(w.balance).toBe(0);
    expect(w.status).toBe('active');
    expect(String(w.ticketId)).toBe(ticketId);
    expect(String(w.eventId)).toBe(eventId);
  });

  it('is idempotent — the same ticket gets the SAME wallet', async () => {
    const a = await WalletService.ensureWalletForTicket({ ticketId, eventId });
    const b = await WalletService.ensureWalletForTicket({ ticketId, eventId });
    expect(String(a._id)).toBe(String(b._id));
    expect(await Wallet.countDocuments({ ticketId })).toBe(1);
  });

  it('never creates two wallets under concurrent calls for one ticket', async () => {
    await Promise.all([
      WalletService.ensureWalletForTicket({ ticketId, eventId }),
      WalletService.ensureWalletForTicket({ ticketId, eventId }),
      WalletService.ensureWalletForTicket({ ticketId, eventId }),
    ]);
    expect(await Wallet.countDocuments({ ticketId })).toBe(1);
  });

  it('gives DIFFERENT tickets different wallets', async () => {
    const a = await WalletService.ensureWalletForTicket({ ticketId, eventId });
    const b = await WalletService.ensureWalletForTicket({
      ticketId: new mongoose.Types.ObjectId().toString(), eventId,
    });
    expect(String(a._id)).not.toBe(String(b._id));
  });

  /**
   * The concurrency test above does NOT reach the E11000 catch, so it cannot
   * cover it: those calls routinely serialise, and MongoDB additionally retries
   * a findAndModify upsert server-side when the duplicate key comes from an
   * index on exactly the filter's fields — which is this case. It would pass
   * with the whole catch block deleted. These stub the duplicate-key error in
   * directly so the catch is the only thing under test.
   */
  describe('duplicate-key (E11000) handling', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    const dupKeyError = (keyPattern: Record<string, number>) =>
      Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern });

    it('lost the insert race — returns the winner wallet already in the DB', async () => {
      const winner = await WalletService.ensureWalletForTicket({ ticketId, eventId });
      jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw dupKeyError({ ticketId: 1 });
      });

      const w = await WalletService.ensureWalletForTicket({ ticketId, eventId });

      expect(String(w._id)).toBe(String(winner._id));
      expect(w.balance).toBe(0);
      expect(w.status).toBe('active');
      expect(await Wallet.countDocuments({ ticketId })).toBe(1);
    });

    it('rethrows E11000 when no winner exists — never invents a wallet', async () => {
      jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw dupKeyError({ ticketId: 1 });
      });

      await expect(WalletService.ensureWalletForTicket({ ticketId, eventId })).rejects.toThrow('E11000');
      expect(await Wallet.countDocuments({ ticketId })).toBe(0);
    });

    it('rethrows an E11000 raised by a DIFFERENT index even when a wallet matches', async () => {
      await WalletService.ensureWalletForTicket({ ticketId, eventId });
      jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw dupKeyError({ eventId: 1, bandUid: 1 }); // not the ticketId race
      });

      await expect(WalletService.ensureWalletForTicket({ ticketId, eventId })).rejects.toThrow('E11000');
    });
  });
});

describe('WalletService.bindBand', () => {
  beforeAll(async () => { await connectTestDb(); });
  // A tag only binds if the organizer enrolled it into this event's register,
  // so every uid these tests reach for has to be in the box first. clearTestDb
  // empties the register along with everything else, hence beforeEach.
  beforeEach(async () => {
    await enrolTags(eventId, 'aabbcc01', 'aabbcc02', 'aabbcc03', 'aabbcc09', 'aabbcc10', 'aabbcc0d', 'aabbcc0f');
  });
  // restoreAllMocks here too, so a stub can never leak past its test even if an
  // assertion throws mid-test.
  afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('binds a blank band to an unbound wallet and records the binding', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    const bound = await WalletService.bindBand(String(w._id), 'aabbcc01', 'gate-op-1');

    expect(bound.bandUid).toBe('aabbcc01');
    const audit = await BandBinding.find({ walletId: w._id });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.bandUid).toBe('aabbcc01');
    expect(audit[0]?.unboundAt).toBeUndefined();
    expect(audit[0]?.boundBy).toBe('gate-op-1');
  });

  it('refuses to bind a UID already live on another wallet in the same event', async () => {
    const a = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    const b = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(a._id), 'aabbcc01');

    await expect(WalletService.bindBand(String(b._id), 'aabbcc01')).rejects.toThrow(
      'band is already bound to another wallet at this event',
    );
    // The loser must not get a half-written audit row.
    expect(await BandBinding.countDocuments({ walletId: b._id })).toBe(0);
  });

  it('refuses to bind a second band to a wallet that already has one', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), 'aabbcc01');
    await expect(WalletService.bindBand(String(w._id), 'aabbcc02')).rejects.toThrow(
      'wallet already has a band bound',
    );
  });

  it('refuses to bind to a closed wallet', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await Wallet.updateOne({ _id: w._id }, { $set: { status: 'closed' } });
    await expect(WalletService.bindBand(String(w._id), 'aabbcc03')).rejects.toThrow(
      'wallet is not active',
    );
  });

  it('rolls the claim back when the audit write fails — no band left bound, no orphan row', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    // Stub the audit write to blow up exactly once, AFTER the claim has set bandUid.
    const spy = jest.spyOn(BandBinding, 'create').mockImplementationOnce(() => {
      throw new Error('audit write boom');
    });

    await expect(WalletService.bindBand(String(w._id), 'aabbcc09')).rejects.toThrow('audit write boom');

    // The compensating unbind must have reverted bandUid to null (re-read from DB),
    // so we are never left with a band bound but no forensic row.
    const fresh = await Wallet.findById(w._id);
    expect(fresh?.bandUid).toBeNull();
    expect(await BandBinding.countDocuments({ walletId: w._id })).toBe(0);

    spy.mockRestore();
  });

  it('rollback does NOT clobber a concurrent legal rebind (compensating write is a CAS)', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    // Simulate "someone rebound W between our claim and our rollback": the audit
    // write, on its one throwing call, FIRST moves W's band to a different uid
    // (as a legal unbind+rebind would), THEN throws so bindBand enters rollback.
    const spy = jest.spyOn(BandBinding, 'create').mockImplementationOnce(async () => {
      await Wallet.updateOne({ _id: w._id }, { $set: { bandUid: 'aabbcc0e' } });
      throw new Error('audit write boom');
    });

    await expect(WalletService.bindBand(String(w._id), 'aabbcc0d')).rejects.toThrow('audit write boom');

    // The rollback is CAS'd on {_id, bandUid:'aabbcc0d'}, so it matches nothing and
    // leaves the later legal rebind intact. With the OLD unconditional rollback
    // this would be null — the reissued band would be silently stranded.
    const fresh = await Wallet.findById(w._id);
    expect(fresh?.bandUid).toBe('aabbcc0e');

    spy.mockRestore();
  });

  it('propagates an E11000 from a NON-bandUid index unchanged (does not mislabel it)', async () => {
    // A duplicate-key error whose keyPattern is NOT bandUid must surface as-is,
    // never be mapped to "already bound to another wallet". Reject (not throw)
    // so the error flows through the claim's .catch where discrimination lives.
    //
    // A REAL wallet, not a made-up id: the register check reads the wallet for
    // its eventId before the claim runs, so a nonexistent id would now fail with
    // 'wallet not found' and never reach the stub this test exists to cover.
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    const dupOther = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { eventId: 1, buyerId: 1 },
    });
    jest.spyOn(Wallet, 'findOneAndUpdate').mockImplementationOnce(
      () => Promise.reject(dupOther) as never,
    );

    await expect(
      WalletService.bindBand(String(w._id), 'aabbcc10'),
    ).rejects.toThrow('E11000');
  });

  it('only one of many concurrent binds of the SAME uid wins', async () => {
    const wallets = await Promise.all([
      WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId }),
      WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId }),
      WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId }),
    ]);
    const results = await Promise.allSettled(
      wallets.map((w) => WalletService.bindBand(String(w._id), 'aabbcc0f')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Wallet.countDocuments({ eventId, bandUid: 'aabbcc0f' })).toBe(1);
  });

  // The choke point normalises: a reader that hands over `04:B2:C3:D4` and one
  // that hands over `04b2c3d4` are the SAME physical tag. Storing the raw form
  // meant every money path (which looks up the canonical form) found no wallet,
  // and the same plastic could then be bound to a second wallet.
  it('stores the CANONICAL uid, so a colon/upper-case reissue is still the same tag', async () => {
    await enrolTags(eventId, '04b2c3d4');
    const a = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    const b = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });

    const bound = await WalletService.bindBand(String(a._id), '04:B2:C3:D4');
    expect(bound.bandUid).toBe('04b2c3d4');
    expect((await BandBinding.findOne({ walletId: a._id }))?.bandUid).toBe('04b2c3d4');
    // The canonical lookup every money path uses now finds it.
    expect(await Wallet.countDocuments({ eventId, bandUid: '04b2c3d4' })).toBe(1);

    // …and the same tag cannot be bound to a second wallet under another spelling.
    await expect(WalletService.bindBand(String(b._id), '04b2c3d4')).rejects.toThrow(
      'band is already bound to another wallet at this event',
    );
  });

  it('refuses a uid that is not a real NFC id before touching the wallet', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await expect(WalletService.bindBand(String(w._id), 'not-hex!')).rejects.toThrow(/hex/i);
    await expect(WalletService.bindBand(String(w._id), '04a2')).rejects.toThrow(/4 bytes/i);
    expect((await Wallet.findById(w._id))?.bandUid).toBeNull();
    expect(await BandBinding.countDocuments({ walletId: w._id })).toBe(0);
  });
});

describe('WalletService.unbindBand (lost band reissue)', () => {
  beforeAll(async () => { await connectTestDb(); });
  beforeEach(async () => { await enrolTags(eventId, '105d0001', '0e000001', '0e050001'); });
  afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('unbinds a lost band, stamps the audit row, and PRESERVES the balance', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), '105d0001');
    // Simulate a topped-up wallet (SP3 does this properly via the ledger).
    await Wallet.updateOne({ _id: w._id }, { $set: { balance: 5000 } });

    const unbound = await WalletService.unbindBand(String(w._id), 'lost');

    expect(unbound.bandUid).toBeNull();
    expect(unbound.balance).toBe(5000); // the whole point of a server-side balance
    const audit = await BandBinding.findOne({ walletId: w._id, bandUid: '105d0001' });
    expect(audit?.unboundAt).toBeInstanceOf(Date);
    expect(audit?.unboundReason).toBe('lost');
  });

  it('lets a NEW band be bound after the lost one is released, balance intact', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), '105d0001');
    await Wallet.updateOne({ _id: w._id }, { $set: { balance: 5000 } });
    await WalletService.unbindBand(String(w._id), 'lost');

    const rebound = await WalletService.bindBand(String(w._id), '0e000001');
    expect(rebound.bandUid).toBe('0e000001');
    expect(rebound.balance).toBe(5000);
    // Full history retained: one closed binding, one live.
    expect(await BandBinding.countDocuments({ walletId: w._id })).toBe(2);
  });

  it('frees the released UID for reuse by a different wallet', async () => {
    const a = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    const b = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(a._id), '0e050001');
    await WalletService.unbindBand(String(a._id), 'reissued');

    const bound = await WalletService.bindBand(String(b._id), '0e050001');
    expect(bound.bandUid).toBe('0e050001');
  });

  it('refuses to unbind a wallet that has no band', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await expect(WalletService.unbindBand(String(w._id), 'lost')).rejects.toThrow(
      'wallet has no band bound',
    );
  });

  // Two open rows can exist after a compensated reissue (old tag restored
  // after the new one failed). Without a sort, "the first open row" is whichever
  // MongoDB returns first — closing the OLDER one leaves the LIVE binding open.
  it('stamps the MOST RECENT open binding, not an older one', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), '105d0001');
    const older = await BandBinding.create({
      walletId: w._id, eventId: w.eventId, bandUid: '0e000001', boundAt: new Date(Date.now() - 60_000),
    });

    await WalletService.unbindBand(String(w._id), 'lost');

    const live = await BandBinding.findOne({ walletId: w._id, bandUid: '105d0001' });
    expect(live?.unboundAt).toBeInstanceOf(Date);
    expect((await BandBinding.findById(older._id))?.unboundAt).toBeUndefined();
  });

  it('surfaces a failed audit stamp instead of silently leaving the row open', async () => {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), '105d0001');
    jest.spyOn(BandBinding, 'findOneAndUpdate').mockImplementationOnce(
      () => Promise.reject(new Error('audit stamp boom')) as never,
    );

    await expect(WalletService.unbindBand(String(w._id), 'lost')).rejects.toThrow(/audit stamp boom/);
  });
});

/**
 * Reissue = release the old tag, bind the replacement, balance untouched. The
 * failure modes matter more than the happy path: the old order (unbind THEN
 * bind, where bind is where registration and uniqueness are enforced) meant a
 * typo, an unregistered spare, or a retired tag returned an error AND left the
 * attendee with no working tag at all.
 */
describe('WalletService.reissueBand', () => {
  beforeAll(async () => { await connectTestDb(); });
  beforeEach(async () => { await enrolTags(eventId, '105d0001', '0e000001', '0e000002', '7a0e0001'); });
  afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
  afterAll(async () => { await disconnectTestDb(); });

  async function boundWallet(uid = '105d0001') {
    const w = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(w._id), uid, 'desk-1');
    await Wallet.updateOne({ _id: w._id }, { $set: { balance: 5000, cashFundedBalance: 5000 } });
    return w;
  }

  it('swaps a bound tag for a registered spare, balance intact, old row closed', async () => {
    const w = await boundWallet();

    const after = await WalletService.reissueBand(String(w._id), '0E:00:00:01', 'damaged', 'desk-2');

    expect(after.bandUid).toBe('0e000001');
    expect(after.balance).toBe(5000);
    const old = await BandBinding.findOne({ walletId: w._id, bandUid: '105d0001' });
    expect(old?.unboundAt).toBeInstanceOf(Date);
    expect(old?.unboundReason).toBe('damaged');
    const fresh = await BandBinding.findOne({ walletId: w._id, bandUid: '0e000001' });
    expect(fresh?.unboundAt).toBeUndefined();
    expect(fresh?.boundBy).toBe('desk-2');
  });

  it('works from an already-unbound wallet (tag reported lost earlier)', async () => {
    const w = await boundWallet();
    await WalletService.unbindBand(String(w._id), 'lost');

    const after = await WalletService.reissueBand(String(w._id), '0e000001', 'reissue', 'desk-2');
    expect(after.bandUid).toBe('0e000001');
    expect(after.balance).toBe(5000);
  });

  it('refuses an UNREGISTERED replacement and leaves the old tag working', async () => {
    const w = await boundWallet();

    await expect(WalletService.reissueBand(String(w._id), 'deadbeef', 'damaged')).rejects.toThrow(/not registered/i);

    expect((await Wallet.findById(w._id))?.bandUid).toBe('105d0001');
    const old = await BandBinding.findOne({ walletId: w._id, bandUid: '105d0001' });
    expect(old?.unboundAt).toBeUndefined();
    expect(await BandBinding.countDocuments({ walletId: w._id })).toBe(1);
  });

  it('refuses a RETIRED replacement and leaves the old tag working', async () => {
    const w = await boundWallet();
    await EventTagService.retireTag({ eventId, bandUid: '0e000002', reason: 'cracked' });

    await expect(WalletService.reissueBand(String(w._id), '0e000002', 'damaged')).rejects.toThrow(/not registered/i);
    expect((await Wallet.findById(w._id))?.bandUid).toBe('105d0001');
  });

  it('refuses a replacement already live on ANOTHER wallet and leaves the old tag working', async () => {
    const w = await boundWallet();
    const other = await WalletService.ensureWalletForTicket({ ticketId: new mongoose.Types.ObjectId().toString(), eventId });
    await WalletService.bindBand(String(other._id), '7a0e0001');

    await expect(WalletService.reissueBand(String(w._id), '7a0e0001', 'damaged')).rejects.toThrow(/already bound/i);
    expect((await Wallet.findById(w._id))?.bandUid).toBe('105d0001');
    expect((await Wallet.findById(other._id))?.bandUid).toBe('7a0e0001');
  });

  it('refuses a malformed replacement before touching anything', async () => {
    const w = await boundWallet();
    await expect(WalletService.reissueBand(String(w._id), 'not-hex!', 'damaged')).rejects.toThrow(/hex/i);
    expect((await Wallet.findById(w._id))?.bandUid).toBe('105d0001');
  });

  it('restores the old tag when the bind still fails after the release (race), then rethrows', async () => {
    const w = await boundWallet();
    // Everything pre-validated, then the claim loses a race: simulate the bind
    // of the NEW uid failing exactly once. The compensating re-bind of the OLD
    // uid goes through the real bindBand.
    const real = WalletService.bindBand.bind(WalletService);
    jest.spyOn(WalletService, 'bindBand').mockImplementationOnce(async () => {
      throw new Error('band is already bound to another wallet at this event');
    }).mockImplementation(real);

    await expect(WalletService.reissueBand(String(w._id), '0e000001', 'damaged', 'desk-2'))
      .rejects.toThrow(/already bound/);

    const fresh = await Wallet.findById(w._id);
    expect(fresh?.bandUid).toBe('105d0001');
    expect(fresh?.balance).toBe(5000);
    // The audit trail tells the truth: released for reissue, then restored.
    const rows = await BandBinding.find({ walletId: w._id, bandUid: '105d0001' }).sort({ boundAt: 1 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.unboundAt).toBeInstanceOf(Date);
    expect(rows[1]?.unboundAt).toBeUndefined();
    expect(await BandBinding.countDocuments({ walletId: w._id, bandUid: '0e000001' })).toBe(0);
  });
});
