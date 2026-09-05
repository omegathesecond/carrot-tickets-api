import mongoose from 'mongoose';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';

/** Thrown when a label is already open at this event — the caller maps it to 409. */
export class TableLabelTakenError extends Error {
  constructor(label: string) { super(`Table ${label} is already open`); }
}

export class TableService {
  static async open(params: { eventId: string; label: string; openedBy: string }): Promise<ITable> {
    const label = params.label.trim();
    if (!label) throw new Error('label is required');
    try {
      return await Table.create({
        eventId: new mongoose.Types.ObjectId(params.eventId),
        label, status: 'open', openedBy: params.openedBy, items: [], subtotal: 0,
      });
    } catch (err) {
      // The partial unique index is the arbiter, so two waiters opening "7" at
      // once cannot both win. Discriminated by keyPattern so an E11000 from any
      // other index is not mislabelled.
      if ((err as { keyPattern?: Record<string, unknown> })?.keyPattern?.label) {
        throw new TableLabelTakenError(label);
      }
      throw err;
    }
  }

  static async list(eventId: string, status?: string): Promise<ITable[]> {
    return Table.find({
      eventId: new mongoose.Types.ObjectId(eventId),
      ...(status ? { status } : {}),
    }).sort({ createdAt: -1 }).limit(200);
  }
}
