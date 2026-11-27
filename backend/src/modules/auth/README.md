# Auth

## Overview
Authentication, session concurrency, JWT middleware, and 6-digit email password recovery module for Huellicam users.

## Interface
- `[auth.routes.ts:default]` — Express `Router` exposing `POST /register`, `POST /login`, `POST /refresh`, `POST /logout` (`authenticate`), `GET /me` (`authenticate`), `POST /forgot-password`, `POST /verify-reset-code`, and `POST /reset-password` (recovery routes guarded by `passwordResetIpLimiter` and `passwordResetEmailLimiter`)
- `[auth.middleware.ts:AuthenticatedRequest]` — Express `Request` extension carrying `user?: User`
- `[auth.middleware.ts:authenticate]`, `[auth.middleware.ts:requireRole]` — JWT verification and role-authorization middlewares
- `[auth.controller.ts:AuthController]` — HTTP handlers (`register`, `login`, `refresh`, `logout`, `me`, `forgotPassword`, `verifyResetCode`, `resetPassword`)
- `[auth.controller.ts:setRefreshCookie]` — Helper writing the `refreshToken` HTTP-only cookie
- `[auth.service.ts:TokenPayload]` — JWT payload interface (`userId`, `role`, `tokenVersion`)
- `[auth.service.ts:AuthService]` — Authentication service (`generateTokens`, `sanitizeUser`, `register`, `login`, `refresh`, `logout`)
- `[passwordReset.service.ts:PasswordResetService]`, `[passwordReset.service.ts:passwordResetService]` — Password reset OTP service (`requestReset`, `verifyCode`, `resetPassword`) and singleton instance
- `[auth.schemas.ts:registerSchema]`, `[auth.schemas.ts:loginSchema]`, `[auth.schemas.ts:refreshSchema]`, `[auth.schemas.ts:forgotPasswordSchema]`, `[auth.schemas.ts:verifyResetCodeSchema]`, `[auth.schemas.ts:resetPasswordSchema]` — Zod validation schemas
- `[auth.schemas.ts:RegisterDTO]`, `[auth.schemas.ts:LoginDTO]`, `[auth.schemas.ts:ForgotPasswordDTO]`, `[auth.schemas.ts:VerifyResetCodeDTO]`, `[auth.schemas.ts:ResetPasswordDTO]` — Inferred DTO types

## Invariants
- `[auth.middleware.ts:authenticate]` — Accepts Bearer or `accessToken` cookie JWTs verified with HS256 against `config.JWT_SECRET`; rejects deleted users and mismatched `tokenVersion` (`401` `SESSION_REVOKED`).
- `[auth.middleware.ts:requireRole]` — Rejects unauthenticated requests or roles not in the allowed list with `403` `FORBIDDEN`.
- `[auth.service.ts:AuthService.register]`, `[auth.schemas.ts:registerSchema]` — Normalizes emails (`trim().toLowerCase()`), rejects existing or soft-deleted emails (`409` `EMAIL_ALREADY_EXISTS`), restricts public registration roles to `CLIENT | VET` (default `CLIENT`), hashes passwords with `bcrypt` cost `12`, and sets `VET` status to `VetStatus.PENDING` in `production` (else `VetStatus.APPROVED`).
- `[auth.service.ts:AuthService.login]`, `[auth.service.ts:AuthService.logout]`, `[auth.service.ts:AuthService.refresh]` — `login` blocks soft-deleted accounts (`403` `ACCOUNT_SUSPENDED`) and atomically increments `tokenVersion` for single-session concurrency; `refresh` verifies HS256 `JWT_REFRESH_SECRET` and requires matching `tokenVersion` on a non-deleted user.
- `[auth.service.ts:AuthService.generateTokens]`, `[auth.service.ts:AuthService.sanitizeUser]` — Access tokens expire in `15m`, refresh tokens in `7d`; `sanitizeUser` strips `password`.
- `[passwordReset.service.ts:PasswordResetService.requestReset]` — Returns `true` silently if email does not match an active user, caps requests at `5` per `15` minutes per email (`429` `TOO_MANY_REQUESTS`), invalidates prior unused tokens, and stores a `crypto.randomInt(100000, 999999)` code hashed with `bcrypt` cost `10` (10-minute TTL).
- `[passwordReset.service.ts:PasswordResetService.verifyCode]`, `[passwordReset.service.ts:PasswordResetService.resetPassword]` — Invalidates the reset token after `3` failed attempts (`400` `MAX_ATTEMPTS_EXCEEDED`); `resetPassword` re-verifies the code, hashes the new password (`bcrypt` cost `12`), marks unused tokens used, and increments `tokenVersion`.

## Side Effects
- `[auth.service.ts:AuthService]`, `[passwordReset.service.ts:PasswordResetService]` — Reads/writes PostgreSQL `user` and `passwordResetToken` tables via Prisma.
- `[auth.controller.ts:setRefreshCookie]`, `[auth.controller.ts:AuthController.logout]` — Sets and clears the `refreshToken` HTTP-only cookie (`path: '/api/auth'`, `maxAge: 7d`).
- `[auth.controller.ts:AuthController.login]` — Emits Socket.IO `auth:session_terminated` (`CONCURRENT_LOGIN`) to `user:${user.id}` (excluding `device:${rawDeviceId}` when `x-device-id` header is set).
- `[passwordReset.service.ts:PasswordResetService.requestReset]` — Sends reset email via `emailService.sendPasswordResetCode`.
- `[passwordReset.service.ts:PasswordResetService]` — Mutates in-memory `failedAttemptsMap` per token ID.

## Verification
- Run: `npm test -w backend`
