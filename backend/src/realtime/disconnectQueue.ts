import { config } from '../config/env';
import { consultationConcurrencyService } from '../modules/consultations/consultationConcurrency.service';
import { logger, serializeError } from '../lib/logger';

export type DisconnectHandler = (tutorId: string, deviceId: string) => Promise<unknown>;

export interface DisconnectQueueOptions {
  debounceMs?: number;
  maxConcurrency?: number;
  onDisconnect?: DisconnectHandler;
  onError?: (err: unknown, tutorId: string, deviceId: string) => void;
}

interface PendingDisconnectEntry {
  tutorId: string;
  deviceId: string;
  timer: NodeJS.Timeout;
}

interface QueuedExecutionTask {
  key: string;
  tutorId: string;
  deviceId: string;
  resolve: () => void;
}

export class DisconnectQueue {
  private readonly debounceMs: number;
  private readonly maxConcurrency: number;
  private readonly onDisconnect: DisconnectHandler;
  private readonly onError: (err: unknown, tutorId: string, deviceId: string) => void;

  private readonly pending = new Map<string, PendingDisconnectEntry>();
  private readonly waitingQueue: QueuedExecutionTask[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private activeCount = 0;

  constructor(options: DisconnectQueueOptions = {}) {
    const rawDebounce = options.debounceMs ?? config.DISCONNECT_DEBOUNCE_MS;
    this.debounceMs = Number.isFinite(rawDebounce) && rawDebounce >= 0 ? rawDebounce : 5000;

    const rawConcurrency = options.maxConcurrency ?? 10;
    this.maxConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 10;

    this.onDisconnect =
      options.onDisconnect ??
      ((tutorId, deviceId) => consultationConcurrencyService.markSocketDisconnect(tutorId, deviceId));

    this.onError =
      options.onError ??
      ((err, tutorId, deviceId) => {
        logger.warn(
          { tutorId, deviceId, err: serializeError(err) },
          'DisconnectQueue failed markSocketDisconnect'
        );
      });
  }

  public get pendingCount(): number {
    return this.pending.size + this.waitingQueue.length;
  }

  public enqueue(tutorId: string, deviceId: string): void {
    if (!tutorId || !deviceId) return;

    const key = `${tutorId}:${deviceId}`;

    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(key);
    }

    this.removeFromWaitingQueue(key);

    const timer = setTimeout(() => {
      const current = this.pending.get(key);
      if (!current || current.timer !== timer) {
        return;
      }
      this.pending.delete(key);
      void this.submitExecution(key, tutorId, deviceId);
    }, this.debounceMs);

    timer.unref?.();

    this.pending.set(key, { tutorId, deviceId, timer });
  }

  public cancel(tutorId: string, deviceId: string): boolean {
    if (!tutorId || !deviceId) return false;

    const key = `${tutorId}:${deviceId}`;
    let cancelled = false;

    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(key);
      cancelled = true;
    }

    if (this.removeFromWaitingQueue(key)) {
      cancelled = true;
    }

    return cancelled;
  }

  public async flushAll(): Promise<void> {
    const snapshotted = Array.from(this.pending.values());
    for (const entry of snapshotted) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();

    const flushPromises = snapshotted.map((entry) =>
      this.submitExecution(`${entry.tutorId}:${entry.deviceId}`, entry.tutorId, entry.deviceId)
    );

    await Promise.allSettled(flushPromises);

    while (this.inFlight.size > 0 || this.waitingQueue.length > 0) {
      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight));
      } else {
        this.drainQueue();
        if (this.inFlight.size === 0 && this.waitingQueue.length > 0) {
          await Promise.resolve();
        }
      }
    }
  }

  public clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();

    while (this.waitingQueue.length > 0) {
      const task = this.waitingQueue.shift();
      task?.resolve();
    }
  }

  private removeFromWaitingQueue(key: string): boolean {
    let removed = false;
    for (let i = this.waitingQueue.length - 1; i >= 0; i--) {
      if (this.waitingQueue[i].key === key) {
        const [task] = this.waitingQueue.splice(i, 1);
        task.resolve();
        removed = true;
      }
    }
    return removed;
  }

  private submitExecution(key: string, tutorId: string, deviceId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitingQueue.push({ key, tutorId, deviceId, resolve });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    while (this.activeCount < this.maxConcurrency && this.waitingQueue.length > 0) {
      const task = this.waitingQueue.shift();
      if (!task) break;

      this.activeCount += 1;
      let runPromise: Promise<void> | undefined;
      let completedSync = false;
      runPromise = (async () => {
        try {
          await this.onDisconnect(task.tutorId, task.deviceId);
        } catch (err) {
          try {
            this.onError(err, task.tutorId, task.deviceId);
          } catch {
            // Isolate logger errors
          }
        } finally {
          this.activeCount -= 1;
          completedSync = true;
          if (runPromise) {
            this.inFlight.delete(runPromise);
          }
          task.resolve();
          this.drainQueue();
        }
      })();

      if (!completedSync) {
        this.inFlight.add(runPromise);
      }
    }
  }
}

export const disconnectQueue = new DisconnectQueue();
