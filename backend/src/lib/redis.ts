import net from 'net';
import type { ConnectionOptions } from 'tls';
import Redis, { RedisOptions } from 'ioredis';

export const DEFAULT_REDIS_RETRY_BASE_MS = 100;
export const DEFAULT_REDIS_RETRY_MAX_MS = 10_000;
export const DEFAULT_REDIS_RETRY_JITTER_MS = 100;
export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5000;

export interface RedisRetryStrategyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  jitterMs?: number;
}

const trackedRedisClients = new Set<Redis>();
let sharedRedisClient: Redis | null = null;
let pendingSharedClient: Redis | null = null;
let sharedInitGeneration = 0;

export function normalizeRedisUrl(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'undefined' || lower === 'null') {
    return undefined;
  }
  return trimmed;
}

export function isValidRedisUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'redis:' || parsed.protocol === 'rediss:';
  } catch {
    return false;
  }
}

export function createRedisRetryStrategy(
  opts: RedisRetryStrategyOptions = {}
): (times: number) => number | null {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_REDIS_RETRY_BASE_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_REDIS_RETRY_MAX_MS;
  const jitterMs = opts.jitterMs ?? DEFAULT_REDIS_RETRY_JITTER_MS;
  const maxRetries = opts.maxRetries;

  return (times: number): number | null => {
    if (maxRetries !== undefined && times > maxRetries) {
      return null;
    }
    const expDelay = Math.min(baseDelayMs * Math.pow(2, Math.max(0, times - 1)), maxDelayMs);
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return Math.min(expDelay + jitter, maxDelayMs);
  };
}

export function buildRedisOptions(url: string, overrides: RedisOptions = {}): RedisOptions {
  const normalized = normalizeRedisUrl(url);
  if (!normalized || !isValidRedisUrl(normalized)) {
    throw new Error('Invalid REDIS_URL: expected redis:// or rediss:// URL');
  }

  const parsed = new URL(normalized);
  const isTls = parsed.protocol === 'rediss:';
  const bareHostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const defaultTlsOptions: ConnectionOptions | undefined = isTls
    ? net.isIP(bareHostname)
      ? {}
      : { servername: bareHostname }
    : undefined;

  const baseOptions: RedisOptions = {
    lazyConnect: true,
    connectTimeout: DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    retryStrategy: createRedisRetryStrategy(),
  };

  const merged: RedisOptions = {
    ...baseOptions,
    ...overrides,
  };

  if (isTls) {
    merged.tls = overrides.tls ?? defaultTlsOptions;
  }

  return merged;
}

export function createRedisClient(url: string, options: RedisOptions = {}): Redis {
  const normalized = normalizeRedisUrl(url);
  if (!normalized || !isValidRedisUrl(normalized)) {
    throw new Error('Invalid REDIS_URL: expected redis:// or rediss:// URL');
  }

  const client = new Redis(normalized, buildRedisOptions(normalized, options));

  // Prevent unhandled 'error' event crashes during background reconnect attempts
  client.on('error', () => {});

  trackedRedisClients.add(client);
  client.once('end', () => {
    trackedRedisClients.delete(client);
    if (sharedRedisClient === client) {
      sharedRedisClient = null;
    }
  });

  return client;
}

export function getRedisClient(): Redis | null {
  return sharedRedisClient;
}

export function setSharedRedisClient(client: Redis | null): void {
  sharedRedisClient = client;
}

export async function initializeSharedRedisClient(
  rawUrl?: string | null,
  options: RedisOptions = {}
): Promise<Redis | null> {
  const myGeneration = ++sharedInitGeneration;
  const normalized = normalizeRedisUrl(rawUrl);

  if (pendingSharedClient) {
    const stalePending = pendingSharedClient;
    pendingSharedClient = null;
    await closeRedisClient(stalePending);
  }

  if (sharedRedisClient) {
    const prev = sharedRedisClient;
    sharedRedisClient = null;
    await closeRedisClient(prev);
  }

  if (!normalized || myGeneration !== sharedInitGeneration) {
    return null;
  }

  const client = createRedisClient(normalized, options);
  pendingSharedClient = client;
  try {
    await client.connect();
    if (pendingSharedClient === client) {
      pendingSharedClient = null;
    }
    if (myGeneration !== sharedInitGeneration) {
      await closeRedisClient(client);
      return null;
    }
    sharedRedisClient = client;
    return client;
  } catch (err) {
    if (pendingSharedClient === client) {
      pendingSharedClient = null;
    }
    await closeRedisClient(client);
    if (sharedRedisClient === client) {
      sharedRedisClient = null;
    }
    if (myGeneration !== sharedInitGeneration) {
      return null;
    }
    throw err;
  }
}

export async function closeRedisClient(
  client?: Redis | null,
  timeoutMs = 1500
): Promise<void> {
  if (!client) {
    return;
  }

  if (sharedRedisClient === client) {
    sharedRedisClient = null;
  }
  if (pendingSharedClient === client) {
    pendingSharedClient = null;
  }
  trackedRedisClients.delete(client);

  if (client.status === 'end') {
    return;
  }

  if (client.status === 'ready' || client.status === 'connect') {
    let timer: NodeJS.Timeout | undefined;
    try {
      if (typeof client.quit === 'function') {
        await Promise.race([
          Promise.resolve(client.quit()).catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref();
          }),
        ]);
      }
    } catch {
      // Ignore synchronous quit() errors; disconnect(false) runs in finally
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if ((client.status as string) !== 'end' && typeof client.disconnect === 'function') {
        try {
          client.disconnect(false);
        } catch {
          // Ignore disconnect errors on already-closed client
        }
      }
    }
    return;
  }

  if (typeof client.disconnect === 'function') {
    try {
      client.disconnect(false);
    } catch {
      // Ignore disconnect errors on non-ready client
    }
  }
}

export async function resetSharedRedisClient(timeoutMs = 1500): Promise<void> {
  sharedInitGeneration++;
  const current = sharedRedisClient;
  const pending = pendingSharedClient;
  sharedRedisClient = null;
  pendingSharedClient = null;
  await Promise.allSettled([
    current ? closeRedisClient(current, timeoutMs) : Promise.resolve(),
    pending && pending !== current ? closeRedisClient(pending, timeoutMs) : Promise.resolve(),
  ]);
}

export async function closeAllRedisClients(timeoutMs = 1500): Promise<void> {
  sharedInitGeneration++;
  const clients = Array.from(trackedRedisClients);
  sharedRedisClient = null;
  pendingSharedClient = null;
  await Promise.allSettled(clients.map((client) => closeRedisClient(client, timeoutMs)));
}

export function getTrackedRedisClientCount(): number {
  return trackedRedisClients.size;
}
