/**
 * Boot sequence for the API container: connect to MongoDB FIRST, run the
 * post-connect initialisation, and only THEN open the port.
 *
 * Why the order matters on Cloud Run: the TCP startup probe passes the moment
 * the port opens, and from then on an idle instance's CPU is throttled until
 * a request is in flight — startup CPU boost only covers the window before
 * the probe succeeds. app.ts used to call listen() while the Atlas handshake
 * was still in flight, so the handshake starved on a throttled CPU, the 30s
 * server-selection timer expired (late — the timer starved too) and the
 * process exited 1. Over 2026-09-02..04 roughly one cold start in six died
 * that way, and the ones that survived took a median 19s (max 124s) to
 * connect. Connecting before listening keeps boosted CPU for the whole
 * handshake, which is exactly what the realtime gateway (src/realtime.ts)
 * has always done — it never failed once on the same cluster.
 *
 * Failure stays loud: a connection that cannot be made exits 1 WITHOUT ever
 * opening the port, so the instance fails its startup probe instead of
 * accepting traffic it cannot serve. There is deliberately no retry loop —
 * with CPU allocated for the whole attempt the default 30s server selection
 * is ample, and a real Atlas outage should surface as a failed rollout, not
 * be papered over.
 */
export interface BootDeps {
  /** Opens the database connection; rejects if it cannot. */
  connect: () => Promise<unknown>;
  /**
   * Everything that needs a live connection but must be in place before
   * traffic arrives: migrations, background sweeps, the realtime emitter.
   */
  afterConnect?: () => void;
  /** Opens the port. Called only once the database is connected. */
  listen: () => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string, err: unknown) => void;
}

export async function boot(deps: BootDeps): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message));
  const error = deps.error ?? ((message: string, err: unknown) => console.error(message, err));

  try {
    await deps.connect();
  } catch (err) {
    error('❌ MongoDB connection error:', err);
    exit(1);
    return;
  }
  log('✅ Connected to MongoDB');

  try {
    deps.afterConnect?.();
  } catch (err) {
    error('❌ Post-connect initialisation failed:', err);
    exit(1);
    return;
  }

  deps.listen();
}
