# Backend Source (`src`)

## Overview
Application entrypoints for the Huellicam backend: Express HTTP application assembly (`app.ts`) and HTTP/Socket.IO server lifecycle management (`server.ts`), coordinating configuration, infrastructure primitives, middlewares, domain modules, realtime gateways, background jobs, and transactional email services.

## Interface
- `[app.ts:app]`: Default-exported configured Express `Application` mounting security/CORS/request-ID/rate-limit middlewares, `/api/*` domain routes, `/health`, and centralized `errorHandler`.
- `[app.ts:/api/auth/login]`, `[app.ts:/api/auth/register]`: Rate-limited auth route prefixes (`loginLimiter`, `registerLimiter`) mounted ahead of `/api/auth`.
- `[app.ts:/api/auth]`, `[app.ts:/api/pets]`, `[app.ts:/api/consultations]`, `[app.ts:/api/calls]`, `[app.ts:/api/media]`, `[app.ts:/api/notifications]`, `[app.ts:/api/admin]`, `[app.ts:/api/users]`, `[app.ts:/api]`: Mounted Express routers from [./modules/README.md](./modules/README.md).
- `[app.ts:/health]`: `GET /health` endpoint returning HTTP `200` (`status: 'ok'`) or `503` (`status: 'degraded'`) with `{ status, timestamp, uptime, database, redis }` (`redis`: `connected`, `disconnected`, `error`, or `not_configured`).
- `[server.ts:gracefulShutdown]`: Named export `gracefulShutdown(signal: string, exitCode = 0): Promise<void>` orchestrating idempotent server, Socket.IO, `vetDisconnectTracker`, Redis, and Prisma teardown.
- `[server.ts:server]`: Default-exported `http.Server` instance created by `app.listen(PORT, ...)`.
- Config: [./config/README.md](./config/README.md) - Environment validation, pooled database URL builder, and CORS origin allowlist.
- Jobs: [./jobs/README.md](./jobs/README.md) - Hourly background email reminder scheduler (`notificationsScheduler`).
- Lib: [./lib/README.md](./lib/README.md) - Pino logging with `AsyncLocalStorage` context, Prisma client singleton, and ioredis client lifecycle helpers.
- Middlewares: [./middlewares/README.md](./middlewares/README.md) - Correlation/request ID propagation, endpoint rate limiters, and centralized `errorHandler`.
- Modules: [./modules/README.md](./modules/README.md) - Feature modules (`admin`, `auth`, `calls`, `consultations`, `media`, `notifications`, `pets`, `prescriptions`, `users`).
- Realtime: [./realtime/README.md](./realtime/README.md) - Socket.IO server bootstrap, auth/rate-limit middlewares, session eviction helper, presence service, `vetDisconnectTracker`, and chat gateway.
- Services: [./services/README.md](./services/README.md) - Transactional email delivery (`emailService`).

## Invariants
- `[app.ts:trust proxy]`: `app.set('trust proxy', 1)` trusts the first reverse proxy hop for secure cookies and client IP resolution.
- `[app.ts:requestIdMiddleware]`: `requestIdMiddleware` runs before all other middlewares and routes (including CORS preflight, 413 checks, and webhooks).
- `[app.ts:helmet]`: Content Security Policy restricts `defaultSrc` to `'self'`, `connectSrc` to `'self'`, `wss:`, `ws:`, `*.livekit.cloud`, `https://*.livekit.cloud`, `scriptSrc`/`styleSrc` to `'self'` and `'unsafe-inline'`, and `imgSrc` to `'self'`, `data:`, `blob:`.
- `[app.ts:cors]`: Permits requests without an `Origin` header (`!origin`) or where `isAllowedOrigin(origin)` is true (with `credentials: true` and explicit `methods`/`allowedHeaders`), rejecting disallowed origins with `callback(null, false)`.
- `[app.ts:/api/calls/webhook]`: `express.raw({ type: '*/*', limit: '100kb' })` is mounted before `express.json()` so raw request bytes remain intact for LiveKit HMAC SHA256 verification.
- `[app.ts:express.json]`: Body parsers (`express.raw`, `express.json`, `express.urlencoded`) enforce a `100kb` payload size limit.
- `[app.ts:loginLimiter]`, `[app.ts:registerLimiter]`: Limit `/api/auth/login` to `200` requests per `15` minutes and `/api/auth/register` to `100` requests per `15` minutes (`TOO_MANY_REQUESTS`), skipped when `NODE_ENV === 'test' || NODE_ENV === 'development'`.
- `[app.ts:/health]`: Skips the database and Redis probes in `NODE_ENV === 'test'` (`database: 'connected'`, `redis: 'not_configured'`, `uptime: 100`); otherwise runs ``prisma.$queryRaw`SELECT 1` `` and, when `REDIS_URL` is set, a 1.5 s `PING` on the shared Redis client. Returns `200` iff the database is connected and, in `production`, Redis answers `PONG`; else `503`.
- `[app.ts:errorHandler]`: Centralized `errorHandler` is mounted last after all routes and `/health`.
- `[server.ts:PORT]`: Listening port resolves via `config.PORT || process.env.PORT || 3001`.
- `[server.ts:isShuttingDown]`: `gracefulShutdown` is idempotent via `if (isShuttingDown) return; isShuttingDown = true`.
- `[server.ts:redisReadyPromise]`: Rejection of `whenSocketRedisReady()` triggers `gracefulShutdown('REDIS_CONNECTION_FAILED', 1)` only when `(process.env.NODE_ENV || config.NODE_ENV) === 'production'`.
- `[server.ts:gracefulShutdown]`: Enforces a `10000` ms `forceExitTimeout` (`process.exit(1)`) and orders teardown strictly: (1) `io.close` (ignoring `ERR_SERVER_NOT_RUNNING`), (2) `server.close` when `server.listening`, (3) `vetDisconnectTracker.clear()`, (4) `closeAllRedisClients()`, (5) `prisma.$disconnect()`, calling `process.exit` only when `process.env.NODE_ENV !== 'test'`.

## Side Effects
- `[app.ts:env]`: Executes `import './config/env'` side-effect initialization at module load.
- `[app.ts:/health]`: Queries PostgreSQL (``prisma.$queryRaw`SELECT 1` ``) outside `NODE_ENV === 'test'`.
- `[server.ts:server]`: Binds an HTTP listener on `PORT` via `app.listen` at module load and logs startup via `logger.info`.
- `[server.ts:notificationsScheduler]`: Starts `notificationsScheduler.start()` inside the `app.listen` callback when `process.env.NODE_ENV !== 'test'`.
- `[server.ts:vetDisconnectTracker]`: Starts `vetDisconnectTracker.start()` inside the `app.listen` callback when `process.env.NODE_ENV !== 'test'`.
- `[server.ts:io]`: Initializes Socket.IO via `initializeSocketServer(server)` and tracks `whenSocketRedisReady()` at module load.
- `[server.ts:redisReadyPromise]`: Logs via `logger.fatal` and calls `gracefulShutdown('REDIS_CONNECTION_FAILED', 1)` if `whenSocketRedisReady()` rejects in `production`.
- `[server.ts:SIGTERM]`, `[server.ts:SIGINT]`: Registers `SIGTERM` and `SIGINT` process signal handlers at module load.
- `[server.ts:gracefulShutdown]`: Schedules a `10000` ms force-exit timer, clears `vetDisconnectTracker`, closes `io` and HTTP `server`, closes all Redis clients, disconnects Prisma, logs via `logger`, and invokes `process.exit` outside `test`.

## Verification
- Run: `npm test -w backend`
