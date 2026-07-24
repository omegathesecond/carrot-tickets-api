/** Refuse to process a Carrot ticket sale for an externally-sold event.
 *  Missing `ticketing` is treated as 'carrot' (legacy events). */
export function assertCarrotTicketing(event: { ticketing?: string }): void {
  if (event.ticketing && event.ticketing !== 'carrot') {
    throw new Error('This event sells tickets externally');
  }
}
