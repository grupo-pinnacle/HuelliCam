# jobs

## Overview
Manages autonomous background scheduling for deduplicated email reminders covering waiting consultations, preventive medical checkups, and pet birthdays.

## Interface
- `[notifications.scheduler.ts:NotificationsScheduler]` - Class exposing `isEnabled()`, `start()`, `stop()`, `runChecks(now?)`, `checkUpcomingConsultations(now?)`, `checkPreventiveCheckups(now?)`, and `checkPetBirthdays(now?)`.
- `[notifications.scheduler.ts:notificationsScheduler]` - Singleton `NotificationsScheduler` instance.

## Invariants
- `[notifications.scheduler.ts:NotificationsScheduler.isEnabled]` - Enabled in `production` unless `config.ENABLE_EMAIL_SCHEDULER === 'false'`; disabled in non-production unless `config.ENABLE_EMAIL_SCHEDULER === 'true'`.
- `[notifications.scheduler.ts:NotificationsScheduler.start]` - No-ops if either `bootTimer` or `timer` is already active.
- `[notifications.scheduler.ts:NotificationsScheduler.dispatchReminderOnce]` - Queries `prisma.emailDispatchLog.findUnique({ where: { dedupeKey } })` before sending and writes `EmailDispatchLog` only after `emailService.sendReminderEmail` returns `true`. Enforces deduplication keys `APPOINTMENT:${c.id}`, `CHECKUP:${pet.id}:${todayIso}` (180-day interval, `take: 20`), and `BIRTHDAY:${pet.id}:${currentYear}` (`ageYears >= 1`, mapping Feb 29 birthdays to Feb 28 in non-leap UTC years).

## Side Effects
- `[notifications.scheduler.ts:NotificationsScheduler.start]` - Schedules a 5000ms boot `setTimeout` and a 1-hour `setInterval` (`stop()` clears both).
- `[notifications.scheduler.ts:prisma]` - Reads `Consultation`, `Pet`, and `EmailDispatchLog` rows and inserts `EmailDispatchLog` records in PostgreSQL.
- `[notifications.scheduler.ts:emailService.sendReminderEmail]` - Dispatches outbound reminder emails via `emailService`.
- `[notifications.scheduler.ts:logger]` - Emits info and warning logs on disabled startup or failed check cycles.

## Verification
- Run: `npm test -w backend`
