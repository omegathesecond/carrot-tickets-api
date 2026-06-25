import { getProcessor } from '@services/payments';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('CardProcessor', () => {
  it('registered for CARD', () => {
    expect(getProcessor(PaymentMethod.CARD).method).toBe(PaymentMethod.CARD);
  });

  it('charge throws (async-only)', async () => {
    await expect(
      getProcessor(PaymentMethod.CARD).charge({
        method: PaymentMethod.CARD,
        amount: 1,
        description: 'x'
      })
    ).rejects.toThrow(/async/i);
  });
});
