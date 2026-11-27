# config

## Overview
Provides environment variable discovery and loading, alias normalization, Zod schema validation, PostgreSQL pooled connection URL construction, and CORS origin allowlist evaluation for the backend.

## Interface
- `[cors.ts:allowedOrigins]` - Deduplicated `string[]` of permitted origins combining production domains, non-production localhost origins (`NODE_ENV !== 'production'`), and `CORS_ORIGIN` / `FRONTEND_URL` / `CLIENT_URL`.
- `[cors.ts:isAllowedOrigin]` - `(origin?: string) => boolean` validating incoming request origins against `allowedOrigins`.
- `[env.ts:DEFAULT_DB_POOL_LIMIT]` - Default database connection pool limit (`20`).
- `[env.ts:DEFAULT_DB_POOL_TIMEOUT]` - Default database pool timeout in seconds (`15`).
- `[env.ts:DEFAULT_DISCONNECT_DEBOUNCE_MS]` - Default disconnect debounce window in milliseconds (`5000`).
- `[env.ts:PooledDatabaseUrlOptions]` - Interface configuring `connectionLimit`, `poolTimeout`, `pgbouncer`, and `statementCacheSize`.
- `[env.ts:buildPooledDatabaseUrl]` - `(rawUrl: string, options?: PooledDatabaseUrlOptions) => string` applying pooling parameters to PostgreSQL URLs.
- `[env.ts:config]` - Shallow-frozen (`Object.freeze`) validated configuration object.
- `[env.ts:Config]` - TypeScript type alias `typeof config`.

## Invariants
- `[cors.ts:isAllowedOrigin]` - Requests with an omitted/empty `origin` always pass; `devOrigins` are included in `allowedOrigins` only when `process.env.NODE_ENV !== 'production'`.
- `[env.ts:envSchema]` - Requires `JWT_SECRET` and `JWT_REFRESH_SECRET` >= 32 chars, non-empty `DATABASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`; bounds `DB_POOL_LIMIT` / `DATABASE_CONNECTION_LIMIT` to `1..200` and `DB_POOL_TIMEOUT` to `1..120`; requires a valid `redis://` or `rediss://` `REDIS_URL` in `production`.
- `[env.ts:buildPooledDatabaseUrl]` - Only transforms `postgresql:` and `postgres:` URLs and sets `statement_cache_size=0` when `pgbouncer` is `'true'` and no cache size is set.
- `[env.ts:config]` - Exported `config` is shallow-frozen; when `envSchema.safeParse(process.env)` fails and `NODE_ENV === 'test'`, falls back to hardcoded test/dev defaults instead of terminating.

## Side Effects
- `[env.ts:dotenv.config]` - Reads `.env` files from candidate workspace paths at module load with `override: false`.
- `[env.ts:fs.copyFileSync]` - Copies monorepo root `.env` to `backend/.env` on startup if the root `.env` exists and `backend/.env` does not.
- `[env.ts:process.env]` - Mutates `process.env` (`DATABASE_URL`, `DIRECT_URL`, `JWT_REFRESH_SECRET`, `REFRESH_TOKEN_SECRET`, `STORAGE_DRIVER`, `STORAGE_PROVIDER`, `AWS_BUCKET_NAME`, `AWS_S3_BUCKET_NAME`, `FRONTEND_URL`, `REDIS_URL`) during alias normalization and pool URL generation.
- `[env.ts:stderrLogger.fatal]` - Writes a fatal log to stderr and invokes `process.exit(1)` if schema validation fails outside `NODE_ENV === 'test'`.

## Verification
- Run: `npm test -w backend`
