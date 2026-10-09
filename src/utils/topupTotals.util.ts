import { TopupMethod } from '@models/walletTopup.model';

/** Conditional sum of recorded reloads; never classify unknown methods as cash. */
export const sumTopupMethod = (method: TopupMethod) => ({
  $sum: { $cond: [{ $eq: ['$method', method] }, '$amount', 0] },
});
