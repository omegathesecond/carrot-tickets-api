import { assertCarrotTicketing } from '@/utils/ticketingGuard.util';

describe('assertCarrotTicketing', () => {
  it('throws for external events', () => {
    expect(() => assertCarrotTicketing({ ticketing: 'external' })).toThrow('externally');
  });

  it('is a no-op for carrot events', () => {
    expect(() => assertCarrotTicketing({ ticketing: 'carrot' })).not.toThrow();
  });

  it('is a no-op for legacy events with no ticketing field', () => {
    expect(() => assertCarrotTicketing({})).not.toThrow();
  });
});
