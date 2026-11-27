# Huellicam Backend Blueprint

## System Overview
Node.js / Express 5 / TypeScript backend powering the Huellicam veterinary telemedicine platform. Combines REST API domain modules, Prisma ORM over PostgreSQL, Socket.IO realtime signaling and presence backed by Redis, LiveKit video consultation room and webhook handling, Resend transactional email scheduling, and local/AWS S3 media storage.

## Subdirectories & System Boundaries
- Prisma: [./prisma/README.md](./prisma/README.md) - PostgreSQL schema (4 enums, 15 models), ordered SQL migrations (`./prisma/migrations/README.md`), and development seed script.
- Source: [./src/README.md](./src/README.md) - Express application wiring (`app.ts`), HTTP/Socket.IO server lifecycle (`server.ts`), configuration (`./src/config/README.md`), background jobs (`./src/jobs/README.md`), core singletons (`./src/lib/README.md`), middlewares (`./src/middlewares/README.md`), domain modules (`./src/modules/README.md`), realtime subsystem (`./src/realtime/README.md`), and transactional email service (`./src/services/README.md`).

## Global Invariants
- `[src/config/env.ts:envSchema]`: Runtime configuration requires `JWT_SECRET` and `JWT_REFRESH_SECRET` >= 32 characters, `DATABASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`, plus a valid `redis://` or `rediss://` `REDIS_URL` in `production` (halting non-test startup via `process.exit(1)` on invalid config).
- `[src/modules/auth/auth.middleware.ts:authenticate]`, `[src/realtime/socket.auth.middleware.ts:socketAuthMiddleware]`: Both HTTP and Socket.IO authentication verify HS256 JWTs against `config.JWT_SECRET`, reject soft-deleted users (`deletedAt !== null`), and enforce single-session/revocation consistency via `user.tokenVersion`.
- `[src/realtime/socket.server.ts:initializeSocketServer]`, `[src/realtime/presence.service.ts:PresenceService]`, `[src/server.ts:redisReadyPromise]`: In `production`, Redis is mandatory for Socket.IO adapter and distributed presence (`InMemoryAdapter` fallback disabled), and Redis initialization failure triggers `gracefulShutdown('REDIS_CONNECTION_FAILED', 1)`.
- `[src/modules/consultations/consultations.service.ts:ConsultationsService]`: Concurrent consultation claims, device migrations, and cancellations (4 clinical states `WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`) use atomic `updateMany` compare-and-swap guards (`stateVersion` / `vetId: null`) inside `prisma.$transaction`.
- `[src/app.ts:/api/calls/webhook]`, `[src/modules/calls/calls.service.ts:CallsService.handleWebhook]`: LiveKit webhooks must pass raw-body HMAC verification via `WebhookReceiver.receive` before `express.json()` parses payloads.
- `[src/server.ts:gracefulShutdown]`: Process shutdown clears the `vetDisconnectTracker` sweeper (`[src/realtime/vetDisconnectTracker.ts]`, Redis-backed deadlines) and closes `io` and `http.Server`, clears the tracker again, closes all Redis clients, and disconnects Prisma within a 10-second force-exit window.

## Global Side Effects
- `[src/lib/prisma.ts:prisma]`, `[prisma/schema.prisma:db]`: Opens pooled PostgreSQL connections and reads/writes 15 domain tables across modules, realtime gateways, and background jobs.
- `[src/lib/redis.ts:initializeSharedRedisClient]`, `[src/realtime/socket.server.ts:initializeSocketServer]`, `[src/realtime/presence.service.ts:PresenceService]`: Maintains shared, pub/sub, and presence Redis connections (`presence:*` keys and `@socket.io/redis-adapter` channels).
- `[src/modules/calls/calls.service.ts:CallsService]`: Interacts with external LiveKit `RoomServiceClient` APIs to mint tokens, evict participants, and delete rooms.
- `[src/modules/media/media.service.ts:MediaService]`, `[src/modules/media/media.middleware.ts:uploadMiddleware]`: Reads/writes local `uploads/` directories and `uploads/tmp/` or puts/presigns objects in AWS S3.
- `[src/services/email.service.ts:EmailService]`, `[src/modules/notifications/notifications.service.ts:NotificationsService]`, `[src/jobs/notifications.scheduler.ts:NotificationsScheduler]`: Dispatches outbound HTTPS requests to Resend (`api.resend.com` SDK) and Expo Push (`exp.host/--/api/v2/push/send`) and runs hourly reminder timers.

## System Verification
- Run: `npm test -w backend`
