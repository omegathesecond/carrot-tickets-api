import { getProcessor } from '@services/payments';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('CardProcessor', () => {
  it('registered for CARD', () => {
    expect(getProcessor(PaymentMethod.PEACH_CARD).method).toBe(PaymentMethod.PEACH_CARD);
  });

  it('charge throws (async-only)', async () => {
    await expect(
      getProcessor(PaymentMethod.PEACH_CARD).charge({
        method: PaymentMethod.PEACH_CARD,
        amount: 1,
        description: 'x'
      })
    ).rejects.toThrow(/async/i);
  });
});
