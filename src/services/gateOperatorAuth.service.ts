// api/src/services/gateOperatorAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { GateOperator } from '@models/gateOperator.model';
import {
  TicketsRole,
  TICKETS_ROLE_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { JWT_SECRET } from '@config/jwt.config';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export class GateOperatorAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const operator = await GateOperator.findOne({ loginCode, isActive: true }).select('+pin');
    if (!operator) throw new Error('Invalid credentials');

    if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await operator.comparePin(pin);
    if (!ok) {
      operator.failedPinAttempts = (operator.failedPinAttempts ?? 0) + 1;
      if (operator.failedPinAttempts >= MAX_PIN_ATTEMPTS) {
        operator.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        operator.failedPinAttempts = 0;
      }
      await operator.save();
      throw new Error('Invalid credentials');
    }

    operator.failedPinAttempts = 0;
    operator.lockedUntil = null;
    operator.lastLoginAt = new Date();
    await operator.save();

    const isSuperAdmin = operator.scope === 'platform';
    const payload: Record<string, unknown> = {
      app: 'tickets',
      userType: 'gate-operator',
      userId: (operator._id as any).toString(),
      role: 'gate_operator',
      // Use the canonical SCANNER role set so gate operators can list events
      // (VIEW_EVENTS) to pick which show they're scanning — not just scan.
      permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER],
      isSuperAdmin,
    };
    if (!isSuperAdmin && operator.vendorId) payload['vendorId'] = operator.vendorId.toString();

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        id: (operator._id as any).toString(),
        fullName: operator.fullName,
        scope: operator.scope,
        vendorId: operator.vendorId ? operator.vendorId.toString() : null,
      },
    };
  }
}
