import { groupTicketCode } from '@utils/ticketCode.util';

// Guards the display contract the SMS body relies on.
it('groups 8-char codes and leaves legacy ids untouched', () => {
  expect(groupTicketCode('K7P29XQR')).toBe('K7P2-9XQR');
  expect(groupTicketCode('TKT-1718-AB3D9F')).toBe('TKT-1718-AB3D9F');
});
