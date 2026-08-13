import { TicketService } from './ticket.service';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';

describe('TicketService currency snapshots', () => {
  beforeEach(() => {
    jest.spyOn(PaymentConfigService, 'get').mockResolvedValue({ platformFeePercent: 0 } as any);
  });

  it('buildSaleSnapshot stamps display + settlement currency (card → ZAR/ZAR)', async () => {
    const snap = await (TicketService as any).buildSaleSnapshot({
      totalAmount: 100, paymentMethod: PaymentMethod.PEACH_CARD,
      mappedSoldByType: 'Vendor', displayCurrency: 'ZAR',
    });
    expect(snap.currency).toBe('ZAR');
    expect(snap.settlementCurrency).toBe('ZAR');
  });

  it('records SZL settlement for a ZAR event paid by MoMo', async () => {
    const snap = await (TicketService as any).buildSaleSnapshot({
      totalAmount: 100, paymentMethod: PaymentMethod.MTN_MOMO,
      mappedSoldByType: 'Vendor', displayCurrency: 'ZAR',
    });
    expect(snap.currency).toBe('ZAR');
    expect(snap.settlementCurrency).toBe('SZL');
  });
});
