import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
const gate = (perms = [TicketsPermission.SCAN_TICKETS], vendorId = 'v1') =>
  jwt.sign({ app:'tickets', userType:'gate-operator', vendorId, permissions: perms }, JWT_SECRET);

it('returns the wallet view for a bound band', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  const t = await Ticket.create({ eventId, vendorId, ticketType:'General', price:100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');

  const res = await request(app).get(`/api/tickets/wallets/by-band/04a22b1c3d4e5f?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate([TicketsPermission.SCAN_TICKETS], String(vendorId))}`);
  expect(res.status).toBe(200);
  expect(res.body.data.status).toBe('active');
  expect(res.body.data.balance).toBe(0);
});

it('404s an unbound uid', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  const res = await request(app).get(`/api/tickets/wallets/by-band/aaaaaaaaaaaaaa?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate([TicketsPermission.SCAN_TICKETS], String(vendorId))}`);
  expect(res.status).toBe(404);
});

it('403 without SCAN_TICKETS', async () => {
  const { eventId } = await seedPublishedEvent({});
  const res = await request(app).get(`/api/tickets/wallets/by-band/aaaaaaaaaaaaaa?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate([TicketsPermission.VIEW_EVENTS])}`);
  expect(res.status).toBe(403);
});

// FIX 2 (vendor-ownership): an operator whose token vendorId is Vendor A must
// NOT be able to read a band at Vendor B's event — even with SCAN_TICKETS and a
// real bound band. Without the guard this returned 200 with B's wallet data.
it('rejects Vendor A reading Vendor B\'s event band with 403 (no wallet leak)', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({}); // vendorId = Vendor B
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');

  const res = await request(app).get(`/api/tickets/wallets/by-band/04a22b1c3d4e5f?eventId=${eventId}`)
    .set('Authorization', `Bearer ${gate([TicketsPermission.SCAN_TICKETS], 'vendor-a-different')}`);
  expect(res.status).toBe(403);
  expect(res.body.data).toBeUndefined();
});
