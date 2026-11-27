# Guía de Despliegue y Operación — Huellicam

Manual de infraestructura y configuración para desplegar **Huellicam** en entorno productivo (VPS con Docker/Coolify para Backend + Redis, Vercel para Frontend Web, PostgreSQL administrado, LiveKit Cloud, Resend y Expo EAS para Mobile).

---

## 1. Topología Productiva

```mermaid
flowchart TD
    Users["Usuarios (Web & Android)"] --> Vercel["Frontend Web (Vercel)\nSPA React 18 + Vite\nvercel.json en raíz"]
    Users --> Proxy["Reverse Proxy TLS (Traefik / Coolify)\nHTTPS + WSS"]
    Proxy --> Backend["Backend API (Node.js 20 / Express 5)\nPuerto 3001 + Socket.io"]
    Backend --> Postgres[("PostgreSQL 16 (Supabase / VPS)\nPrisma ORM 6")]
    Backend --> Redis[("Redis 7 (requerido en producción)\nSocket.io Adapter, presencia, rate limit\ny deadlines de desconexión del vet")]
    Backend --> LiveKit["LiveKit Cloud SFU\nWebRTC 720p"]
    Backend --> Storage["Amazon S3 / Disco Persistente\nArchivos Clínicos"]
    Backend --> Resend["Resend API\nOTP Reset, Recetas y Scheduler"]
```

---

## 2. Backend (`backend/`) — VPS / Docker / Coolify

### 2.1 Requisitos Mínimos del Servidor
- Linux Ubuntu 22.04 / 24.04 LTS (2 vCPU, 4 GB RAM, 40 GB SSD).
- Docker + Coolify (o Compose equivalente) con terminación TLS 1.3 para soportar cookies seguras y WebSockets (`wss://`).

### 2.2 Variables de Entorno Clave
Ver plantilla completa en [.env.production.example](../.env.production.example) y [backend/.env.example](../backend/.env.example):

```env
NODE_ENV=production
PORT=3001
DATABASE_URL="postgresql://postgres:password@db-host:5432/huellicam?pgbouncer=true&connection_limit=20"
DIRECT_URL="postgresql://postgres:password@db-host:5432/huellicam"
REDIS_URL="redis://default:password@redis-host:6379"

JWT_SECRET="clave_criptografica_min_32_caracteres"
JWT_REFRESH_SECRET="otra_clave_criptografica_min_32_caracteres"

CORS_ORIGIN="https://app.huellicam.com.ar"
FRONTEND_URL="https://app.huellicam.com.ar"
CLIENT_URL="https://app.huellicam.com.ar"
COOKIE_SECURE=true
COOKIE_SAME_SITE=none
# COOKIE_DOMAIN=.huellicam.com.ar   # opcional: solo si web y API comparten el dominio raíz

LIVEKIT_URL="wss://huellicam.livekit.cloud"
LIVEKIT_API_KEY="..."
LIVEKIT_API_SECRET="..."

STORAGE_DRIVER="s3" # o "local" con volumen persistente
# UPLOAD_DIR="./uploads"            # solo con STORAGE_DRIVER=local; montar un volumen persistente
AWS_REGION="us-east-1"
AWS_BUCKET_NAME="huellicam-media-prod"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."

RESEND_API_KEY="re_..."
EMAIL_FROM="Huellicam <notificaciones@tudominio.com>"
ENABLE_EMAIL_SCHEDULER="true"

# Opcionales de ajuste: DB_POOL_LIMIT, DATABASE_CONNECTION_LIMIT, DB_POOL_TIMEOUT, DISCONNECT_DEBOUNCE_MS (ms, default 5000)
```

> **`REDIS_URL` es obligatoria en producción.** Si falta o no es una URL `redis://` / `rediss://` válida, `backend/src/config/env.ts` aborta el arranque; si Redis no responde al iniciar, `backend/src/server.ts` ejecuta `gracefulShutdown('REDIS_CONNECTION_FAILED', 1)`. Ver la sección 2.4.

### 2.3 Comandos de Despliegue del Backend
El repositorio es un monorepo con un único `package-lock.json` en la raíz, por lo que la instalación se ejecuta desde la raíz (igual que `backend/Dockerfile` y `.github/workflows/ci.yml`):

```bash
npm ci
npx prisma generate --schema backend/prisma/schema.prisma
npx prisma migrate deploy --schema backend/prisma/schema.prisma
npm run build -w backend
npm start -w backend
```

`prisma migrate deploy` requiere `DIRECT_URL` (conexión directa, sin PgBouncer) y aplica, entre otras, la migración idempotente `20261126000000_sync_consultation_lifecycle_schema`:
- En una base nueva crea las columnas de ciclo de vida de `consultations`, `consultation_audit_log` y `password_reset_tokens`, que antes solo existían en `schema.prisma`.
- En una base aprovisionada con `prisma db push` es un no-op, salvo que aún tenga los 6 literales legados de `ConsultationStatus`: en ese caso normaliza las filas (`vet_id` nulo → `WAITING`, si no → `ACTIVE`, con una fila `LEGACY_STATUS_BACKFILL` en `consultation_audit_log`) y recrea el enum con los 4 estados canónicos.
- Es seguro reejecutarla. Hacer un backup (snapshot) de PostgreSQL antes del primer `migrate deploy` en producción.

Si la base de producción fue creada con `prisma db push` y nunca tuvo historial de migraciones, `migrate deploy` falla con `P3005`. Resolver una sola vez marcando como aplicadas las migraciones anteriores a la nueva y luego desplegando:

```bash
npx prisma migrate resolve --applied 20260915000000_init --schema backend/prisma/schema.prisma
npx prisma migrate resolve --applied 20261113000000_pet_birthdate_and_email_dispatch_logs --schema backend/prisma/schema.prisma
npx prisma migrate resolve --applied 20261124000000_add_call_telemetry --schema backend/prisma/schema.prisma
npx prisma migrate deploy --schema backend/prisma/schema.prisma
```

Solo marcar como aplicadas las migraciones cuyo contenido ya está realmente en la base (por ejemplo, `calls.livekit_*` de `add_call_telemetry`); ante la duda, comparar con `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel backend/prisma/schema.prisma`.

### 2.4 Redis en Producción
Redis sostiene el adapter de Socket.io, la presencia distribuida, el rate limiting y los deadlines persistidos de 3 minutos del `VetDisconnectTracker` (ZSET). Requisitos:
- Política `maxmemory-policy noeviction` y persistencia AOF (`appendonly yes`): una evicción o un reinicio sin disco perdería los deadlines.
- Contraseña obligatoria y red privada o TLS (`rediss://`).

**Opción A — Redis en el mismo VPS** con [docker-compose.redis.yml](../docker-compose.redis.yml) (ya trae `noeviction`, AOF, contraseña y healthcheck):
```bash
REDIS_PASSWORD="<secreto-largo>" docker compose -f docker-compose.redis.yml up -d
# REDIS_URL del backend (misma red Docker / servicio de Coolify):
# redis://default:<secreto-largo>@redis:6379
```

**Opción B — Redis administrado** (Upstash u otro): usar la URL `rediss://default:<password>@<host>:6379` y verificar en el panel que la política de evicción sea `noeviction`.

**Checklist de activación (cuando exista el Redis):**
1. Levantar Redis y comprobar `redis-cli -u "$REDIS_URL" ping` → `PONG`.
2. Cargar `REDIS_URL` en las variables del backend (Coolify) y redeployar.
3. Verificar `GET /health` → `200` con `"redis": "connected"` (en producción responde `503` y `"status": "degraded"` si Redis no contesta el `PING`).
4. Verificar en los logs el arranque sin `REDIS_CONNECTION_FAILED`.
5. Con dos dispositivos: iniciar sesión en el segundo y comprobar que el primero recibe `auth:session_terminated`.
6. Si se escala a más de una réplica del backend, Redis ya es el estado compartido (adapter + presencia + deadlines); no se requiere configuración adicional.

> **Nota sobre correos y QR públicos:** El scheduler automático (`NotificationsScheduler`) se activa por defecto cuando `NODE_ENV=production` (salvo `ENABLE_EMAIL_SCHEDULER=false`). Para envíos productivos a cualquier destinatario en Resend, configurar un dominio verificado (SPF/DKIM/DMARC) en `EMAIL_FROM` y apuntar `CLIENT_URL` / `FRONTEND_URL` al dominio web final para que los códigos QR de recetas apunten a `https://app.tudominio.com/prescriptions/:id`.

---

## 3. Frontend Web (`web/`) — Vercel

El repositorio incluye [vercel.json](../vercel.json) en la raíz del monorepo:
- **Build Command:** `npm run build -w web`
- **Output Directory:** `web/dist`
- **Rewrites:** Redirección `/(.*) -> /web/dist/index.html` para soportar rutas SPA de React Router.

Si el proyecto de Vercel se configura con **Root Directory = `web`**, aplica en cambio [web/vercel.json](../web/vercel.json) (`buildCommand: "npm run build"`, `outputDirectory: "dist"`, `installCommand: "npm install"`, rewrite `/(.*) -> /index.html`). Usar una sola de las dos configuraciones por proyecto.

### Variables de Entorno en Vercel
| Variable | Ejemplo Producción | Descripción |
|---|---|---|
| `VITE_API_URL` | `https://api.huellicam.com.ar` | Base URL de la API REST |
| `VITE_WS_URL` | `https://api.huellicam.com.ar` | Base URL para Socket.io (`wss://`) |
| `VITE_LIVEKIT_URL` | `wss://huellicam.livekit.cloud` | Endpoint SFU de LiveKit |
| `VITE_SENTRY_DSN` | `https://...@sentry.io/...` | Opcional para telemetría de errores |

**Cookies Cross-Domain:** Si la Web corre en `app.huellicam.com.ar` y la API en `api.huellicam.com.ar`, ambos subdominios deben operar sobre HTTPS con `COOKIE_SECURE=true` y `COOKIE_SAME_SITE=none` en el backend.

---

## 4. Aplicación Mobile (`mobile/`) — Android / EAS

### 4.1 Variables Públicas y Firebase Push
- `EXPO_PUBLIC_WEB_URL`: URL HTTPS pública de la SPA web cargada por el shell 100% WebView (por ejemplo `https://app.huellicam.com.ar`; en desarrollo USB con `adb reverse` utiliza `http://localhost:5173`).
- `EXPO_PUBLIC_API_URL`: URL pública del backend (`https://api.huellicam.com.ar`) para registro de tokens Push.
- `EXPO_PUBLIC_WS_URL`: URL base de Socket.io.
- **Firebase FCM (Android Push en Play Store):** Colocar `google-services.json` en `mobile/google-services.json` y declarar `"googleServicesFile": "./google-services.json"` bajo `"android"` en `mobile/app.json` antes de compilar con EAS (`production`). Mientras falte ese archivo, el registro de push falla de forma controlada sin interrumpir la app.

### 4.2 Opciones de Compilación Android
1. **Google Play Store (`.aab`):**
   ```bash
   npm run build:bundle -w mobile
   ```
2. **APK de Previsualización / Distribución Directa (`.apk`):**
   ```bash
   npm run build:apk -w mobile
   ```
3. **Compilación Local sin EAS Cloud (requiere JDK 21 + Android SDK/NDK en ruta ASCII sin tildes):**
   ```bash
   cd mobile
   npx expo prebuild --platform android
   cd android
   ./gradlew assembleRelease
   ```
   El artefacto queda en `mobile/android/app/build/outputs/apk/release/app-release.apk`.

---

## 5. Verificación Pre-Despliegue

Antes de promover un cambio a producción, el pipeline de CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) valida:
1. `npx prisma validate` y `npx prisma generate`
2. `npm run check:governance`
3. `npm run typecheck`
4. `npm run lint --if-present`
5. Suites de pruebas (`backend`, `web`, `mobile`)
6. Job `security-scan` con `npm audit --audit-level=critical`

Localmente, `npm run verify:predeploy` (script de la raíz) agrupa las verificaciones previas al despliegue. La imagen del backend incluye un `HEALTHCHECK` contra `http://localhost:3001/health`, que devuelve `503` si PostgreSQL no responde o, en producción, si Redis no responde.
