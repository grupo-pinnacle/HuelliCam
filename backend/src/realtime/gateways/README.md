# Realtime Gateways

## Overview
Socket.IO gateway handlers for Huellicam consultation rooms, call-signaling relays, and real-time chat message persistence. Currently exposes `registerChatGateway` to bind consultation-scoped event handlers onto authenticated sockets.

## Interface
- `[chat.gateway.ts:registerChatGateway]`: Registers `join:consultation`, `leave:consultation`, `call:answered`, `call:rejected`, `call:ended`, and `message:send` handlers on a `Socket<any, any, any, SocketData>` bound to `io: Server`.
- `[chat.gateway.ts:registerChatGateway]`: Emits `call:answered`, `call:rejected`, `call:ended` (`{ consultationId, endedBy }`), and `message:new` to `consultation:${consultationId}` rooms.

## Invariants
- `[chat.gateway.ts:registerChatGateway]`: `join:consultation` and `message:send` require a non-deleted consultation (`!consultation.deletedAt`) where `user` is `consultation.clientId`, `consultation.vetId`, or `user.role === 'ADMIN'`.
- `[chat.gateway.ts:isAuthorizedParticipant]`: `call:answered`, `call:rejected`, and `call:ended` only relay when `socket.rooms.has('consultation:${consultationId}')` or a DB lookup confirms a non-deleted consultation where `user` is `clientId`, `vetId`, or `ADMIN`.
- `[chat.gateway.ts:registerChatGateway]`: `message:send` validates `content`, `clientMsgId`, and `attachmentUrl` with `createMessageSchema.safeParse` (`VALIDATION_ERROR`), rejects missing/deleted consultations (`CONSULTATION_NOT_FOUND`), rejects `consultation.status === 'CANCELLED'` (`INVALID_CONSULTATION_STATE`), and rejects non-participants (`FORBIDDEN`).
- `[chat.gateway.ts:registerChatGateway]`: Duplicate `clientMsgId` inserts catching `Prisma.PrismaClientKnownRequestError` with `err.code === 'P2002'` resolve idempotently by returning the existing `prisma.message` record to `callback` without re-emitting `message:new`.

## Side Effects
- `[chat.gateway.ts:registerChatGateway]`: Reads `prisma.consultation.findUnique`, inserts via `prisma.message.create`, and queries `prisma.message.findUnique` on `P2002` conflict.
- `[chat.gateway.ts:registerChatGateway]`: Mutates Socket.IO room membership (`socket.join` / `socket.leave` on `consultation:${consultationId}`) and broadcasts via `io.to('consultation:${consultationId}').emit(...)`.
- `[chat.gateway.ts:registerChatGateway]`: Logs handler exceptions via `logger.error`.

## Verification
- Run: `npm test -w backend`
