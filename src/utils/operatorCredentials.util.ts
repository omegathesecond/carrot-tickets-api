// api/src/utils/operatorCredentials.util.ts
import { randomInt } from 'crypto';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { Merchant } from '@models/merchant.model';

/** Random 6-digit PIN string (leading zeros allowed). */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Random globally-unique 6-digit login code (100000–999999). */
export async function generateUniqueLoginCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(randomInt(100000, 1_000_000));
    const [r, g, c, m] = await Promise.all([
      ResellerOperator.exists({ loginCode: code }),
      GateOperator.exists({ loginCode: code }),
      Cashier.exists({ loginCode: code }),
      Merchant.exists({ loginCode: code }),
    ]);
    if (!r && !g && !c && !m) return code;
  }
  throw new Error('Could not generate a unique login code');
}
