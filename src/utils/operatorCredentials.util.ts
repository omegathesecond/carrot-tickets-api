// api/src/utils/operatorCredentials.util.ts
import { ResellerOperator } from '@models/resellerOperator.model';

/** Random 6-digit PIN string (leading zeros allowed). */
export function generatePin(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

/** Random globally-unique 6-digit login code (100000–999999). */
export async function generateUniqueLoginCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const exists = await ResellerOperator.exists({ loginCode: code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique login code');
}
