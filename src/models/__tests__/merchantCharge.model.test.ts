import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { MerchantCharge } from '@models/merchantCharge.model';

const id = () => new mongoose.Types.ObjectId();

describe('MerchantCharge items + staffName', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('persists an itemised charge with a line-item snapshot and staffName', async () => {
    const c = await MerchantCharge.create({
      merchantId: id(), merchantOperatorId: id(), eventId: id(), walletId: id(), bandUid: '04aabbccddee',
      amount: 6500, fee: 0, netAmount: 6500, clientTxnId: 'c1', status: 'completed',
      staffName: 'Sipho',
      items: [
        { productId: id(), name: 'Castle Lite 330ml', unitPrice: 2500, qty: 2, lineTotal: 5000 },
        { productId: id(), name: 'Water 500ml', unitPrice: 1500, qty: 1, lineTotal: 1500 },
      ],
    });
    expect(c.items).toHaveLength(2);
    expect((c.items as any)[0].lineTotal).toBe(5000);
    expect(c.staffName).toBe('Sipho');
  });

  it('still persists an amount-only charge with no items (un-itemised)', async () => {
    const c = await MerchantCharge.create({
      merchantId: id(), merchantOperatorId: id(), eventId: id(), walletId: id(), bandUid: '04aabbccddee',
      amount: 300, fee: 0, netAmount: 300, clientTxnId: 'c2', status: 'completed',
      staffName: 'Sipho',
    });
    expect(c.items).toBeUndefined();
    expect(c.staffName).toBe('Sipho');
  });

  it('rejects a charge with no merchantOperatorId (attribution is not optional)', async () => {
    await expect(MerchantCharge.create({
      merchantId: id(), eventId: id(), walletId: id(), bandUid: '04aabbccddee',
      amount: 300, fee: 0, netAmount: 300, clientTxnId: 'c3', status: 'completed',
      staffName: 'Sipho',
    })).rejects.toThrow(/merchantOperatorId/);
  });

  it('rejects a charge with no staffName (attribution snapshot is not optional)', async () => {
    await expect(MerchantCharge.create({
      merchantId: id(), merchantOperatorId: id(), eventId: id(), walletId: id(), bandUid: '04aabbccddee',
      amount: 300, fee: 0, netAmount: 300, clientTxnId: 'c4', status: 'completed',
    })).rejects.toThrow(/staffName/);
  });
});
