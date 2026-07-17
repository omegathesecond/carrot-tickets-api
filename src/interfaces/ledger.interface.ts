/** Chart of accounts for the per-event cashless ledger (spec §3). */
export enum LedgerAccountType {
  /** Asset: total attendee funds under custody. Debit-normal (positive = holding money). */
  FLOAT = 'float',
  /** Liability: money owed to an attendee. Credit-normal (negative = owed). */
  WALLET = 'wallet',
  /** Liability: earnings owed to a merchant. Credit-normal (negative = owed). */
  MERCHANT = 'merchant',
  /** Revenue: Carrot service/commission income. Credit-normal (negative = earned). */
  FEES = 'fees',
}

/** Where float money physically sits. Only meaningful on FLOAT postings. */
export enum FloatTag {
  /** Settled into the Keshless-held float via the gateway. */
  KESHLESS = 'keshless',
  /** Physical cash collected at a cash desk, not yet banked. */
  CASH_DESK = 'cash_desk',
}

/** Account types that address a specific entity and therefore require a ref. */
const REF_REQUIRED: ReadonlySet<LedgerAccountType> = new Set([
  LedgerAccountType.WALLET,
  LedgerAccountType.MERCHANT,
]);

export interface LedgerAccount {
  type: LedgerAccountType;
  /** Entity id for WALLET/MERCHANT; omitted for the singleton FLOAT/FEES accounts. */
  ref?: string;
}

/** Canonical string form of an account, e.g. 'float' or 'wallet:<id>'. */
export function accountKey(a: LedgerAccount): string {
  if (REF_REQUIRED.has(a.type)) {
    if (!a.ref) throw new Error(`${a.type} account requires a ref`);
    return `${a.type}:${a.ref}`;
  }
  return a.type;
}

export function accountRequiresRef(type: LedgerAccountType): boolean {
  return REF_REQUIRED.has(type);
}
