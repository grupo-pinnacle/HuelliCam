import { DisconnectQueue } from '../realtime/disconnectQueue';

describe('DisconnectQueue (Debounced Disconnect Processing)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('debounces disconnect execution until DISCONNECT_DEBOUNCE_MS elapses', async () => {
    const onDisconnect = jest.fn().mockResolvedValue({ updated: true, rowCount: 1 });
    const queue = new DisconnectQueue({ debounceMs: 5000, onDisconnect });

    queue.enqueue('tutor-1', 'dev-1');
    expect(queue.pendingCount).toBe(1);

    await jest.advanceTimersByTimeAsync(4999);
    expect(onDisconnect).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('tutor-1', 'dev-1');
    expect(queue.pendingCount).toBe(0);
  });

  it('coalesces duplicate (tutorId, deviceId) enqueues and resets the debounce timer', async () => {
    const onDisconnect = jest.fn().mockResolvedValue({ updated: true, rowCount: 1 });
    const queue = new DisconnectQueue({ debounceMs: 5000, onDisconnect });

    queue.enqueue('tutor-1', 'dev-1');
    await jest.advanceTimersByTimeAsync(2000);
    queue.enqueue('tutor-1', 'dev-1');
    await jest.advanceTimersByTimeAsync(2000);
    queue.enqueue('tutor-1', 'dev-1');

    expect(queue.pendingCount).toBe(1);
    await jest.advanceTimersByTimeAsync(4999);
    expect(onDisconnect).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('tutor-1', 'dev-1');

    // Distinct keys remain independent
    queue.enqueue('tutor-1', 'dev-2');
    queue.enqueue('tutor-2', 'dev-1');
    expect(queue.pendingCount).toBe(2);
    queue.clear();
  });

  it('cancels pending disconnect when tutor reconnects within debounce window', async () => {
    const onDisconnect = jest.fn().mockResolvedValue({ updated: true, rowCount: 1 });
    const queue = new DisconnectQueue({ debounceMs: 5000, onDisconnect });

    queue.enqueue('tutor-1', 'dev-1');
    await jest.advanceTimersByTimeAsync(2000);

    expect(queue.cancel('tutor-1', 'dev-1')).toBe(true);
    expect(queue.pendingCount).toBe(0);
    expect(queue.cancel('tutor-1', 'dev-1')).toBe(false);

    await jest.advanceTimersByTimeAsync(10000);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('handles mass disconnects without blocking and bounds in-flight concurrency', async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    const onDisconnect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          if (active > peak) peak = active;
          resolvers.push(() => {
            active -= 1;
            resolve();
          });
        })
    );

    const queue = new DisconnectQueue({
      debounceMs: 5000,
      maxConcurrency: 10,
      onDisconnect,
    });

    const total = 1000;
    const start = Date.now();
    for (let i = 0; i < total; i++) {
      queue.enqueue(`tutor-${i}`, `dev-${i}`);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(queue.pendingCount).toBe(total);

    await jest.advanceTimersByTimeAsync(5000);

    // Only maxConcurrency (10) should be in-flight at once
    expect(onDisconnect).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(10);

    // Cancel an item waiting in the bounded execution queue before its slot opens
    expect(queue.cancel('tutor-999', 'dev-999')).toBe(true);

    while (resolvers.length > 0) {
      const resolveNext = resolvers.shift()!;
      resolveNext();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(onDisconnect).toHaveBeenCalledTimes(total - 1);
    expect(queue.pendingCount).toBe(0);
  });

  it('flushAll() immediately executes pending disconnects and clears timers', async () => {
    const onDisconnect = jest.fn().mockResolvedValue({ updated: true, rowCount: 1 });
    const queue = new DisconnectQueue({ debounceMs: 5000, onDisconnect });

    queue.enqueue('tutor-1', 'dev-1');
    queue.enqueue('tutor-2', 'dev-2');
    queue.enqueue('tutor-3', 'dev-3');

    await queue.flushAll();

    expect(onDisconnect).toHaveBeenCalledTimes(3);
    expect(queue.pendingCount).toBe(0);

    await jest.advanceTimersByTimeAsync(10000);
    expect(onDisconnect).toHaveBeenCalledTimes(3);
  });

  it('clear() discards pending disconnects without invoking onDisconnect', async () => {
    const onDisconnect = jest.fn().mockResolvedValue({ updated: true, rowCount: 1 });
    const queue = new DisconnectQueue({ debounceMs: 5000, onDisconnect });

    queue.enqueue('tutor-1', 'dev-1');
    queue.enqueue('tutor-2', 'dev-2');
    queue.clear();

    expect(queue.pendingCount).toBe(0);
    await jest.advanceTimersByTimeAsync(10000);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('isolates handler rejections so remaining disconnects and flushAll() still settle', async () => {
    const onError = jest.fn();
    const onDisconnect = jest.fn(async (tutorId: string) => {
      if (tutorId === 'tutor-err') {
        throw new Error('DB transient error');
      }
      return { updated: true, rowCount: 1 };
    });

    const queue = new DisconnectQueue({
      debounceMs: 5000,
      onDisconnect,
      onError,
    });

    queue.enqueue('tutor-err', 'dev-1');
    queue.enqueue('tutor-ok', 'dev-2');

    await expect(queue.flushAll()).resolves.toBeUndefined();
    expect(onDisconnect).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'tutor-err', 'dev-1');
  });

  it('calls timer.unref() on scheduled debounce timers', () => {
    const unrefSpy = jest.fn();
    const fakeTimer = { unref: unrefSpy } as unknown as NodeJS.Timeout;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockReturnValue(fakeTimer);
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout').mockImplementation(() => {});

    try {
      const queue = new DisconnectQueue({
        debounceMs: 5000,
        onDisconnect: jest.fn().mockResolvedValue(undefined),
      });
      queue.enqueue('tutor-1', 'dev-1');

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
      queue.clear();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('flushAll() waits until all waitingQueue items (> maxConcurrency expired timers) complete when pending is empty', async () => {
    const resolvers: Array<() => void> = [];
    let completed = 0;

    const onDisconnect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(() => {
            completed += 1;
            resolve();
          });
        })
    );

    const queue = new DisconnectQueue({
      debounceMs: 20,
      maxConcurrency: 5,
      onDisconnect,
    });

    const total = 25;
    for (let i = 0; i < total; i++) {
      queue.enqueue(`tutor-wq-${i}`, `dev-wq-${i}`);
    }

    // Expire all debounce timers so 5 are inFlight and 20 sit in waitingQueue (pending is empty)
    await jest.advanceTimersByTimeAsync(20);
    expect(onDisconnect).toHaveBeenCalledTimes(5);
    expect(queue.pendingCount).toBe(20);

    let flushed = false;
    const flushPromise = queue.flushAll().then(() => {
      flushed = true;
    });

    // Resolve batch by batch; flushAll() must NOT resolve early
    for (let batch = 0; batch < 4; batch++) {
      expect(resolvers.length).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < 5; i++) {
        resolvers.shift()!();
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(flushed).toBe(false);
    }

    // Resolve final batch (items 21..25)
    while (!flushed) {
      if (resolvers.length > 0) {
        resolvers.shift()!();
      }
      await Promise.resolve();
    }

    await flushPromise;
    expect(flushed).toBe(true);
    expect(completed).toBe(total);
    expect(queue.pendingCount).toBe(0);
  });

  it('concurrent flushAll() calls all wait until 100% of queued items finish', async () => {
    const resolvers: Array<() => void> = [];
    let completed = 0;

    const onDisconnect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(() => {
            completed += 1;
            resolve();
          });
        })
    );

    const queue = new DisconnectQueue({
      debounceMs: 5000,
      maxConcurrency: 5,
      onDisconnect,
    });

    const total = 20;
    for (let i = 0; i < total; i++) {
      queue.enqueue(`tutor-cc-${i}`, `dev-cc-${i}`);
    }

    let resolved1At: number | null = null;
    let resolved2At: number | null = null;
    let bothSettled = false;
    const p1 = queue.flushAll().then(() => {
      resolved1At = completed;
    });
    const p2 = queue.flushAll().then(() => {
      resolved2At = completed;
    });
    const allDone = Promise.all([p1, p2]).then(() => {
      bothSettled = true;
    });

    while (!bothSettled) {
      if (resolvers.length > 0) {
        resolvers.shift()!();
      }
      await Promise.resolve();
      await Promise.resolve();
    }

    await allDone;
    expect(resolved1At).toBe(total);
    expect(resolved2At).toBe(total);
    expect(queue.pendingCount).toBe(0);
  });
});
