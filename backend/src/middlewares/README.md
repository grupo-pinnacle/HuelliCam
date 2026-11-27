# middlewares

## Overview
Provides Express request/response middleware for correlation ID propagation and request logging, endpoint-specific in-memory rate limiting, and centralized HTTP error serialization.

## Interface
- `[errorHandler.ts:AppError]` - `Error` subclass with `statusCode` (default `400`), `code` (default `'BAD_REQUEST'`), and `details` (default `null`).
- `[errorHandler.ts:errorHandler]` - Express error middleware `(err, req, res, next) => void`.
- `[rateLimiter.ts:mediaUploadRateLimiter]` - `express-rate-limit` middleware (1h window, max 20, code `'TOO_MANY_UPLOADS'`).
- `[rateLimiter.ts:consultationRateLimiter]` - `express-rate-limit` middleware (1h window, max 10, code `'TOO_MANY_CONSULTATIONS'`).
- `[rateLimiter.ts:passwordResetIpLimiter]` - `express-rate-limit` middleware (15m window, max 5 per IP, code `'TOO_MANY_REQUESTS'`).
- `[rateLimiter.ts:passwordResetEmailLimiter]` - `express-rate-limit` middleware (15m window, max 5 per normalized email or IP, code `'TOO_MANY_REQUESTS'`).
- `[requestId.ts:Express.Request]` - Global module augmentation adding `id`, `requestId`, `correlationId`, and `log` to `Express.Request`.
- `[requestId.ts:getRequestId]` - `(req?: Pick<Request, 'requestId' | 'id' | 'correlationId'>) => string | undefined`.
- `[requestId.ts:requestIdMiddleware]` - Express middleware `(req, res, next) => void` attaching IDs, child logger, headers, and finish-time logging.

## Invariants
- `[errorHandler.ts:errorHandler]` - Formats responses as `{ success: false, error: { code, message, ..., timestamp } }` mapped by error type (`413 PAYLOAD_TOO_LARGE`, `AppError.statusCode`, `400 VALIDATION_ERROR` for `ZodError`, `503 DATABASE_UNAVAILABLE` for `PrismaClientInitializationError` or `P1000`/`P1001`/`P1002`/`P1003`/`P1017`, `409 CONFLICT` for `P2002`, `500 INTERNAL_SERVER_ERROR`); includes raw error `details`/`meta` only when `process.env.NODE_ENV === 'development'`.
- `[rateLimiter.ts:*]` - All limiters use `standardHeaders: true` and `legacyHeaders: false`; `passwordResetEmailLimiter` normalizes `req.body?.email` via `trim().toLowerCase()` and falls back to `req.ip || 'anonymous'`.
- `[requestId.ts:requestIdMiddleware]` - Sanitizes incoming `x-request-id` and `x-correlation-id` headers via `sanitizeCorrelationId`, falls back to a generated UUID, and executes `next()` inside `runWithLogContext`.

## Side Effects
- `[errorHandler.ts:errorHandler]` - Writes HTTP JSON responses and emits `logger.error` logs for `DATABASE_UNAVAILABLE` and unhandled `INTERNAL_SERVER_ERROR`.
- `[rateLimiter.ts:*]` - Mutates `express-rate-limit` in-memory counters and writes `RateLimit-*` headers and HTTP 429 JSON responses.
- `[requestId.ts:requestIdMiddleware]` - Mutates `req.id`, `req.requestId`, `req.correlationId`, and `req.log`; sets `X-Request-Id` and `X-Correlation-Id` response headers; registers a `res.on('finish')` listener logging request completion via `req.log`.

## Verification
- Run: `npm test -w backend`
