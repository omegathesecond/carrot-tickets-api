describe('jwt.config (fail-closed)', () => {
  const ORIGINAL = process.env['JWT_SECRET'];

  afterEach(() => {
    process.env['JWT_SECRET'] = ORIGINAL;
    jest.resetModules();
  });

  it('throws at import when JWT_SECRET is missing', () => {
    delete process.env['JWT_SECRET'];
    expect(() => {
      jest.isolateModules(() => {
        require('../jwt.config');
      });
    }).toThrow(/JWT_SECRET is not set/);
  });

  it('exports the secret when set', () => {
    process.env['JWT_SECRET'] = 'abc123';
    let exported: string | undefined;
    jest.isolateModules(() => {
      exported = require('../jwt.config').JWT_SECRET;
    });
    expect(exported).toBe('abc123');
  });
});
