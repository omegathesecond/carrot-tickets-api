import { computeAvailable } from '@services/event.service';

describe('computeAvailable', () => {
  it('subtracts both sold and reserved from quantity', () => {
    expect(computeAvailable({ quantity: 100, sold: 10, reserved: 5 })).toBe(85);
  });
  it('never returns negative', () => {
    expect(computeAvailable({ quantity: 10, sold: 8, reserved: 5 })).toBe(0);
  });
});
