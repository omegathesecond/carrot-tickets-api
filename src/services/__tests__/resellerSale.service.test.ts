import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { Reseller } from '@models/reseller.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { ResellerSaleService } from '@services/resellerSale.service';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures'; // create: returns {eventId, ticketTypeId, capacity}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('cash sale: completed, snapshot reseller-held', async () => {
  await PaymentConfigService.update({ defaultResellerCommissionPercent: 8, platformFeePercent: 0, cashEnabled: true });
  const r = await Reseller.create({ businessName: 'PnP', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

  const res = await ResellerSaleService.createSale({
    operatorId: '64b000000000000000000001', resellerId: r._id.toString(), hubId: '64b000000000000000000002',
    eventId, ticketTypeId, quantity: 1, paymentMethod: 'cash', customerPhone: '+26878422613',
  });
  expect(res.status).toBe('completed');

  const { TicketSale } = await import('@models/ticketSale.model');
  const sale = await TicketSale.findById(res.saleId);
  expect(sale!.fundsCustody).toBe('reseller');
  expect(sale!.organizerProceeds).toBe(92);
  expect(sale!.soldByType).toBe('ResellerOperator');
});

it('rejects a disabled payment method', async () => {
  await PaymentConfigService.update({ keshlessWalletEnabled: false });
  const r = await Reseller.create({ businessName: 'X', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 50, capacity: 2 });
  await expect(ResellerSaleService.createSale({
    operatorId: new mongoose.Types.ObjectId().toString(), resellerId: r._id.toString(), hubId: new mongoose.Types.ObjectId().toString(), eventId, ticketTypeId,
    quantity: 1, paymentMethod: 'keshless_wallet',
  })).rejects.toThrow(/not available/i);
});

it('oversell beyond capacity is rejected', async () => {
  const r = await Reseller.create({ businessName: 'Y', commissionPercent: null });
  const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 10, capacity: 1 });
  const base = { operatorId: new mongoose.Types.ObjectId().toString(), resellerId: r._id.toString(), hubId: new mongoose.Types.ObjectId().toString(), eventId, ticketTypeId, paymentMethod: 'cash' as const };
  await ResellerSaleService.createSale({ ...base, quantity: 1 });
  await expect(ResellerSaleService.createSale({ ...base, quantity: 1 })).rejects.toThrow();
});
