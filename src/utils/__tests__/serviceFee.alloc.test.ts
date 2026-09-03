import { computeServiceFee, ServiceFeeConfig } from '../serviceFee.util';
import { PaymentMethod } from '@interfaces/ticket.interface';

const cfg: ServiceFeeConfig = {
  keshlessServiceFee: 0,
  momoServiceFee: 8,
  cardServiceFee: 15,
  deltapayServiceFee: 6,
  yocoServiceFee: 0,
  yebopayServiceFee: 10,
};

describe('computeServiceFee — waiveServiceFee (allocation tiers)', () => {
  it('charges the normal per-ticket fee without the waiver', () => {
    const r = computeServiceFee(520, 2, PaymentMethod.DELTAPAY, cfg);
    expect(r.serviceFeeAmount).toBe(12); // 6 × 2
    expect(r.amountCharged).toBe(532);
  });

  it('waives the fee entirely when waiveServiceFee is set — buyer pays face', () => {
    const r = computeServiceFee(520, 2, PaymentMethod.DELTAPAY, cfg, { waiveServiceFee: true });
    expect(r.serviceFeeAmount).toBe(0);
    expect(r.amountCharged).toBe(520);
  });
});
