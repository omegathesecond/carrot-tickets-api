import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { ExportService } from '@services/export.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import '@models/vendor.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = new mongoose.Types.ObjectId();

async function sale(over: Partial<Record<string, unknown>> = {}) {
  return TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId,
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 50,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel: SalesChannel.ONLINE,
    soldAt: new Date(),
    ...over,
  });
}

/** CSV data rows (header stripped, blank lines dropped). */
function rows(csv: string): string[] {
  return csv.split('\n').slice(1).filter((l) => l.trim() !== '');
}

/**
 * The Sales History page has always offered payment-method, status and channel
 * filters, but `exportSales` read only eventId/startDate/endDate — so "Export
 * CSV" silently returned rows the on-screen filters excluded. Someone filtering
 * to reseller sales and hitting Export got every channel, with nothing saying so.
 */
describe('exportSalesToCSV filters', () => {
  it('filters by channel', async () => {
    await sale({ channel: SalesChannel.ONLINE, totalAmount: 10 });
    await sale({ channel: SalesChannel.RESELLER_POS, totalAmount: 20 });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      channel: SalesChannel.RESELLER_POS,
    });

    expect(rows(csv)).toHaveLength(1);
    expect(csv).toContain('reseller_pos');
    expect(csv).not.toContain('online');
  });

  it('filters by payment method', async () => {
    await sale({ paymentMethod: PaymentMethod.CASH });
    await sale({ paymentMethod: PaymentMethod.MTN_MOMO });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      paymentMethod: PaymentMethod.MTN_MOMO,
    });

    expect(rows(csv)).toHaveLength(1);
    expect(csv).toContain('mtn_momo');
    expect(csv).not.toContain('cash');
  });

  it('still exports only completed sales when no filters are given', async () => {
    await sale({ paymentStatus: PaymentStatus.COMPLETED });
    await sale({ paymentStatus: PaymentStatus.FAILED });
    await sale({ paymentStatus: PaymentStatus.PENDING });

    const csv = await ExportService.exportSalesToCSV({ vendorId: vendorId.toString() });

    expect(rows(csv)).toHaveLength(1);
  });

  // THE invariant. TicketService.getSales locks non-super-admins to COMPLETED
  // and ignores any paymentStatus they pass; the export must match, or adding
  // a filter here would newly expose failed/pending payment attempts to
  // organizers through a CSV they can already download.
  it('ignores paymentStatus for a non-super-admin and still returns only completed', async () => {
    // The CSV carries no payment-status column, so the rows are told apart by
    // amount rather than by a status string that isn't in the output.
    await sale({ paymentStatus: PaymentStatus.COMPLETED, totalAmount: 11 });
    await sale({ paymentStatus: PaymentStatus.FAILED, totalAmount: 22 });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      paymentStatus: PaymentStatus.FAILED,
    });

    expect(rows(csv)).toHaveLength(1);
    expect(csv).toContain('11.00');   // the COMPLETED sale
    expect(csv).not.toContain('22.00'); // the FAILED one stays hidden
  });

  it('honours paymentStatus for a super-admin', async () => {
    await sale({ paymentStatus: PaymentStatus.COMPLETED, totalAmount: 11 });
    await sale({ paymentStatus: PaymentStatus.REFUNDED, totalAmount: 22 });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      isSuperAdmin: true,
      paymentStatus: PaymentStatus.REFUNDED,
    });

    expect(rows(csv)).toHaveLength(1);
    expect(csv).toContain('22.00');   // the REFUNDED sale
    expect(csv).not.toContain('11.00');
  });

  it('lets a super-admin export every status by omitting the filter', async () => {
    await sale({ paymentStatus: PaymentStatus.COMPLETED });
    await sale({ paymentStatus: PaymentStatus.FAILED });
    await sale({ paymentStatus: PaymentStatus.REFUNDED });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      isSuperAdmin: true,
    });

    expect(rows(csv)).toHaveLength(3);
  });

  it('combines filters', async () => {
    await sale({ channel: SalesChannel.RESELLER_POS, paymentMethod: PaymentMethod.CASH });
    await sale({ channel: SalesChannel.RESELLER_POS, paymentMethod: PaymentMethod.MTN_MOMO });
    await sale({ channel: SalesChannel.ONLINE, paymentMethod: PaymentMethod.MTN_MOMO });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      channel: SalesChannel.RESELLER_POS,
      paymentMethod: PaymentMethod.MTN_MOMO,
    });

    expect(rows(csv)).toHaveLength(1);
  });

  it('never crosses vendors', async () => {
    await sale();
    await TicketSale.create({
      eventId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      ticketIds: [new mongoose.Types.ObjectId()],
      quantity: 1, totalAmount: 99,
      paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.COMPLETED,
      soldBy: new mongoose.Types.ObjectId(), soldByType: 'Vendor',
      channel: SalesChannel.RESELLER_POS, soldAt: new Date(),
    });

    const csv = await ExportService.exportSalesToCSV({
      vendorId: vendorId.toString(),
      channel: SalesChannel.RESELLER_POS,
    });

    expect(rows(csv)).toHaveLength(0);
  });
});
