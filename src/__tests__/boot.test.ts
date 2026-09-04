import { boot } from '../boot';

/**
 * Boot ordering on Cloud Run.
 *
 * The container must NOT open its port until MongoDB is connected. Cloud Run
 * marks the container started the moment the TCP startup probe sees the port,
 * and from then on an idle instance's CPU is throttled until a request is in
 * flight. Listening before the Atlas handshake had finished therefore left
 * the handshake starving on a throttled CPU, the 30s server-selection timer
 * expired (late, because the timer starved too) and the process exited 1 —
 * on ~1 in 6 cold starts over the two days before this was fixed.
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('boot', () => {
  it('does not listen until the database connection has resolved', async () => {
    const connection = deferred();
    const connect = jest.fn(() => connection.promise);
    const listen = jest.fn();
    const exit = jest.fn();

    const done = boot({ connect, listen, exit, log: () => {}, error: () => {} });
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();

    connection.resolve();
    await done;

    expect(listen).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('runs the post-connect initialisation before opening the port', async () => {
    const order: string[] = [];
    await boot({
      connect: async () => { order.push('connect'); },
      afterConnect: () => { order.push('afterConnect'); },
      listen: () => { order.push('listen'); },
      exit: () => { order.push('exit'); },
      log: () => {},
      error: () => {},
    });

    expect(order).toEqual(['connect', 'afterConnect', 'listen']);
  });

  it('never listens and exits 1 when the connection fails — a port with no database behind it must not pass the probe', async () => {
    const boom = new Error('Server selection timed out after 30000 ms');
    const listen = jest.fn();
    const exit = jest.fn();
    const error = jest.fn();

    await boot({ connect: () => Promise.reject(boom), listen, exit, log: () => {}, error });

    expect(listen).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('MongoDB connection error'), boom);
  });

  it('a failure inside post-connect initialisation is fatal too, not silently skipped', async () => {
    const listen = jest.fn();
    const exit = jest.fn();

    await boot({
      connect: async () => {},
      afterConnect: () => { throw new Error('init exploded'); },
      listen,
      exit,
      log: () => {},
      error: () => {},
    });

    expect(listen).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
