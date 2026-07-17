import { normalizePhone, phoneLoginCandidates } from '@utils/phone.util';

describe('phoneLoginCandidates', () => {
  it('returns every equivalent stored form for an international number', () => {
    const c = phoneLoginCandidates('+26876123456');
    expect(c).toEqual(expect.arrayContaining(['+26876123456', '26876123456', '76123456', '076123456']));
  });

  it('produces the same candidate set for local-trunk and bare input', () => {
    const fromLocal = phoneLoginCandidates('076123456').sort();
    const fromBare = phoneLoginCandidates('76123456').sort();
    // Both must include the international form so either stored shape matches.
    expect(fromLocal).toEqual(expect.arrayContaining(['+26876123456', '076123456', '76123456']));
    expect(fromBare).toEqual(expect.arrayContaining(['+26876123456', '076123456', '76123456']));
  });

  it('always includes the canonical normalized form', () => {
    expect(phoneLoginCandidates('076123456')).toContain(normalizePhone('076123456'));
  });

  it('returns [] for an email so the phone branch is skipped', () => {
    expect(phoneLoginCandidates('owner@example.com')).toEqual([]);
    expect(phoneLoginCandidates('  ')).toEqual([]);
    expect(phoneLoginCandidates('')).toEqual([]);
  });
});
