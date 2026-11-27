# lib

## Overview
Houses shared infrastructure primitives for structured Pino logging with `AsyncLocalStorage` request context, Prisma client initialization with pooled URLs, and ioredis client lifecycle management.

## Interface
- `[logger.ts:RequestLogContext]` - Interface `{ requestId?: string; correlationId?: string; userId?: string; socketId?: string }`.
- `[logger.ts:sanitizeCorrelationId]` - `(raw: unknown) => string | undefined` validating IDs against `/^[A-Za-z0-9._:-]{1,128}$/`.
- `[logger.ts:resolveOrCreateCorrelationId]` - `(raw?: unknown) => string` returning a sanitized ID or `crypto.randomUUID()`.
- `[logger.ts:runWithLogContext]` - `<T>(context: RequestLogContext, fn: () => T) => T` running within merged `AsyncLocalStorage` context.
- `[logger.ts:getLogContext]` - `() => RequestLogContext | undefined` retrieving the current async log context.
- `[logger.ts:updateLogContext]` - `(patch: Partial<RequestLogContext>) => void` updating the active context store.
- `[logger.ts:logger]` - Pino `Logger` writing to stdout (`fd: 1`) with secret redaction and context mixin.
- `[logger.ts:stderrLogger]` - Synchronous Pino `Logger` writing to stderr (`fd: 2`).
- `[logger.ts:createChildLogger]` - `(bindings: Record<string, unknown>) => Logger` creating a child logger.
- `[logger.ts:serializeError]` - `(err: unknown) => Record<string, unknown>` extracting error fields and stack traces.
- `[logger.ts:default]` - Default export of `logger`.
- `[prisma.ts:prismaDatabaseUrl]` - Pooled database URL returned by `buildPooledDatabaseUrl(config.DATABASE_URL)`.
- `[prisma.ts:createPrismaClient]` - `(databaseUrl?: string) => PrismaClient` factory with environment-scoped logging.
- `[prisma.ts:prisma]` - Singleton `PrismaClient` instance (also exported as `default`).
- `[redis.ts:DEFAULT_REDIS_RETRY_BASE_MS]` - Default base retry delay (`100`).
- `[redis.ts:DEFAULT_REDIS_RETRY_MAX_MS]` - Default max retry delay (`10_000`).
- `[redis.ts:DEFAULT_REDIS_RETRY_JITTER_MS]` - Default retry jitter (`100`).
- `[redis.ts:DEFAULT_REDIS_CONNECT_TIMEOUT_MS]` - Default connect timeout (`5000`).
- `[redis.ts:RedisRetryStrategyOptions]` - Retry configuration interface.
- `[redis.ts:normalizeRedisUrl]` - `(raw?: string | null) => string | undefined` stripping whitespace/quotes and blank/nullish strings.
- `[redis.ts:isValidRedisUrl]` - `(raw: string) => boolean` validating `redis:` or `rediss:` protocols.
- `[redis.ts:createRedisRetryStrategy]` - `(opts?: RedisRetryStrategyOptions) => (times: number) => number | null` exponential backoff with jitter.
- `[redis.ts:buildRedisOptions]` - `(url: string, overrides?: RedisOptions) => RedisOptions` configuring `lazyConnect`, timeouts, retry strategy, and TLS SNI.
- `[redis.ts:createRedisClient]` - `(url: string, options?: RedisOptions) => Redis` creating and tracking an `ioredis` client.
- `[redis.ts:getRedisClient]` - `() => Redis | null` returning the shared Redis client.
- `[redis.ts:setSharedRedisClient]` - `(client: Redis | null) => void` assigning the shared Redis client.
- `[redis.ts:initializeSharedRedisClient]` - `(rawUrl?: string | null, options?: RedisOptions) => Promise<Redis | null>` connecting the shared client safely across concurrent calls.
- `[redis.ts:closeRedisClient]` - `(client?: Redis | null, timeoutMs?: number) => Promise<void>` quitting/disconnecting a client.
- `[redis.ts:resetSharedRedisClient]` - `(timeoutMs?: number) => Promise<void>` closing active/pending shared clients.
- `[redis.ts:closeAllRedisClients]` - `(timeoutMs?: number) => Promise<void>` closing all tracked clients.
- `[redis.ts:getTrackedRedisClientCount]` - `() => number` returning `trackedRedisClients.size`.

## Invariants
- `[logger.ts:sanitizeCorrelationId]` - Accepts only `/^[A-Za-z0-9._:-]{1,128}$/`; `REDACT_PATHS` redacts passwords, tokens, authorization headers, cookies, OTPs, and secrets with `'[REDACTED]'`.
- `[prisma.ts:prisma]` - Reuses `globalThis.prisma` when `config.NODE_ENV !== 'production'` to prevent duplicate connection pools during reloads.
- `[redis.ts:buildRedisOptions]` - Throws on invalid Redis URLs (`redis://` or `rediss://` required); sets `tls.servername` automatically for non-IP `rediss://` hosts.
- `[redis.ts:createRedisClient]` - Registers a no-op `'error'` listener so unhandled error events do not crash the process.
- `[redis.ts:initializeSharedRedisClient]` - Increments `sharedInitGeneration` to discard stale concurrent initializations and close superseded clients.

## Side Effects
- `[logger.ts:logger]` - Writes structured JSON logs to stdout (`fd: 1`) and `stderrLogger` writes synchronously to stderr (`fd: 2`); mutates `AsyncLocalStorage` context stores.
- `[prisma.ts:globalForPrisma]` - Mutates `globalThis.prisma` outside `production` and instantiates `PrismaClient`.
- `[redis.ts:initializeSharedRedisClient]` - Opens/closes Redis TCP/TLS sockets, attaches `error`/`end` listeners, mutates `sharedRedisClient`, `pendingSharedClient`, `sharedInitGeneration`, and `trackedRedisClients`, and allocates unref'd timers in `closeRedisClient`.

## Verification
- Run: `npm test -w backend`
