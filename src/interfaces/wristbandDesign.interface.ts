import { Document, Types } from 'mongoose';

/**
 * A saved wristband design for an event. `sheetTemplate` is a full dimension
 * snapshot (not just a key) so reprints lay out identically even if template
 * defaults change later. `designJson` is the dashboard editor's serialized
 * scene — the API treats it as opaque.
 */
export interface IWristbandDesign extends Document {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  name: string;
  sheetTemplate: Record<string, unknown>;
  designJson: Record<string, unknown>;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
