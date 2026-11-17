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
    Backend --> Redis[("Redis 7\nSocket.io Adapter")]
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

LIVEKIT_URL="wss://huellicam.livekit.cloud"
LIVEKIT_API_KEY="..."
LIVEKIT_API_SECRET="..."

STORAGE_DRIVER="s3" # o "local" con volumen persistente
AWS_REGION="us-east-1"
AWS_BUCKET_NAME="huellicam-media-prod"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."

RESEND_API_KEY="re_..."
EMAIL_FROM="Huellicam <notificaciones@tudominio.com>"
ENABLE_EMAIL_SCHEDULER="true"
```

### 2.3 Comandos de Despliegue del Backend
```bash
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

> **Nota sobre correos y QR públicos:** El scheduler automático (`NotificationsScheduler`) se activa por defecto cuando `NODE_ENV=production` (salvo `ENABLE_EMAIL_SCHEDULER=false`). Para envíos productivos a cualquier destinatario en Resend, configurar un dominio verificado (SPF/DKIM/DMARC) en `EMAIL_FROM` y apuntar `CLIENT_URL` / `FRONTEND_URL` al dominio web final para que los códigos QR de recetas apunten a `https://app.tudominio.com/prescriptions/:id`.

---

## 3. Frontend Web (`web/`) — Vercel

El repositorio incluye [vercel.json](../vercel.json) en la raíz del monorepo:
- **Build Command:** `npm run build -w web`
- **Output Directory:** `web/dist`
- **Rewrites:** Redirección `/(.*) -> /web/dist/index.html` para soportar rutas SPA de React Router.

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

### 4.1 Variables Públicas
- `EXPO_PUBLIC_API_URL`: URL pública del backend (`https://api.huellicam.com.ar`).
- `EXPO_PUBLIC_WS_URL`: URL de Socket.io.
- `EXPO_PUBLIC_WEB_URL`: URL de la SPA web utilizada por el puente WebView para videoconsultas (`/call/:consultationId`).

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
4. Suites de pruebas (`backend`, `web`, `mobile`)
