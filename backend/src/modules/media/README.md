# Media Module

## Overview
Handles authenticated medical and consultation media uploads and authorized file retrieval. Incoming uploads are staged to local disk via Multer, verified by binary magic bytes, checked against per-user daily upload quotas and consultation participation, stored either locally or in AWS S3, and served via signed S3 redirects or local file streaming.

## Interface
- `[media.routes.ts:default]`: Express `Router` applying `authenticate` globally with `POST /` (rate-limited by `mediaUploadRateLimiter`, `uploadMiddleware.single('file')`, `handleMulterError`, `verifyMagicBytes`, `controller.upload`) and `GET /:id` (`controller.getById`).
- `[media.middleware.ts:uploadMiddleware]`: `multer` middleware configured with `diskStorage` in `uploads/tmp` and a `10 * 1024 * 1024` byte `fileSize` limit.
- `[media.middleware.ts:handleMulterError]`: Express error middleware converting `MulterError` `LIMIT_FILE_SIZE` into HTTP `413` (`FILE_TOO_LARGE`).
- `[media.middleware.ts:verifyMagicBytes]`: Async middleware reading the first 32 bytes of `req.file.path` and verifying JPEG, PNG, PDF, or WebP signatures.
- `[media.controller.ts:MediaController]`: Controller exposing `upload` and `getById`.
- `[media.service.ts:MediaService]`: Service exposing `uploadMediaFile` and `getMediaFile`.

## Invariants
- `[media.routes.ts:default]`: All routes in this module require an authenticated user (`authenticate`).
- `[media.middleware.ts:uploadMiddleware]`: Per-file upload size cannot exceed 10 MB (`10 * 1024 * 1024` bytes); violations return `413` `FILE_TOO_LARGE` via `[media.middleware.ts:handleMulterError]`.
- `[media.middleware.ts:verifyMagicBytes]`: Only files whose header bytes match JPEG (`FFD8FF`), PNG (`89504E47`), PDF (`25504446`), or WebP (`52494646` at bytes 0–3 and `57454250` at bytes 8–11) are permitted; otherwise `400` `INVALID_FILE_TYPE` or `NO_FILE_PROVIDED` is returned.
- `[media.service.ts:MediaService.uploadMediaFile]`: Daily upload volume per user is capped at `MAX_DAILY_BYTES` (`50 * 1024 * 1024` bytes) per UTC `"YYYY-MM-DD"` date (`429` `UPLOAD_QUOTA_EXCEEDED`).
- `[media.service.ts:MediaService.uploadMediaFile]`: When `consultationId` is supplied, the consultation must exist, have `deletedAt: null` (`404` `CONSULTATION_NOT_FOUND`), and include the caller as `clientId`, `vetId`, or `Role.ADMIN` (`403` `FORBIDDEN`).
- `[media.service.ts:MediaService.getMediaFile]`: Only non-soft-deleted media (`deletedAt: null`) is accessible (`404` `MEDIA_NOT_FOUND`), restricted to `ownerId`, `Role.ADMIN`, or the assigned `consultation.vetId` (`403` `FORBIDDEN`).
- `[media.service.ts:MediaService.getMediaFile]`: S3 presigned URLs expire after `300` seconds; local files must exist on disk (`404` `FILE_NOT_FOUND_ON_DISK`).

## Side Effects
- `[media.middleware.ts:uploadMiddleware]`: Creates `uploads/tmp` on module initialization via `fs.mkdirSync(..., { recursive: true })` and writes temporary uploaded files to disk.
- `[media.middleware.ts:verifyMagicBytes]`: Deletes rejected or unreadable temporary files via `fs.unlinkSync`.
- `[media.service.ts:MediaService]`: Creates `config.UPLOAD_DIR` (default `'uploads'`) on module initialization via `fs.mkdirSync(..., { recursive: true })`.
- `[media.service.ts:MediaService.uploadMediaFile]`: Uploads objects to AWS S3 (`PutObjectCommand`) and unlinks temp files when `STORAGE_DRIVER === 's3'`, or moves temp files to `uploadsDir` via `fs.renameSync`.
- `[media.service.ts:MediaService.uploadMediaFile]`: Upserts `prisma.dailyUploadCounter` and creates `prisma.mediaFile` rows in PostgreSQL.
- `[media.service.ts:MediaService.getMediaFile]`: Generates S3 presigned URLs via `getSignedUrl`; `[media.controller.ts:MediaController.getById]` issues HTTP `302` redirects for S3 or streams local files via `res.sendFile`.

## Verification
- Run: `npm test -w backend`
