import { Request, Response, NextFunction } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Every query value must be text.
 *
 * Express parses the query string with qs and `allowPrototypes: true`, so the
 * REQUEST chooses the shape of each value: `x=1&x=2` and `x[]=1` are arrays,
 * `x[k]=v` is an object, and `x[toString]=v` is an object whose String(),
 * Number(), parseInt(), new Date() and RegExp.test() all THROW. Handlers read
 * query values as text, and no route takes a repeated or nested parameter — a
 * list travels comma-joined in one value (`exclude=a,b`).
 *
 * So the shape is refused here, once, in front of every router: a loud 400
 * naming the parameter. Never a 500, never a filter that is quietly dropped,
 * and never the unhandled rejection that exits the process when the coercion
 * sits outside a handler's try block.
 *
 * The parser stays `extended` on purpose. The `simple` parser would turn
 * `x[k]=v` into an unread key called "x[k]" — the silent ignore this exists to
 * prevent — and would still hand handlers an array for a repeated key.
 */
export function requireTextQuery(req: Request, res: Response, next: NextFunction): void {
  const name = Object.keys(req.query).find((key) => typeof req.query[key] !== 'string');
  if (name !== undefined) {
    ApiResponseUtil.badRequest(res, `Invalid query parameter: ${name}`);
    return;
  }
  next();
}
