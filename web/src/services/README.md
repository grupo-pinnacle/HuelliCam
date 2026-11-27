# Services

## Overview
Configured Axios HTTP client for Huellicam backend requests, managing access token persistence, device/correlation request headers, and single-flight 401 token refresh.

## Interface
- `[api.ts:getApiUrl]` - Resolves backend HTTP base URL from `VITE_API_URL`, `window.location.origin`, or `'http://localhost:3001'`.
- `[api.ts:setAccessToken]` - Sets in-memory `currentAccessToken` and syncs `'huellicam_token'` in `window.localStorage`.
- `[api.ts:getAccessToken]` - Returns the current in-memory access token (`string | null`).
- `[api.ts:getDeviceId]` - Returns `'server'` in SSR or reads/generates `'huellicam_device_id'` in `window.localStorage`.
- `[api.ts:api]` - Pre-configured Axios instance (`withCredentials: true`, JSON content type, auth/tracing interceptors).
- `[api.ts:default]` - Default export of `api`.

## Invariants
- `[api.ts:getApiUrl]` - Uses non-localhost `VITE_API_URL` when configured, falls back to `window.location.origin` on non-localhost hostnames, and defaults to `'http://localhost:3001'`.
- `[api.ts:api]` - Request interceptor attaches `Authorization: Bearer <token>` (if set and not already present), `x-device-id`, per-request `X-Request-Id`, and per-session `X-Correlation-Id`.
- `[api.ts:api]` - Response interceptor never attempts token refresh on `/api/auth/login`, `/api/auth/refresh`, `/api/auth/me` without an active token, or requests marked `_retry === true`.
- `[api.ts:api]` - Concurrent `401` responses queue behind a single `isRefreshing` `POST /api/auth/refresh` call via `failedQueue` and `processQueue`.
- `[api.ts:api]` - Treats `SESSION_REVOKED` error codes as terminal without attempting refresh.

## Side Effects
- `[api.ts:setAccessToken]` - Mutates module-level `currentAccessToken` and writes or removes `'huellicam_token'` in `window.localStorage`.
- `[api.ts:getDeviceId]` - Reads and lazily writes `'huellicam_device_id'` in `window.localStorage`.
- `[api.ts:api]` - Issues HTTP requests to `API_URL`, automatically invokes `POST /api/auth/refresh` on eligible `401` responses, and dispatches `window` `CustomEvent('huellicam:session_terminated')` on `SESSION_REVOKED`.

## Verification
- Run: `npm test -w web`
