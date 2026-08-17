import { normalizeBandUid, assertValidBandUid } from '@utils/bandUid.util';

it('normalizes case and separators', () => {
  expect(normalizeBandUid('04:A2:2B:1C:3D:4E:5F')).toBe('04a22b1c3d4e5f');
  expect(normalizeBandUid('04A22B1C3D4E5F')).toBe('04a22b1c3d4e5f');
});
it('accepts a 7-byte (14 hex) uid', () => {
  expect(assertValidBandUid('04a22b1c3d4e5f')).toBe('04a22b1c3d4e5f');
});
it('accepts a 4-byte (8 hex) uid', () => {
  expect(assertValidBandUid('04a22b1c')).toBe('04a22b1c');
});
it('rejects a uid shorter than 4 bytes (8 hex) and non-hex', () => {
  expect(() => assertValidBandUid('04a22b')).toThrow(/at least 4 bytes/);
  expect(() => assertValidBandUid('zzzz')).toThrow(/hex/i);
});
