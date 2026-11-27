# Notifications Module

## Overview
Manages user notifications, read-state tracking, Expo push token registration, and multi-channel dispatch across PostgreSQL persistence, Socket.IO user rooms, and the Expo Push API.

## Interface
- `[notifications.schemas.ts:registerPushTokenSchema]`: Zod schema validating `{ token: string, platform: 'ios' | 'android' | 'web' }`.
- `[notifications.schemas.ts:RegisterPushTokenDTO]`: Inferred DTO type from `registerPushTokenSchema`.
- `[notifications.routes.ts:default]`: Express `Router` applying `authenticate` globally with `POST /register-token`, `GET /`, `PATCH /read-all`, and `PATCH /:id/read`.
- `[notifications.controller.ts:NotificationsController]`: Controller exposing `registerToken`, `listMine`, `markRead`, and `markAllRead`.
- `[notifications.service.ts:NotificationsService]`: Service exposing `registerPushToken`, `getUserNotifications`, `markAsRead`, `markAllAsRead`, and `createAndDispatch`.
- `[notifications.service.ts:notificationsService]`: Exported singleton instance of `NotificationsService`.

## Invariants
- `[notifications.routes.ts:default]`: All notification routes require an authenticated user (`authenticate`).
- `[notifications.controller.ts:NotificationsController.registerToken]`: Request payloads must validate against `[notifications.schemas.ts:registerPushTokenSchema]`.
- `[notifications.service.ts:NotificationsService.getUserNotifications]`: Returns at most `50` notifications for `userId`, ordered by `createdAt` descending.
- `[notifications.service.ts:NotificationsService.markAsRead]`: Requires the notification to match both `id` and `userId`; otherwise throws `404` `NOTIFICATION_NOT_FOUND`.
- `[notifications.service.ts:NotificationsService.createAndDispatch]`: Only push tokens beginning with `'ExponentPushToken'` are forwarded to Expo's push endpoint.

## Side Effects
- `[notifications.service.ts:NotificationsService.registerPushToken]`: Upserts `prisma.pushToken` records in PostgreSQL.
- `[notifications.service.ts:NotificationsService.markAsRead]`: Updates `isRead` and `readAt` on `prisma.notification` rows; `[notifications.service.ts:NotificationsService.markAllAsRead]` bulk-updates unread `prisma.notification` rows.
- `[notifications.service.ts:NotificationsService.createAndDispatch]`: Inserts `prisma.notification` rows, emits `'notification:new'` Socket.IO events to room `` `user:${userId}` `` when `io` is present, sends HTTP `POST` requests to `https://exp.host/--/api/v2/push/send` via `fetch`, and logs dispatch/query failures via `logger.warn`.

## Verification
- Run: `npm test -w backend`
