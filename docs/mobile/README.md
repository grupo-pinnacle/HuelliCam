# Aplicación Mobile (`mobile/`) — Huellicam

Documentación técnica de la aplicación móvil construida con **Expo SDK 54**, **React Native 0.81.4** y **Expo Router**.

---

## 1. Arquitectura Actual: Híbrido con WebView para Videollamadas

La aplicación móvil opera actualmente bajo un enfoque pragmático híbrido:
- **Flujos nativos en Expo Router (`mobile/app/`):** Inicio de sesión, registro, inicio por rol (`(app)/index.tsx` + `VetWorkspace.tsx`), gestión básica de mascotas, chat por Socket.io, notificaciones, perfil y visor de recetas.
- **Videoconsultas sobre WebView de la Web App (`mobile/app/(app)/call/[consultationId].tsx`):** Toda videollamada WebRTC se ejecuta cargando la ruta `/call/:consultationId` de la SPA web dentro de `react-native-webview`.

> **Decisión vigente:** Mantener las videoconsultas sobre el WebView de la aplicación web permite garantizar estabilidad, paridad visual y cero duplicación de lógica LiveKit mientras se prioriza el producto web. Aunque `@livekit/react-native` figura declarado en `mobile/package.json` para una eventual evolución futura, **no está activado en runtime**.

---

## 2. Puente Nativo ↔ WebView (`mobile/src/lib/webviewBridge.ts`)

Para que la sala de videollamada web funcione dentro del WebView móvil sin redirecciones ni bloqueos de hardware:

1. **Inyección Temprana de Sesión (`buildAuthSeedScript`):**
   - La SPA web lee el estado de autenticación al evaluar los módulos iniciales.
   - El contenedor móvil inyecta el script en `injectedJavaScriptBeforeContentLoaded` antes de que se ejecute el bundle web, sembrando `accessToken` y `user` en `window.localStorage` y retornando `true;`.
2. **Configuración Endurecida (`HARDENED_WEBVIEW_CONFIG`):**
   - `domStorageEnabled: true`, `javaScriptEnabled: true`, `sharedCookiesEnabled: true`, `thirdPartyCookiesEnabled: true`
   - `allowsInlineMediaPlayback: true`, `mediaPlaybackRequiresUserAction: false`
   - `mediaCapturePermissionGrantType: 'grant'` y `allowFileAccess: true`
   - `originWhitelist: ['http://*', 'https://*']`
3. **Permisos y Diagnóstico (`callPermissions.ts`, `isLoopbackUrl`):**
   - Solicita permisos nativos de cámara y micrófono vía `expo-camera` antes de montar el WebView.
   - Detecta si `EXPO_PUBLIC_WEB_URL` apunta a `localhost`/`127.0.0.1` (error frecuente en dispositivos físicos reales) mostrando un mensaje explícito en lugar de una pantalla en blanco.
4. **Eventos Bidireccionales (`window.ReactNativeWebView.postMessage`):**
   - `page:ready`: La web confirma hidratación y el shell oculta el indicador de carga.
   - `call:ended`: Notifica finalización de consulta y retorna a la pantalla anterior.

---

## 3. Autenticación, Push y Deep Linking

- **Auth Dual (`mobile/src/lib/api.ts`, `authStore.ts`):** Envía el header `X-Client-Platform: mobile` para recibir el `refreshToken` en el payload JSON y almacenarlo cifrado en `expo-secure-store`, manteniendo el `accessToken` en memoria y gestionando concurrencia `401` mediante cola `failedQueue`.
- **Push Notifications (`notifications.service.ts`):** Registra tokens en `POST /api/notifications/register-token` (validando plataforma `ios | android | web`) y escucha taps sobre notificaciones entrantes.
- **Deep Linking (`deepLinks.ts`):** Mapea URLs del esquema de la app y payloads de notificación (`CALL_INCOMING`, `MESSAGE_NEW`, `PRESCRIPTION_NEW`) hacia rutas de Expo Router (`call`, `consultation`, `prescriptions`, `chat`, `review`).
- **Aislamiento de React en Monorepo (`metro.config.js`):** Bloquea el `react` 18.3.1 del root (usado por `web/`) y redirige toda resolución de `react`, `react-dom` y `react-native` a `mobile/node_modules/` (React 19.1.0).

---

## 4. Estructura Principal del Workspace

```text
mobile/
├── app/
│   ├── _layout.tsx                 # Stack raíz, initAuth y listeners push
│   ├── (auth)/                     # login.tsx, register.tsx
│   └── (app)/                      # Tabs autenticados, gate SENASA, mascotas, chat, call/[consultationId].tsx
├── src/
│   ├── components/                 # IncomingCallModal, VetWorkspace, AttachmentView, Field, ScreenState, etc.
│   ├── hooks/                      # useConsultations, usePets, useProfile
│   ├── lib/                        # api.ts, authStore.ts, socket.ts, webviewBridge.ts, deepLinks.ts, navGuards.ts
│   ├── services/                   # Servicios REST y señalización
│   ├── theme/                      # tokens.ts
│   └── validation/                 # Esquemas locales de validación
├── app.json
└── metro.config.js
```

---

## 5. Comandos de Desarrollo y Testing

```bash
# Levantar bundler de Expo
npm run dev:mobile

# Con USB en Windows (incluye adb reverse tcp:3001 y tcp:8081)
.\start.ps1

# Validación TypeScript y suite Jest
npm run typecheck -w mobile
npm test -w mobile

# Compilación Android (requiere EAS login o JDK 21 + Android SDK en ruta ASCII)
npm run build:apk -w mobile
```
