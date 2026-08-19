import { getProcessor } from '@services/payments';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('YocoProcessor', () => {
  it('registered for YOCO', () => {
    expect(getProcessor(PaymentMethod.YOCO).method).toBe(PaymentMethod.YOCO);
  });

  it('charge throws (async-only) so the synchronous sell path can never mint unpaid tickets', async () => {
    await expect(
      getProcessor(PaymentMethod.YOCO).charge({
        method: PaymentMethod.YOCO,
        amount: 1,
        description: 'x',
      })
    ).rejects.toThrow(/async/i);
  });
});
