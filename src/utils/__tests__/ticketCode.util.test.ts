import { generateTicketCode, normalizeTicketCode, groupTicketCode } from '@utils/ticketCode.util';

const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

it('generateTicketCode returns 8 chars from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    expect(generateTicketCode()).toMatch(ALPHABET);
  }
});

it('generateTicketCode never emits ambiguous characters', () => {
  const joined = Array.from({ length: 200 }, () => generateTicketCode()).join('');
  expect(joined).not.toMatch(/[ILO01]/);
});

it('normalizeTicketCode uppercases and strips spaces/dashes', () => {
  expect(normalizeTicketCode(' k7p2-9xqr ')).toBe('K7P29XQR');
  expect(normalizeTicketCode('K7P2 9XQR')).toBe('K7P29XQR');
});

it('groupTicketCode formats an 8-char code as XXXX-XXXX', () => {
  expect(groupTicketCode('K7P29XQR')).toBe('K7P2-9XQR');
});

it('groupTicketCode leaves legacy ids untouched', () => {
  expect(groupTicketCode('TKT-123-AB3D9F')).toBe('TKT-123-AB3D9F');
});
