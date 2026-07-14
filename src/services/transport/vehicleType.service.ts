import { VehicleType } from '@models/transport/vehicleType.model';
import { IVehicleType, SeatScheme, SeatLayout } from '@interfaces/transport.interface';
import { HttpError } from '@utils/httpError.util';

export interface CreateVehicleTypeParams {
  vendorId: string;
  name: string;
  totalSeats: number;
  seatScheme?: SeatScheme;
  layoutJson?: SeatLayout | null;
  registrations?: string[];
}

export interface UpdateVehicleTypeParams {
  name?: string;
  totalSeats?: number;
  seatScheme?: SeatScheme;
  layoutJson?: SeatLayout | null;
  registrations?: string[];
  isActive?: boolean;
}

export class VehicleTypeService {
  static async create(p: CreateVehicleTypeParams): Promise<IVehicleType> {
    const scheme = p.seatScheme ?? SeatScheme.SEQUENTIAL;
    if (scheme === SeatScheme.ROW_LETTER && (!p.layoutJson || !p.layoutJson.rows || !p.layoutJson.seatsPerRow)) {
      throw new HttpError(400, 'ROW_LETTER vehicle type requires layoutJson { rows, seatsPerRow }');
    }
    if (scheme === SeatScheme.ROW_LETTER) {
      const total = p.totalSeats;
      if (p.layoutJson!.rows * p.layoutJson!.seatsPerRow < total) {
        throw new HttpError(400, 'ROW_LETTER layout (rows × seatsPerRow) must provide at least totalSeats seats');
      }
    }
    try {
      return await VehicleType.create({
        vendorId: p.vendorId,
        name: p.name,
        totalSeats: p.totalSeats,
        seatScheme: scheme,
        layoutJson: p.layoutJson ?? null,
        registrations: p.registrations ?? [],
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A vehicle type with that name already exists');
      throw err;
    }
  }

  static async list(vendorId: string): Promise<IVehicleType[]> {
    return VehicleType.find({ vendorId, isActive: true }).sort({ createdAt: -1 });
  }

  static async update(vendorId: string, id: string, patch: UpdateVehicleTypeParams): Promise<IVehicleType> {
    const vt = await VehicleType.findOne({ _id: id, vendorId });
    if (!vt) throw new HttpError(404, 'Vehicle type not found');
    Object.assign(vt, patch);
    if (vt.seatScheme === SeatScheme.ROW_LETTER && (!vt.layoutJson || !vt.layoutJson.rows || !vt.layoutJson.seatsPerRow)) {
      throw new HttpError(400, 'ROW_LETTER vehicle type requires layoutJson { rows, seatsPerRow }');
    }
    if (vt.seatScheme === SeatScheme.ROW_LETTER && vt.layoutJson!.rows * vt.layoutJson!.seatsPerRow < vt.totalSeats) {
      throw new HttpError(400, 'ROW_LETTER layout (rows × seatsPerRow) must provide at least totalSeats seats');
    }
    try {
      return await vt.save();
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A vehicle type with that name already exists');
      throw err;
    }
  }

  static async deactivate(vendorId: string, id: string): Promise<void> {
    const res = await VehicleType.updateOne({ _id: id, vendorId }, { $set: { isActive: false } });
    if (res.matchedCount === 0) throw new HttpError(404, 'Vehicle type not found');
  }
}
