/**
 * CORS origin matching for CORS_ORIGINS.
 *
 * Entries are comma-separated and may be either:
 *   • an exact origin        — `https://carrottickets.com`
 *   • a wildcard subdomain   — `https://*.keshless-tickets-landing.pages.dev`
 *
 * The wildcard form exists for Cloudflare Pages PREVIEW deploys, whose
 * hostname is `<branch>.<project>.pages.dev` and therefore changes with every
 * branch. Listing each one by hand meant an env edit + redeploy per branch.
 *
 * ⚠️ A wildcard is only safe when the parent domain is one WE control. On a
 * shared host like `pages.dev` anyone can obtain a subdomain, so
 * `https://*.pages.dev` would hand every Cloudflare Pages site on earth
 * authenticated access to this API. That is rejected outright — see
 * assertSafeWildcard.
 */

/** Public suffixes where a subdomain is free for anyone to claim. */
const MIN_WILDCARD_LABELS = 3; // e.g. project.pages.dev — NOT bare pages.dev

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Throws on a wildcard broad enough to be dangerous. Fail-closed at boot,
 * matching this codebase's JWT-secret precedent: a misconfigured CORS list is
 * a security hole, and starting up with it silently narrowed (or silently
 * honoured) is worse than refusing to start.
 */
export function assertSafeWildcard(pattern: string): void {
  const suffix = pattern.replace(/^[a-z]+:\/\//i, '').replace(/^\*\./, '');
  const labels = suffix.split('.').filter(Boolean);
  if (labels.length < MIN_WILDCARD_LABELS) {
    throw new Error(
      `FATAL: CORS_ORIGINS contains an unsafe wildcard "${pattern}". ` +
        `"${suffix}" is too broad — anyone can register a subdomain of it, which would ` +
        `grant every site under it access to this API. Use a project-scoped host ` +
        `(e.g. https://*.keshless-tickets-landing.pages.dev).`,
    );
  }
}

/** Does `origin` satisfy one configured pattern? */
export function matchesOrigin(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;

  // Wildcards are https-only: a preview URL is always https, and allowing
  // http:// here would let a plaintext MITM impersonate an allowed origin.
  if (!origin.startsWith('https://')) return false;

  const suffix = pattern.replace(/^https:\/\//i, '').replace(/^\*\./, '').toLowerCase();
  const host = hostOf(origin);
  if (!host) return false;

  // endsWith('.' + suffix) enforces a LABEL boundary, so
  // "evil-keshless-tickets-landing.pages.dev" does not match
  // ".keshless-tickets-landing.pages.dev". The bare apex is allowed too.
  return host === suffix || host.endsWith(`.${suffix}`);
}

export type OriginCallback = (err: Error | null, allow?: boolean) => void;
export type CorsOrigin = '*' | ((origin: string | undefined, cb: OriginCallback) => void);

/**
 * Build the value for the `cors` package's `origin` option from the raw env
 * string. Returns '*' when unset/'*' (unchanged behaviour), otherwise a
 * matcher honouring exact and wildcard entries.
 */
export function buildCorsOrigin(env: string | undefined): CorsOrigin {
  const raw = env || '*';
  if (raw === '*') return '*';

  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of patterns) if (p.includes('*')) assertSafeWildcard(p);

  return (origin, cb) => {
    // No Origin header — same-origin, curl, server-to-server. The cors package
    // asks about these too; they were always allowed under the array form.
    if (!origin) return cb(null, true);
    cb(null, patterns.some((p) => matchesOrigin(origin, p)));
  };
}
