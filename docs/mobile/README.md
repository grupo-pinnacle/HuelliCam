# Aplicación Mobile (`mobile/`) — Huellicam

Documentación técnica de la aplicación móvil construida con **Expo SDK 54**, **React Native 0.81.4**, **Expo Router** y **`react-native-webview`**.

---

## 1. Arquitectura Actual: Shell 100% WebView

La aplicación móvil opera como un contenedor nativo liviano (`mobile/app/index.tsx`) sobre la **Web App responsive** (`web/`):
- **Toda la experiencia funcional corre sobre la SPA web** (`/login`, `/client/*`, `/vet/*`, `/call/:id`, `/prescriptions/:id`), garantizando paridad visual y funcional inmediata sin código de UI duplicado.
- **Acceso por rol:** Disponible para **Tutores (`CLIENT`)** y **Veterinarios (`VET`)**; si inicia sesión un `ADMIN`, la app muestra un aviso indicando el uso de la consola web de escritorio.
- **Capacidades nativas del contenedor:** Splash screen (`expo-splash-screen`), pantalla **Offline** con recuperación automática (`NetInfo`), botón físico **Atrás** navegando el historial web, permisos de cámara/micrófono (`expo-camera`), **WakeLock** en videoconsultas (`expo-keep-awake`), impresión/PDF nativa (`expo-print` + `Share`), apertura externa de enlaces de terceros (`Linking`), push notifications (`expo-notifications`) y deep links (`huellicam://`).

> **Decisión vigente:** Mantener una arquitectura **100% WebView** para acelerar el lanzamiento en Play Store con una única base funcional en `web/`. La construcción de una app nativa completa idéntica a la web queda planificada como evolución futura.

---

## 2. Puente Nativo ↔ WebView

La comunicación tipada entre `web/src/lib/mobileBridge.ts` y `mobile/src/lib/webviewBridge.ts` coordina:

1. **Configuración endurecida (`HARDENED_WEBVIEW_CONFIG`):**
   - `domStorageEnabled: true`, `javaScriptEnabled: true`, `sharedCookiesEnabled: true`, `thirdPartyCookiesEnabled: true`
   - `allowsInlineMediaPlayback: true`, `mediaPlaybackRequiresUserAction: false`
   - `mediaCapturePermissionGrantType: 'grant'`, `allowFileAccess: true`, `setSupportMultipleWindows: false`
   - Enrutamiento externo (`shouldOpenExternally`): navega dentro del shell para el mismo origen y deriva esquemas/dominios externos (`mailto:`, `tel:`, `wa.me`, pasarelas) al navegador del sistema.
2. **Eventos `WebView -> Nativo` (`window.ReactNativeWebView.postMessage`):**
   - `page:ready`: Oculta el splash/overlay y libera navegaciones pendientes de deep links.
   - `auth:session` / `auth:logout`: Sincroniza el token Bearer desde `AuthContext` para registrar el push token en `POST /api/notifications/register-token` y ajustar rutas por rol.
   - `wakelock:acquire` / `wakelock:release` / `call:ended`: Controla `expo-keep-awake` durante salas `/call/:id`.
   - `print:request`: Intercepta acciones de impresión en recetas (`PrescriptionDoc`, `PrescriptionView`) y expediente (`PetDossierModal`) para abrir el diálogo nativo PDF/Imprimir (`expo-print`) o compartir enlace (`Share`).
   - `external:open`: Abre enlaces web fuera del contenedor móvil.
3. **Eventos `Nativo -> WebView` (`huellicam:navigate`):**
   - `buildNativeNavigateScript` despacha un evento en `window` capturado por `MobileNavigationBridge` en `web/src/App.tsx` para navegar sin recargar el bundle ante taps de notificaciones push o enlaces `huellicam://`.

---

## 3. Push Notifications (FCM) y Deep Linking

- **Push Notifications (`notifications.service.ts`):** Registra tokens Expo/FCM en `POST /api/notifications/register-token` (`ios | android | web`). Maneja de forma segura la ausencia de credenciales Firebase durante desarrollo local o builds internos hasta agregar `google-services.json`.
- **Deep Linking (`deepLinks.ts`):** Resuelve enlaces `huellicam://call/:id`, `huellicam://consultation/:id`, `huellicam://prescriptions/:id` y `huellicam://chat/:id` (junto con payloads `CALL_INCOMING`, `MESSAGE_NEW`, `PRESCRIPTION_NEW`) directamente hacia rutas SPA de `web/`, distinguiendo prefijos `/client/*` y `/vet/*`.
- **Conexión Firebase FCM para Play Store:**
  1. Crear proyecto Android en Firebase Console con package `com.huellicam.app` y descargar `google-services.json` en `mobile/google-services.json` (incluido en `.gitignore` si contiene llaves locales o configurado vía secreto EAS).
  2. Declarar `"googleServicesFile": "./google-services.json"` dentro de `"android"` en `mobile/app.json` y subir las credenciales FCM en EAS (`eas credentials`).
- **Aislamiento de React en Monorepo (`metro.config.js`):** Fija el singleton de React 19.1.0 y React Native 0.81.4 dentro de `mobile/node_modules/` evitando colisiones con React 18.3.1 usado por `web/`.

---

## 4. Estructura del Workspace

```text
mobile/
├── app/
│   ├── _layout.tsx                 # Stack raíz, SafeAreaProvider y SplashScreen
│   ├── index.tsx                   # Contenedor 100% WebView, BackHandler, NetInfo, WakeLock y Print
│   └── +not-found.tsx              # Fallback y redirección de deep links huellicam://
├── src/
│   ├── components/                 # ShellFallbackScreens (Offline, Error y Loading)
│   ├── lib/                        # api.ts, webviewBridge.ts, deepLinks.ts, callPermissions.ts
│   ├── services/                   # notifications.service.ts
│   ├── theme/                      # tokens.ts (#FFFBEF / #315F5D)
│   ├── types/                      # Contratos TypeScript del shell y puente WebView
│   └── __tests__/                  # Suite Jest unitaria del shell, bridge, push y deep links
├── assets/                         # Iconos, adaptive-icon, splash y notification-icon de Huellicam
├── app.json
└── metro.config.js
```

---

## 5. Desarrollo Local y Verificación

En desarrollo contra tu máquina local, WebRTC (`getUserMedia`) dentro de Android WebView requiere contexto seguro (`https://` o `http://localhost`):

```bash
# 1. Levantar Backend (:3001) y Web SPA (:5173)
npm run dev

# 2. En dispositivo Android por USB: redirigir puertos locales para habilitar cámara/mic en localhost
adb reverse tcp:5173 tcp:5173
adb reverse tcp:3001 tcp:3001

# 3. Levantar bundler de Expo
npm run dev:mobile

# Validación TypeScript y suite Jest
npm run typecheck -w mobile
npm test -w mobile

# Compilación Android (APK interno o AAB Play Store)
npm run build:apk -w mobile
npm run build:bundle -w mobile
```
