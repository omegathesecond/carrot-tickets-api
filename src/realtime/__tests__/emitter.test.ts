import { initSocketEmitter, emitToChannel, isSocketEmitterInitialized } from '../emitter';

describe('socket emitter failure containment', () => {
  it('a rejected bus insertOne is caught and logged, never an unhandled rejection', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    const fakeCollection = {
      insertOne: jest.fn().mockRejectedValue(new Error('primary stepdown')),
    };
    initSocketEmitter(fakeCollection as any);
    expect(isSocketEmitterInitialized()).toBe(true);

    expect(() => emitToChannel('abc123abc123abc123abc123', 'message:new', { id: 'x' })).not.toThrow();

    // Let the rejected insertOne promise settle through the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(fakeCollection.insertOne).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[realtime-bus] write failed'),
      expect.any(Error)
    );
    expect(unhandled).not.toHaveBeenCalled();

    process.removeListener('unhandledRejection', unhandled);
    consoleSpy.mockRestore();
  });
});
