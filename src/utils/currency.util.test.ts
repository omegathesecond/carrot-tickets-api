import { settlementCurrencyForMethod } from './currency.util';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('settlementCurrencyForMethod', () => {
  it('settles card payments in ZAR (Peach is ZAR-native)', () => {
    expect(settlementCurrencyForMethod(PaymentMethod.PEACH_CARD)).toBe('ZAR');
  });
  it('settles MoMo in SZL', () => {
    expect(settlementCurrencyForMethod(PaymentMethod.MTN_MOMO)).toBe('SZL');
  });
  it('settles wallet / cash in SZL', () => {
    expect(settlementCurrencyForMethod(PaymentMethod.CASH)).toBe('SZL');
  });
});
