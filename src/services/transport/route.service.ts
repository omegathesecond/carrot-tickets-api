import { Route } from '@models/transport/route.model';
import { IRoute } from '@interfaces/transport.interface';
import { HttpError } from '@utils/httpError.util';

export interface CreateRouteParams {
  vendorId: string;
  name: string;
  originCity: string;
  destinationCity: string;
  stops?: string[];
  farePerSeat: number;
}

export interface UpdateRouteParams {
  name?: string;
  originCity?: string;
  destinationCity?: string;
  stops?: string[];
  farePerSeat?: number;
  isActive?: boolean;
}

export class RouteService {
  static async create(p: CreateRouteParams): Promise<IRoute> {
    return Route.create({
      vendorId: p.vendorId,
      name: p.name,
      originCity: p.originCity,
      destinationCity: p.destinationCity,
      stops: p.stops,
      farePerSeat: p.farePerSeat,
    });
  }

  static async list(vendorId: string): Promise<IRoute[]> {
    return Route.find({ vendorId, isActive: true }).sort({ createdAt: -1 });
  }

  static async update(vendorId: string, id: string, patch: UpdateRouteParams): Promise<IRoute> {
    const route = await Route.findOneAndUpdate({ _id: id, vendorId }, { $set: patch }, { new: true });
    if (!route) throw new HttpError(404, 'Route not found');
    return route;
  }

  static async deactivate(vendorId: string, id: string): Promise<void> {
    const res = await Route.updateOne({ _id: id, vendorId }, { $set: { isActive: false } });
    if (res.matchedCount === 0) throw new HttpError(404, 'Route not found');
  }
}
