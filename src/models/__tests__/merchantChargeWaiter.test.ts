import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { MerchantCharge } from '@models/merchantCharge.model';

const id = () => new mongoose.Types.ObjectId();

describe('MerchantCharge — waiter-settled tables', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const M = id();
  const E = id();
  const W = id();
  const WAITER = id();
  const OP = id();

  it('accepts a charge raised by a waiter with no till operator', async () => {
    const charge = await MerchantCharge.create({
      merchantId: M, eventId: E, walletId: W, bandUid: '04a22b1c',
      amount: 3000, fee: 0, netAmount: 3000, clientTxnId: 't1', status: 'completed',
      waiterId: WAITER, staffName: 'Thabo',
    });
    expect(charge.merchantOperatorId).toBeUndefined();
    expect(String(charge.waiterId)).toBe(String(WAITER));
  });

  it('still names a human either way', async () => {
    // staffName is what every existing display reads. A charge that names nobody
    // is a charge no one can be asked about.
    await expect(MerchantCharge.create({
      merchantId: M, eventId: E, walletId: W, bandUid: '04a22b1c',
      amount: 3000, fee: 0, netAmount: 3000, clientTxnId: 't2', status: 'completed',
      waiterId: WAITER,
    })).rejects.toThrow(/staffName/);
  });

  it('keeps accepting an ordinary till charge unchanged', async () => {
    const charge = await MerchantCharge.create({
      merchantId: M, eventId: E, walletId: W, bandUid: '04a22b1c',
      amount: 3000, fee: 0, netAmount: 3000, clientTxnId: 't3', status: 'completed',
      merchantOperatorId: OP, staffName: 'Sipho',
    });
    expect(String(charge.merchantOperatorId)).toBe(String(OP));
  });
});
