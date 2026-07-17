import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsAuthService } from '@services/ticketsAuth.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

/**
 * Organizers (Vendors) log in with email OR phone. Emails are stored
 * lowercased+trimmed by the schema, and phone numbers are stored verbatim in
 * whatever shape the organizer typed at signup. The login lookup must tolerate
 * the same identifier arriving in a different case / phone format — otherwise a
 * correct password is rejected with "Invalid credentials".
 */
describe('organizer login identifier matching', () => {
  it('matches email case-insensitively and trims surrounding whitespace', async () => {
    // Stored as 'owner@example.com' (schema lowercases + trims on write).
    await Vendor.create({ businessName: 'Acme', email: 'Owner@Example.com', password: 'secret1', operatorType: OperatorType.EVENTS });

    await expect(TicketsAuthService.login('owner@example.com', 'secret1')).resolves.toHaveProperty('accessToken');
    await expect(TicketsAuthService.login('OWNER@EXAMPLE.COM', 'secret1')).resolves.toHaveProperty('accessToken');
    await expect(TicketsAuthService.login('  Owner@Example.com  ', 'secret1')).resolves.toHaveProperty('accessToken');
  });

  it('matches an international-stored phone regardless of the format typed at login', async () => {
    await Vendor.create({ businessName: 'Beta', email: 'b@b.co', phoneNumber: '+26876123456', password: 'secret1', operatorType: OperatorType.EVENTS });

    await expect(TicketsAuthService.login('+26876123456', 'secret1')).resolves.toHaveProperty('accessToken');
    await expect(TicketsAuthService.login('26876123456', 'secret1')).resolves.toHaveProperty('accessToken');
    await expect(TicketsAuthService.login('076123456', 'secret1')).resolves.toHaveProperty('accessToken');
    await expect(TicketsAuthService.login('76123456', 'secret1')).resolves.toHaveProperty('accessToken');
  });

  it('matches a locally-stored phone when the organizer types the international form', async () => {
    await Vendor.create({ businessName: 'Gamma', email: 'g@g.co', phoneNumber: '076123456', password: 'secret1', operatorType: OperatorType.EVENTS });

    await expect(TicketsAuthService.login('+26876123456', 'secret1')).resolves.toHaveProperty('accessToken');
    await expect(TicketsAuthService.login('076123456', 'secret1')).resolves.toHaveProperty('accessToken');
  });

  it('still rejects a wrong password with Invalid credentials', async () => {
    await Vendor.create({ businessName: 'Delta', email: 'd@d.co', password: 'secret1', operatorType: OperatorType.EVENTS });

    await expect(TicketsAuthService.login('d@d.co', 'wrong-password')).rejects.toThrow('Invalid credentials');
  });

  it('rejects an unknown identifier with Invalid credentials', async () => {
    await expect(TicketsAuthService.login('nobody@nowhere.co', 'secret1')).rejects.toThrow('Invalid credentials');
  });
});
