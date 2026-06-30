/**
 * Centralised signing-secret loader — the single source of truth for JWT secrets.
 *
 * Secrets have NO insecure default. If a required secret is not provided by the
 * environment the process refuses to start, rather than silently falling back to
 * a publicly-known literal (e.g. the old `'your-secret-key'`) that would let
 * anyone forge vendor / super-admin / buyer / reseller / gate-operator tokens.
 *
 * In the test environment a fixed, clearly-non-production value is used so the
 * suite is deterministic without real secrets. `src/__tests__/jest.setup.ts`
 * sets the same value on `process.env` before any module loads, so app code and
 * test helpers always agree on the secret.
 */

const isTest = process.env['NODE_ENV'] === 'test';

/**
 * Read a required secret from the environment. Throws (fail-closed) in any
 * non-test environment when the variable is unset or blank.
 */
function requireSecret(name: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) {
    return value;
  }

  if (isTest) {
    // Deterministic, obviously-fake value for the test suite only.
    return `test-${name}`;
  }

  throw new Error(
    `[secrets] ${name} is not set. Refusing to start: a signing secret MUST be ` +
      `provided via the environment — no insecure default is permitted.`
  );
}

/** The one secret every token type (vendor, sub-user, buyer, reseller, gate-operator) is signed and verified with. */
export const JWT_SECRET: string = requireSecret('JWT_SECRET');
