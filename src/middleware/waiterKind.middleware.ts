import { NextFunction, Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { WaiterToken } from '@interfaces/waiter.interface';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export const NOT_AT_VENUES = "That isn't used at venues";
export const VENUE_ONLY = 'That is a venue feature';

/**
 * One URL, two kinds of waiter. An event waiter and a venue waiter share the
 * app's routes, but never each other's code: the token's kind picks the
 * handler, so an event handler can rely on an event and a venue handler on a
 * venue.
 */
export const byWaiterKind = (eventHandler: Handler, venueHandler: Handler): Handler =>
  (req, res, next) => (((req as any).waiter as WaiterToken).venueId ? venueHandler : eventHandler)(req, res, next);

/** A handler that answers 403 — for the kind a route is not for. */
export const refuse = (message: string): Handler => (_req, res) => { ApiResponseUtil.forbidden(res, message); };
