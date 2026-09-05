// api/src/services/merchantAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Event } from '@models/event.model';
import { MerchantToken } from '@interfaces/merchant.interface';
import { deriveMerchantPermissions } from '@interfaces/operatorGrant.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { recordFailedPinAttempt, clearPinLockout } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

/**
 * Stall-operator login — loginCode + PIN, mirroring GateOperatorAuthService /
 * ResellerAuthService exactly (bcrypt compare via comparePin, same lockout
 * bookkeeping, same JWT_SECRET). The credentials belong to a PERSON
 * (MerchantOperator); the STALL (Merchant) they work is read from that
 * document, never chosen by the device. The token therefore names both: the
 * stall money is owed to, and the human each charge is attributed to. It is
 * scoped to ONE event and carries the base permission (merchant:charge) plus
 * whatever grants the operator holds, translated into the merchant namespace.
 * Authorization is NOT based on this token — the permissions field is only the
 * POS's rendering copy; the gate is in authenticateMerchant, which re-derives
 * the same set from the operator row on every request.
 */
export class MerchantAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    // Normalized here as well as at the routing probe: the service has to be
    // safe called on its own, and normalizeLoginCode is idempotent.
    const operator = await MerchantOperator
      .findOne({ loginCode: normalizeLoginCode(loginCode), isActive: true })
      .select('+pin');
    if (!operator) throw new Error('Invalid credentials');

    if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await operator.comparePin(pin);
    if (!ok) {
      // Counted on the server, not on this loaded document — N guesses in
      // flight together must reach N and lock, not all write 1.
      await recordFailedPinAttempt(MerchantOperator, operator._id as any);
      throw new Error('Invalid credentials');
    }

    // The stall must still be active — suspending a stall must not leave its
    // people able to charge against it.
    const merchant = await Merchant.findOne({ _id: operator.merchantId, status: 'active' });
    if (!merchant) throw new Error('Invalid credentials');

    await clearPinLockout(MerchantOperator, operator._id as any);

    // The app's vendor header shows this instead of a raw eventId — best
    // effort: a missing/deleted event must not block login, it just means
    // eventName comes back undefined and the UI falls back to the id.
    const event = await Event.findById(merchant.eventId).select('name').lean();

    // The role is the floor (every person on a till can charge); grants are
    // the per-person extras. Re-derived from the row on every request too —
    // see authenticateMerchant — so this is the POS's copy, not the gate.
    // deriveMerchantPermissions is the single definition of that formula,
    // shared with authenticateMerchant precisely so the two cannot drift.
    const permissions = deriveMerchantPermissions((operator as any).grants);

    const payload: MerchantToken = {
      scope: 'merchant',
      merchantId: (merchant._id as any).toString(),
      merchantOperatorId: (operator._id as any).toString(),
      operatorName: operator.fullName,
      eventId: merchant.eventId.toString(),
      name: merchant.name,
      ...(event?.name ? { eventName: event.name } : {}),
      permissions,
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        merchantId: payload.merchantId,
        merchantOperatorId: payload.merchantOperatorId,
        operatorName: operator.fullName,
        name: merchant.name,
        eventId: payload.eventId,
        eventName: event?.name,
        // The POS renders from this (which tabs and actions to show). It is NOT
        // authorization — authenticateMerchant re-derives the same set from the
        // operator row on every request, and that is the only thing the server
        // trusts. Returned here so the client need not decode its own JWT.
        permissions,
      },
    };
  }

  static verifyToken(token: string): MerchantToken {
    const decoded = jwt.verify(token, JWT_SECRET) as MerchantToken;
    if (decoded.scope !== 'merchant') throw new Error('Invalid token scope');
    return decoded;
  }
}
