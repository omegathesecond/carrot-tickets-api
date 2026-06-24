import jwt, { SignOptions } from 'jsonwebtoken';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerRole, RESELLER_ROLE_PERMISSIONS, ResellerToken } from '@interfaces/resellerPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export class ResellerAuthService {
  static async login(loginCode: string, pin: string) {
    const operator = await ResellerOperator.findOne({ loginCode, isActive: true }).select('+pin');
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

    const role = operator.role as ResellerRole;
    const payload: ResellerToken = {
      scope: 'reseller',
      resellerId: operator.resellerId.toString(),
      hubId: operator.hubId ? operator.hubId.toString() : null,
      operatorId: (operator._id as any).toString(),
      role,
      permissions: RESELLER_ROLE_PERMISSIONS[role],
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        id: payload.operatorId,
        fullName: operator.fullName,
        role,
        resellerId: payload.resellerId,
        hubId: payload.hubId!,
        permissions: payload.permissions,
      },
    };
  }

  static verifyToken(token: string): ResellerToken {
    const decoded = jwt.verify(token, JWT_SECRET) as ResellerToken;
    if (decoded.scope !== 'reseller') throw new Error('Invalid token scope');
    return decoded;
  }
}
