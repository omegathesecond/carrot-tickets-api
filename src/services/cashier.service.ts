// api/src/services/cashier.service.ts
import mongoose from 'mongoose';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';

export interface CashierTxn {
  id: string;
  type: 'topup' | 'withdrawal';
  amount: number;
  status: 'completed';
  at: Date;
}

/**
 * A cashier's OWN desk activity (cashless spec — cashier slice). Lets a cashier
 * answer "your funds didn't reflect" by showing exactly the top-ups and
 * cash-outs SHE recorded, with status. Scoped to recordedBy = the cashier id,
 * so one cashier never sees another's rows.
 */
export class CashierService {
  static async listTransactions(params: {
    cashierId: string;
    eventId?: string;
    limit?: number;
  }): Promise<{
    transactions: CashierTxn[];
    summary: { toppedUp: number; withdrawn: number; net: number; count: number };
  }> {
    const { cashierId, eventId, limit = 50 } = params;
    const scope: Record<string, unknown> = { recordedBy: cashierId };
    if (eventId) scope['eventId'] = new mongoose.Types.ObjectId(eventId);

    const [topups, withdrawals] = await Promise.all([
      WalletTopup.find(scope).sort({ createdAt: -1 }).limit(limit).lean(),
      WalletWithdrawal.find(scope).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    const transactions: CashierTxn[] = [
      ...topups.map((t) => ({ id: String(t._id), type: 'topup' as const, amount: t.amount, status: t.status, at: t.createdAt })),
      ...withdrawals.map((w) => ({ id: String(w._id), type: 'withdrawal' as const, amount: w.amount, status: w.status, at: w.createdAt })),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, limit);

    const toppedUp = topups.reduce((s, t) => s + t.amount, 0);
    const withdrawn = withdrawals.reduce((s, w) => s + w.amount, 0);

    return {
      transactions,
      summary: { toppedUp, withdrawn, net: toppedUp - withdrawn, count: topups.length + withdrawals.length },
    };
  }
}
