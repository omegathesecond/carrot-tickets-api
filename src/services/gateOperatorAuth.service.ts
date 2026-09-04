// api/src/services/gateOperatorAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { GateOperator } from '@models/gateOperator.model';
import {
  TicketsPermission,
  TicketsRole,
  TICKETS_ROLE_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';
import { grantedTicketsPermissions, OperatorGrant } from '@interfaces/operatorGrant.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { recordFailedPinAttempt, clearPinLockout } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

/**
 * The permission set a gate operator row carries RIGHT NOW: the canonical
 * SCANNER role set (so they can list events — VIEW_EVENTS — to pick which show
 * they are scanning, not just scan) as the floor, plus the per-person grants
 * (e.g. the tag desk) on top.
 *
 * Minted into the token at login for the client's benefit, but the token copy
 * is NOT what the permission gate trusts for a gate operator — tokens live 7
 * days and an organizer removing a grant must bite at once, so
 * requireTicketsPermission re-resolves this from the row on every request.
 * One function so login and the gate can never disagree about the set.
 */
export function gateOperatorPermissions(grants?: string[] | null): TicketsPermission[] {
  return [
    ...TICKETS_ROLE_PERMISSIONS[TicketsRole.SCANNER],
    ...grantedTicketsPermissions(grants),
  ];
}

export class GateOperatorAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const operator = await GateOperator.findOne({ loginCode: normalizeLoginCode(loginCode), isActive: true }).select('+pin');
    if (!operator) throw new Error('Invalid credentials');

    if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await operator.comparePin(pin);
    if (!ok) {
      // Counted on the server, not on this loaded document — N guesses in
      // flight together must reach N and lock, not all write 1.
      await recordFailedPinAttempt(GateOperator, operator._id as any);
      throw new Error('Invalid credentials');
    }

    await clearPinLockout(GateOperator, operator._id as any);

    const isSuperAdmin = operator.scope === 'platform';
    const payload: Record<string, unknown> = {
      app: 'tickets',
      userType: 'gate-operator',
      userId: (operator._id as any).toString(),
      role: 'gate_operator',
      // Informational for the client — the gate re-reads the row (see
      // gateOperatorPermissions).
      permissions: gateOperatorPermissions((operator as any).grants),
      isSuperAdmin,
    };
    if (!isSuperAdmin && operator.vendorId) payload['vendorId'] = operator.vendorId.toString();

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    const grants: string[] = ((operator as any).grants ?? []).map(String);

    return {
      accessToken,
      operator: {
        id: (operator._id as any).toString(),
        fullName: operator.fullName,
        scope: operator.scope,
        vendorId: operator.vendorId ? operator.vendorId.toString() : null,
        grants,
        /**
         * The Register desk is a gate operator carrying the tag grant — the
         * organizer's own person who enrols the event's tags and hands them
         * out. It is surfaced here rather than left for the client to derive
         * from `grants`, so the POS routes to the right screen off ONE field
         * and every client agrees on what "Register" means.
         */
        isRegisterDesk: grants.includes(OperatorGrant.ISSUE_TAGS),
      },
    };
  }
}
