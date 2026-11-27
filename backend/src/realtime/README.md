# Realtime Subsystem

## Overview
Socket.IO server initialization, typed event contracts, JWT handshake authentication, signaling rate limiting, unified multi-device/LiveKit session eviction, distributed Redis/in-memory presence tracking, distributed Redis ZSET vet-disconnect deadline sweeping, and consultation gateway registration.

## Interface
- `[socket.types.ts:SocketUser]`: Authenticated user payload stored on `socket.data.user`.
- `[socket.types.ts:ClientToServerEvents]`: Typed client-to-server Socket.IO event contract.
- `[socket.types.ts:ServerToClientEvents]`: Typed server-to-client Socket.IO event contract (including `auth:session_terminated`, `consultation:tutor_reconnecting`, `consultation:tutor_reconnected`, and `consultation:critical_resume`).
- `[socket.types.ts:InterServerEvents]`: Typed inter-server Socket.IO event interface.
- `[socket.types.ts:SocketData]`: Per-socket metadata (`user`, `deviceId`, `correlationId`).
- `[socket.auth.middleware.ts:socketAuthMiddleware]`: Socket.IO middleware validating JWT credentials, active user `tokenVersion`, and `x-device-id` format via `extractDeviceId`.
- `[socket.ratelimit.middleware.ts:applySocketRateLimiting]`: Per-socket and per-IP rate-limiting middleware for sensitive signaling events.
- `[sessionEviction.helper.ts:EvictUserRealtimeAndCallParams]`: Parameter contract for unified socket and LiveKit participant eviction.
- `[sessionEviction.helper.ts:evictUserRealtimeAndCall]`: Shared helper emitting `auth:session_terminated`, disconnecting revoked device sockets, and removing stale LiveKit SFU participants.
- `[vetDisconnectTracker.ts:VET_DISCONNECT_DEADLINES_KEY]`: Redis ZSET key `'huellicam:vet_disconnect_deadlines'`.
- `[vetDisconnectTracker.ts:VetDisconnectTracker]`: Distributed Redis ZSET / in-memory fallback vet-disconnect deadline tracker (`schedule`, `cancel`, `sweepExpiredOnce`, `start`, `stop`, `clear`).
- `[vetDisconnectTracker.ts:vetDisconnectTracker]`: Shared `VetDisconnectTracker` singleton.
- `[socket.server.ts:io]`: Exported active `AppSocketServer` reference.
- `[socket.server.ts:whenSocketRedisReady]`: Returns promise tracking Socket.IO Redis adapter initialization.
- `[socket.server.ts:initializeSocketServer]`: Initializes and attaches Socket.IO to an `HttpServer`, wires Redis pub/sub adapter, middlewares, atomic presence tracking, device handoff, vet disconnect deadline tracking, and `registerChatGateway`.
- `[presence.service.ts:PRESENCE_TTL_MS]`: Presence TTL constant (`90_000` ms).
- `[presence.service.ts:LAST_SEEN_TTL_SEC]`: Last-seen state TTL constant (`604_800` s).
- `[presence.service.ts:MANUAL_UNAVAILABLE_TTL_SEC]`: Manual vet unavailability TTL constant (`86_400` s).
- `[presence.service.ts:VETS_ONLINE_KEY]`: Redis ZSET key `'presence:vets:online'`.
- `[presence.service.ts:PresenceSocketParams]`: Input parameters for socket connect, refresh, and disconnect presence calls.
- `[presence.service.ts:ManualAvailabilityParams]`: Input parameters for `setManualVetAvailability`.
- `[presence.service.ts:UserPresenceSnapshot]`: Output shape `{ isOnline: boolean; lastSeen: Date | null }`.
- `[presence.service.ts:PresenceService]`: Presence service class exposing `isDistributedActive`, `registerSocketConnect`, `refreshSocketPresence`, `unregisterSocketDisconnect`, `setManualVetAvailability`, `clearUserPresence`, `removeVetFromOnline`, `getOnlineVetsCount`, `getUsersPresence`, and `clearMemoryStateForTest`.
- `[presence.service.ts:presenceService]`: Shared `PresenceService` singleton.
- Gateways: [./gateways/README.md](./gateways/README.md) - Consultation room, call-signaling, and message gateway (`registerChatGateway`).

## Invariants
- `[socket.auth.middleware.ts:socketAuthMiddleware]`: Requires a JWT from `socket.handshake.auth.token` or `accessToken` cookie (stripping optional `Bearer `), verifies `HS256` against `config.JWT_SECRET`, rejects missing/soft-deleted users (`!user || user.deletedAt`), and rejects revoked sessions (`user.tokenVersion !== payload.tokenVersion`).
- `[socket.ratelimit.middleware.ts:applySocketRateLimiting]`: Enforces `WINDOW_MS = 10_000`, `MAX_PER_SOCKET = 20`, and `MAX_PER_IP = 60` on `SENSITIVE_SIGNALING_EVENTS` (`call:answered`, `call:rejected`, `call:ended`, `join:consultation`, `message:send`), invoking callback with `RATE_LIMIT_EXCEEDED` and passing an `Error` to `next`.
- `[vetDisconnectTracker.ts:VetDisconnectTracker]`: Schedules 3-minute Redis ZSET deadlines (`VET_DISCONNECT_DEADLINES_KEY`) for active vet disconnects and claims expired entries atomically via `CLAIM_EXPIRED_VET_DEADLINES_LUA`, delegating timeout checks to `consultationsService.checkVetDisconnectTimeout`.
- `[socket.server.ts:initializeSocketServer]`: In `production` (`NODE_ENV === 'production'`), throws synchronously if `REDIS_URL` is absent (disabling `InMemoryAdapter` fallback) and rejects socket connections in middleware until `redisAdapterReady` is true.
- `[socket.server.ts:initializeSocketServer]`: Re-initializing on the same `HttpServer` closes prior sockets/adapters/Redis clients, calls `vetDisconnectTracker.clear()`, and restores original `request` listeners while stripping previously added `upgrade`, `close`, and `listening` listeners.
- `[socket.server.ts:initializeSocketServer]`: On `CLIENT` connect/disconnect, invokes `consultationsService.handoffTutorDevice` for active `WAITING`/`ACTIVE` consultations and emits `consultation:tutor_reconnected` / `consultation:tutor_reconnecting` when `PresenceService` signals a true online/offline transition (no PostgreSQL writes on socket flap); on `VET` connect/disconnect, cancels or schedules `vetDisconnectTracker` deadlines.
- `[socket.server.ts:initializeSocketServer]`: `presence:heartbeat` enforces `EXPLICIT_HEARTBEAT_COOLDOWN_MS = 2_000` per socket; `disconnect` awaits `connectPresencePromise` before calling `presenceService.unregisterSocketDisconnect`.
- `[presence.service.ts:PresenceService]`: Executes atomic Redis Lua scripts (`REGISTER_SOCKET_CONNECT_LUA`, `REFRESH_SOCKET_PRESENCE_LUA`, `UNREGISTER_SOCKET_DISCONNECT_LUA`) when Redis is active (never resurrecting expired/evicted sockets or clearing presence when remaining active sockets exist), requires a `'ready'` or `'connect'` Redis client in production (`getActiveRedis(true)`), and keeps approved vets out of `VETS_ONLINE_KEY` while `presence:vet:unavailable:${userId}` equals `'1'`.

## Side Effects
- `[socket.auth.middleware.ts:socketAuthMiddleware]`: Queries `prisma.user.findUnique` and mutates `socket.data.user`, `socket.data.deviceId`, and `socket.data.correlationId`.
- `[socket.ratelimit.middleware.ts:applySocketRateLimiting]`: Mutates `socketBuckets` and `ipBuckets` maps, starts an `.unref()`ed 60s `setInterval` (`pruneInterval`), and deletes socket bucket entries on `disconnect`.
- `[vetDisconnectTracker.ts:VetDisconnectTracker]`: Mutates `huellicam:vet_disconnect_deadlines` in Redis (or in-memory fallback map outside production) and starts an `.unref()`ed sweep interval (`VET_DISCONNECT_SWEEP_MS = 15_000`).
- `[socket.server.ts:initializeSocketServer]`: Attaches Socket.IO `Server` to `httpServer`, opens Redis pub/sub/shared clients, configures `@socket.io/redis-adapter`, joins `user:${user.id}`, `device:${deviceId}`, and `role:vets` rooms, emits `vet:presence` and tutor reconnection events, registers `registerChatGateway`, and evicts stale device sockets/SFU participants via `evictUserRealtimeAndCall`.
- `[presence.service.ts:PresenceService]`: Executes Redis Lua scripts (`REGISTER_SOCKET_CONNECT_LUA`, `REFRESH_SOCKET_PRESENCE_LUA`, `UNREGISTER_SOCKET_DISCONNECT_LUA`), pipelines, and read/ZSET commands against `presence:user:${userId}:sockets`, `presence:user:${userId}`, `presence:vet:unavailable:${userId}`, and `presence:vets:online` (or mutates in-memory fallback maps outside production).

## Verification
- Run: `npm test -w backend`
