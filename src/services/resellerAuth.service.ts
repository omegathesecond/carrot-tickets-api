import jwt, { SignOptions } from 'jsonwebtoken';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerRole, RESELLER_ROLE_PERMISSIONS, ResellerToken } from '@interfaces/resellerPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

export class ResellerAuthService {
  static async login(identifier: string, password: string) {
    const query = identifier.includes('@') ? { email: identifier.toLowerCase() } : { phoneNumber: identifier };
    const operator = await ResellerOperator.findOne({ ...query, isActive: true }).select('+password');
    if (!operator) throw new Error('Invalid credentials');
    const ok = await operator.comparePassword(password);
    if (!ok) throw new Error('Invalid credentials');

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

    operator.lastLoginAt = new Date();
    await operator.save();

    return {
      accessToken,
      operator: {
        id: payload.operatorId,
        fullName: operator.fullName,
        role,
        resellerId: payload.resellerId,
        hubId: payload.hubId!,
        mustChangePassword: operator.mustChangePassword,
      },
    };
  }

  static verifyToken(token: string): ResellerToken {
    const decoded = jwt.verify(token, JWT_SECRET) as ResellerToken;
    if (decoded.scope !== 'reseller') throw new Error('Invalid token scope');
    return decoded;
  }
}
