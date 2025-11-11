import { Types, Document } from 'mongoose';
import { TicketsRole, TicketsPermission } from './ticketsPermission.interface';

export interface ITicketsUserAccess extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  vendorId: Types.ObjectId;
  role: TicketsRole;
  permissions: TicketsPermission[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
