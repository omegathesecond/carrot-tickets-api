import { preparationInput } from './preparation.controller';

const input = { category: 'hair', budget: 300, preferredDate: '2027-01-10', location: 'Mbabane', mode: 'open', providerIds: [] };
const provider = '507f1f77bcf86cd799439011';

describe('preparation request validation', () => {
  it('accepts open requests with an empty or omitted provider list', () => {
    expect(preparationInput.validate(input).error).toBeUndefined();
    const { providerIds, ...withoutProviders } = input;
    expect(preparationInput.validate(withoutProviders).value.providerIds).toEqual(providerIds);
    expect(preparationInput.validate(withoutProviders).error).toBeUndefined();
  });
  it('accepts selected providers and rejects empty invites, duplicates and invalid ids', () => {
    expect(preparationInput.validate({ ...input, mode: 'invite', providerIds: [provider] }).error).toBeUndefined();
    for (const providerIds of [[], [provider, provider], ['invalid']]) {
      expect(preparationInput.validate({ ...input, mode: 'invite', providerIds }).error).toBeDefined();
    }
    const withoutProviders = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'providerIds'));
    expect(preparationInput.validate({ ...withoutProviders, mode: 'invite' }).error).toBeDefined();
  });
});
