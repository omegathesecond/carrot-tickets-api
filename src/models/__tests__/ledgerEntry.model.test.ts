import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { LedgerAccountType, FloatTag, accountKey } from '@interfaces/ledger.interface';

describe('LedgerEntry model', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('builds a stable account key for each account type', () => {
    expect(accountKey({ type: LedgerAccountType.FLOAT })).toBe('float');
    expect(accountKey({ type: LedgerAccountType.FEES })).toBe('fees');
    expect(accountKey({ type: LedgerAccountType.WALLET, ref: 'w1' })).toBe('wallet:w1');
    expect(accountKey({ type: LedgerAccountType.MERCHANT, ref: 'm1' })).toBe('merchant:m1');
  });

  it('throws when a ref-bearing account has no ref', () => {
    expect(() => accountKey({ type: LedgerAccountType.WALLET })).toThrow(
      'wallet account requires a ref',
    );
  });

  it('persists a posting with a signed integer delta', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const doc = await LedgerEntry.create({
      eventId,
      txnId: 'txn-1',
      accountType: LedgerAccountType.FLOAT,
      accountRef: null,
      delta: 5000,
      tag: FloatTag.KESHLESS,
      refType: 'topup',
      refId: 't1',
    });
    expect(doc.delta).toBe(5000);
    expect(doc.tag).toBe(FloatTag.KESHLESS);
  });

  it('rejects a non-integer delta', async () => {
    await expect(
      LedgerEntry.create({
        eventId: new mongoose.Types.ObjectId(),
        txnId: 'txn-2',
        accountType: LedgerAccountType.FEES,
        accountRef: null,
        delta: 10.5,
        refType: 'charge',
        refId: 'c1',
      }),
    ).rejects.toThrow(/integer minor units/);
  });
});
