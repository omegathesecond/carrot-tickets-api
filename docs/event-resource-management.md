Event stalls and staff management

The event dashboard supports editing stall names/commission and staff names/phone numbers. Super Admin can delete stalls, cashiers, waiters, gate/register accounts and till operators, and reveal staff PINs.

DELETE marks the identity as deleted and inactive (stalls become suspended). Management lists exclude deleted identities. Reporting records remain intact; update and reset routes cannot reactivate a deleted identity. Deleting a stall also removes its till staff. Finish open tables and outstanding collections before deleting a stall or waiter. Resolve pending cash handovers before deleting a cashier or collector.

PINs continue to use bcrypt for login. New or reset event staff PINs also receive AES-256-GCM ciphertext bound to the account ID. Normal JSON and object serialization omit both the hash and ciphertext. A Super Admin-only POST reveal-pin endpoint returns the plaintext with Cache-Control: no-store. Hash-only PINs cannot be recovered and return 409 with an explicit one-time reset instruction. Reseller credentials are outside this event feature and retain their existing storage.

Release prerequisite: configure OPERATOR_PIN_ENCRYPTION_KEY as a base64-encoded 32-byte secret before deploying API code. The script scripts/configure-operator-pin-key.sh takes a Cloud Run service name, reads its actual runtime service account, grants that account secret access and adds the binding with --update-secrets. It preserves all existing bindings and pins the encryption secret version. Run separately for every API service receiving this code; deploy API before dashboard. Production carrot-tickets-api currently uses 659214682765-compute@developer.gserviceaccount.com (verified 2026-10-10), but the script always rechecks.

Keep the key stable and backed up in Secret Manager. Changing/deleting it without re-encrypting stored PINs makes them unreadable. Missing or malformed encryption keys fail staff creation/reset rather than silently skipping encrypted storage.
