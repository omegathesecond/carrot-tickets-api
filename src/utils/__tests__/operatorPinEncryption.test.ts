import { encryptOperatorPin, decryptOperatorPin } from '../operatorPinEncryption.util';

it('encrypts with a fresh nonce and binds the PIN to one account', () => {
  const encrypted = encryptOperatorPin('012345', 'a');
  expect(encrypted).not.toContain('012345');
  expect(encryptOperatorPin('012345', 'a')).not.toBe(encrypted);
  expect(decryptOperatorPin(encrypted, 'a')).toBe('012345');
  expect(() => decryptOperatorPin(encrypted, 'b')).toThrow();
  const tampered = Buffer.from(encrypted, 'base64');
  tampered[tampered.length - 1]! ^= 1;
  expect(() => decryptOperatorPin(tampered.toString('base64'), 'a')).toThrow();
});

it('refuses saving credentials without a valid encryption key', () => {
  const existing = process.env['OPERATOR_PIN_ENCRYPTION_KEY'];
  try {
    delete process.env['OPERATOR_PIN_ENCRYPTION_KEY'];
    expect(() => encryptOperatorPin('012345', 'a')).toThrow(/OPERATOR_PIN_ENCRYPTION_KEY/);
  } finally { process.env['OPERATOR_PIN_ENCRYPTION_KEY'] = existing; }
});
