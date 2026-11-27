# services

## Overview
Provides transactional email rendering and delivery via the Resend SDK, with local mock logging when unconfigured and sender fallback retries.

## Interface
- `[email.service.ts:EmailOptions]` - Interface `{ to: string; subject: string; html: string; text?: string }`.
- `[email.service.ts:EmailService]` - Class exposing `sendEmail(options)`, `sendPasswordResetCode(to, userName, code)`, `sendPrescriptionEmail(params)`, and `sendReminderEmail(params)`.
- `[email.service.ts:emailService]` - Singleton `EmailService` instance.

## Invariants
- `[email.service.ts:EmailService.constructor]` - Uses `config.EMAIL_FROM` or falls back to `RESEND_FALLBACK_FROM` (`'Huellicam <onboarding@resend.dev>'`); initializes `Resend` only when `config.RESEND_API_KEY` is truthy.
- `[email.service.ts:EmailService.sendEmail]` - Returns `true` immediately in mock mode when `this.resend` is `null`; retries once with `RESEND_FALLBACK_FROM` if Resend returns an error and `fromEmail !== RESEND_FALLBACK_FROM`; catches thrown exceptions and returns `false` instead of throwing.

## Side Effects
- `[email.service.ts:EmailService.sendEmail]` - Executes outbound HTTPS calls via `this.resend.emails.send` when configured and emits structured `info`/`warn`/`debug`/`error` entries through `logger`.

## Verification
- Run: `npm test -w backend`
