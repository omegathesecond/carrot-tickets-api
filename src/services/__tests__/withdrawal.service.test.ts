import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { ResellerCommissionWithdrawal } from '@models/resellerCommissionWithdrawal.model';
import { WithdrawalService } from '@services/withdrawal.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  await TicketSale.deleteMany({});
  await ResellerCommissionWithdrawal.deleteMany({});
});

const mk = (o: any) => TicketSale.create({
  eventId: new mongoose.Types.ObjectId(), ticketIds: [new mongoose.Types.ObjectId()],
  vendorId: new mongoose.Types.ObjectId(), quantity: 1, totalAmount: 100,
  paymentMethod: 'mtn_momo', paymentStatus: 'completed', soldBy: new mongoose.Types.ObjectId(), ...o,
});

it('sums only carrot-custody operator commission not yet withdrawn', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 8, fundsCustody: 'carrot' });
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 5, fundsCustody: 'carrot' });
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 9, fundsCustody: 'reseller' }); // excluded: reseller keeps it
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 7, fundsCustody: 'carrot', commissionWithdrawn: true }); // excluded: already paid
  const bal = await WithdrawalService.availableCommission(resellerId.toString());
  expect(bal).toBe(13);
});

it('requests the full available balance and blocks a second open request', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 20, fundsCustody: 'carrot' });
  const w = await WithdrawalService.requestWithdrawal(resellerId.toString(), 'op-1');
  expect(w.amount).toBe(20);
  expect(w.status).toBe('requested');
  await expect(WithdrawalService.requestWithdrawal(resellerId.toString(), 'op-1'))
    .rejects.toThrow('already open');
});

it('rejects a request when balance is zero', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  await expect(WithdrawalService.requestWithdrawal(resellerId.toString(), 'op-1'))
    .rejects.toThrow('No commission available');
});

it('markPaid stamps covered sales then flips, and is idempotent', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 20, fundsCustody: 'carrot' });
  const w = await WithdrawalService.requestWithdrawal(resellerId.toString(), 'op-1');
  await WithdrawalService.approve((w._id as any).toString(), 'admin-1');
  const paid = await WithdrawalService.markPaid((w._id as any).toString(), 'admin-1', 'TX123');
  expect(paid.status).toBe('paid');
  expect(paid.paymentReference).toBe('TX123');
  // sales are now stamped → balance is zero
  expect(await WithdrawalService.availableCommission(resellerId.toString())).toBe(0);
  // second flip throws
  await expect(WithdrawalService.markPaid((w._id as any).toString(), 'admin-1'))
    .rejects.toThrow('already paid');
});

it('markPaid stamps only completed sales, never pending ones', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 20, fundsCustody: 'carrot' });
  const pendingSale = await mk({
    resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 10,
    fundsCustody: 'carrot', paymentStatus: 'pending',
  });
  const w = await WithdrawalService.requestWithdrawal(resellerId.toString(), 'op-1');
  expect(w.amount).toBe(20); // pending excluded from balance
  await WithdrawalService.approve((w._id as any).toString(), 'admin-1');
  await WithdrawalService.markPaid((w._id as any).toString(), 'admin-1', 'TX123');
  // the pending sale later completes
  await TicketSale.updateOne({ _id: pendingSale._id }, { paymentStatus: 'completed' });
  // its commission survives because it was never stamped
  expect(await WithdrawalService.availableCommission(resellerId.toString())).toBe(10);
});

it('reject does not stamp sales', async () => {
  const resellerId = new mongoose.Types.ObjectId();
  await mk({ resellerId, soldByType: 'ResellerOperator', resellerCommissionAmount: 20, fundsCustody: 'carrot' });
  const w = await WithdrawalService.requestWithdrawal(resellerId.toString(), 'op-1');
  await WithdrawalService.reject((w._id as any).toString(), 'admin-1', 'bad ref');
  expect(await WithdrawalService.availableCommission(resellerId.toString())).toBe(20);
});
