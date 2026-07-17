import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { LedgerService } from '@services/ledger.service';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

const eventId = new mongoose.Types.ObjectId().toString();

describe('LedgerService.post', () => {
  beforeAll(connectLedgerTestDb, 60000); // replica set: post() commits in a transaction
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('writes a balanced top-up transaction and returns a txnId', async () => {
    const txnId = await LedgerService.post({
      eventId,
      refType: 'topup',
      refId: 't1',
      postings: [
        { account: { type: LedgerAccountType.FLOAT }, delta: 5000, tag: FloatTag.KESHLESS },
        { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -5000 },
      ],
    });

    expect(typeof txnId).toBe('string');
    const rows = await LedgerEntry.find({ txnId });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
  });

  it('writes a 3-leg tap-to-pay transaction (wallet -> merchant + fees)', async () => {
    const txnId = await LedgerService.post({
      eventId,
      refType: 'charge',
      refId: 'c1',
      postings: [
        { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: 6000 },
        { account: { type: LedgerAccountType.MERCHANT, ref: 'm1' }, delta: -5400 },
        { account: { type: LedgerAccountType.FEES }, delta: -600 },
      ],
    });
    const rows = await LedgerEntry.find({ txnId });
    expect(rows).toHaveLength(3);
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
  });

  it('rejects an unbalanced transaction and writes nothing', async () => {
    await expect(
      LedgerService.post({
        eventId,
        refType: 'topup',
        refId: 't2',
        postings: [
          { account: { type: LedgerAccountType.FLOAT }, delta: 5000 },
          { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -4000 },
        ],
      }),
    ).rejects.toThrow('unbalanced transaction: postings sum to 1000, expected 0');

    expect(await LedgerEntry.countDocuments({})).toBe(0);
  });

  it('rejects a single-leg transaction', async () => {
    await expect(
      LedgerService.post({
        eventId,
        refType: 'topup',
        refId: 't3',
        postings: [{ account: { type: LedgerAccountType.FLOAT }, delta: 0 }],
      }),
    ).rejects.toThrow('a transaction needs at least 2 postings');
  });

  it('rejects a non-integer delta', async () => {
    await expect(
      LedgerService.post({
        eventId,
        refType: 'topup',
        refId: 't4',
        postings: [
          { account: { type: LedgerAccountType.FLOAT }, delta: 50.5 },
          { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -50.5 },
        ],
      }),
    ).rejects.toThrow('delta must be integer minor units (ZAR cents), got 50.5');
  });

  it('rejects a wallet posting with no ref', async () => {
    await expect(
      LedgerService.post({
        eventId,
        refType: 'topup',
        refId: 't5',
        postings: [
          { account: { type: LedgerAccountType.FLOAT }, delta: 100 },
          { account: { type: LedgerAccountType.WALLET }, delta: -100 },
        ],
      }),
    ).rejects.toThrow('wallet account requires a ref');
  });

  it('rejects a ref on an account type that does not take one', async () => {
    await expect(
      LedgerService.post({
        eventId,
        refType: 'topup',
        refId: 't7',
        postings: [
          { account: { type: LedgerAccountType.FLOAT, ref: 'nope' }, delta: 100 },
          { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -100 },
        ],
      }),
    ).rejects.toThrow('float account does not take a ref');

    expect(await LedgerEntry.countDocuments({})).toBe(0);
  });

  it('rejects a caller session that is not in a transaction, and writes nothing', async () => {
    const session = await mongoose.startSession(); // deliberately no withTransaction
    try {
      await expect(
        LedgerService.post({
          eventId,
          refType: 'topup',
          refId: 't8',
          session,
          postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: 100 },
            { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -100 },
          ],
        }),
      ).rejects.toThrow('post() requires the caller session to be in a transaction');
    } finally {
      await session.endSession();
    }

    expect(await LedgerEntry.countDocuments({})).toBe(0);
  });

  it('is atomic in its OWN transaction: a mid-insert failure rolls back the legs already written', async () => {
    // Forces a real server-side failure on the SECOND leg of a 2-leg post that
    // has no caller session, so post() owns the transaction. A temporary unique
    // index makes leg 2 collide with a pre-seeded blocker; insertMany is
    // ordered, so leg 1 (float) is inserted before leg 2 raises E11000. If the
    // self-owned transaction were absent, leg 1 would survive the abort.
    await LedgerEntry.collection.createIndex(
      { refId: 1, accountType: 1, accountRef: 1 },
      { unique: true, name: 'test_unique_leg' },
    );
    try {
      await LedgerEntry.create({
        eventId: new mongoose.Types.ObjectId(eventId),
        txnId: 'blocker',
        accountType: LedgerAccountType.WALLET,
        accountRef: 'w1',
        delta: 1,
        refType: 'topup',
        refId: 't9',
      });

      await expect(
        LedgerService.post({
          eventId,
          refType: 'topup',
          refId: 't9',
          postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: 100 },
            { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -100 },
          ],
        }),
      ).rejects.toThrow(/E11000|duplicate key/);

      // The float leg must NOT have survived: only the blocker remains.
      expect(await LedgerEntry.countDocuments({ accountType: LedgerAccountType.FLOAT })).toBe(0);
      expect(await LedgerEntry.countDocuments({})).toBe(1);
    } finally {
      await LedgerEntry.collection.dropIndex('test_unique_leg');
    }
  });

  it('is atomic: no entries survive if the enclosing transaction aborts', async () => {
    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await LedgerService.post({
          eventId,
          refType: 'topup',
          refId: 't6',
          session,
          postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: 100 },
            { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -100 },
          ],
        });
        throw new Error('caller blew up');
      }),
    ).rejects.toThrow('caller blew up');
    await session.endSession();

    expect(await LedgerEntry.countDocuments({})).toBe(0);
  });
});
