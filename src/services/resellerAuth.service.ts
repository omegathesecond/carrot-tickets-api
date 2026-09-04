import jwt, { SignOptions } from 'jsonwebtoken';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Reseller } from '@models/reseller.model';
import { ResellerRole, RESELLER_ROLE_PERMISSIONS, ResellerToken } from '@interfaces/resellerPermission.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { recordFailedPinAttempt, clearPinLockout } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

export class ResellerAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const operator = await ResellerOperator.findOne({ loginCode: normalizeLoginCode(loginCode), isActive: true }).select('+pin');
    if (!operator) throw new Error('Invalid credentials');

    // The PARENT company gates the till, exactly as it gates ownerLogin.
    // Suspending or deactivating a reseller is the admin's only control over
    // a whole partner; reading just the operator row here let every till
    // under a suspended partner carry on logging in and selling. Same generic
    // error as everything else so the response never says which check failed.
    // `status` is compared to 'suspended' rather than filtered on 'active' so
    // a row written before the field existed (no status at all) still logs
    // in — the same rule resolveOperatorEventScope applies at request time.
    const company = await Reseller.findById(operator.resellerId).select('isActive status').lean();
    if (!company || !company.isActive || company.status === 'suspended') throw new Error('Invalid credentials');

    if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await operator.comparePin(pin);
    if (!ok) {
      // Counted on the server, not on this loaded document — N guesses in
      // flight together must reach N and lock, not all write 1.
      await recordFailedPinAttempt(ResellerOperator, operator._id as any);
      throw new Error('Invalid credentials');
    }

    await clearPinLockout(ResellerOperator, operator._id as any);

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

  /**
   * Owner login by email + password — for a reseller partner (e.g. DeltaPay)
   * to sign in to the allocation portal without a till-operator loginCode/PIN.
   * Issues a reseller-scoped token as a `reseller_admin` (full view of their
   * own blocks), with no operator/hub. Generic error on any failure so it
   * never reveals whether an email exists.
   */
  static async ownerLogin(email: string, password: string) {
    const reseller = await Reseller.findOne({ email: email.toLowerCase().trim(), isActive: true }).select('+password');
    if (!reseller || !reseller.password) throw new Error('Invalid credentials');

    const ok = await reseller.comparePassword(password);
    if (!ok) throw new Error('Invalid credentials');

    const role: ResellerRole = 'reseller_admin' as ResellerRole;
    const payload: ResellerToken = {
      scope: 'reseller',
      resellerId: (reseller._id as any).toString(),
      hubId: null,
      // Owner acts as themselves; no operator row. Scoping that matters
      // (reports, allocation) keys off resellerId, not operatorId.
      operatorId: (reseller._id as any).toString(),
      role,
      permissions: RESELLER_ROLE_PERMISSIONS[role],
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      reseller: {
        id: payload.resellerId,
        resellerId: payload.resellerId,
        businessName: reseller.businessName,
        email: reseller.email,
        role,
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
