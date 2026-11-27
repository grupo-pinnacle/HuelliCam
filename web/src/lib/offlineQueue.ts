import api from '../services/api';

export interface OfflineQueuedMutation {
  id: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  data?: unknown;
  createdAt: string;
  retries: number;
}

const STORAGE_KEY = 'huellicam_offline_mutation_queue';
const MAX_RETRIES = 3;

type Listener = (items: OfflineQueuedMutation[]) => void;
const listeners = new Set<Listener>();
let flushing = false;

function readQueue(): OfflineQueuedMutation[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: OfflineQueuedMutation[]): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (items.length === 0) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      }
    }
  } catch {}
  listeners.forEach((cb) => cb(items));
}

export function getOfflineQueue(): OfflineQueuedMutation[] {
  return readQueue();
}

export function enqueueOfflineMutation(
  mutation: Omit<OfflineQueuedMutation, 'id' | 'createdAt' | 'retries'>
): OfflineQueuedMutation {
  const entry: OfflineQueuedMutation = {
    ...mutation,
    id: `oq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    retries: 0,
  };
  const next = [...readQueue(), entry].slice(-30);
  writeQueue(next);
  return entry;
}

export function subscribeOfflineQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(readQueue());
  return () => {
    listeners.delete(listener);
  };
}

export async function flushOfflineQueue(): Promise<{ flushed: number; remaining: number }> {
  if (flushing) {
    return { flushed: 0, remaining: readQueue().length };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { flushed: 0, remaining: readQueue().length };
  }

  const queue = readQueue();
  if (queue.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  flushing = true;
  let flushed = 0;
  const remaining: OfflineQueuedMutation[] = [];

  try {
    for (const item of queue) {
      try {
        await api.request({
          method: item.method,
          url: item.url,
          data: item.data,
        });
        flushed += 1;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // Drop permanent 4xx errors so the queue does not stall forever
          continue;
        }
        if (item.retries + 1 < MAX_RETRIES) {
          remaining.push({ ...item, retries: item.retries + 1 });
        }
      }
    }
    writeQueue(remaining);
    return { flushed, remaining: remaining.length };
  } finally {
    flushing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushOfflineQueue();
  });
}
