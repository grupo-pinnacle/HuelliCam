# Frontend Web (`web/`) — Huellicam

Documentación técnica de la aplicación SPA web construida con **React 18.3.1 (LTS)**, **Vite 6**, **Tailwind CSS v3** y **TanStack Query v5**.

---

## 1. Stack y Decisiones Técnicas

| Tecnología | Versión | Rol |
|---|---|---|
| React / React DOM | `18.3.1` | Runtime UI fijado en LTS por compatibilidad con `@livekit/components-react`. |
| Vite | `6.x` | Bundler ESM, dev server (puerto `5173`) y compilación productiva (`web/dist`). |
| React Router DOM | `7.x` | Enrutamiento SPA con carga diferida (`React.lazy` + `Suspense`). |
| TanStack React Query | `5.x` | Caché y sincronización de consultas (`staleTime: 5 min`, `retry: 1`). |
| Axios | `1.7.x` | Cliente HTTP con interceptor de refresco concurrente (`failedQueue`). |
| Socket.io Client | `4.8.x` | Alertas globales de llamada entrante, cola veterinaria y chat en vivo. |
| LiveKit Components | `2.8.x` | Videoconsultas WebRTC (`<LiveKitRoom>` + `<VideoConference />`). |
| Storybook / Vitest | `8.6.x` / `3.0.x` | Taller aislado de componentes (`ui/`) y suite unitaria/integración. |

---

## 2. Mapa de Rutas (`web/src/App.tsx`)

Todas las vistas principales se cargan de forma perezosa y están protegidas por wrappers de rol (`ClientWrapper`, `VetWrapper`, `AdminWrapper`):

| Ruta | Componente | Acceso | Propósito |
|---|---|---|---|
| `/` | `pages/Landing.tsx` | Público | Portada comercial, propuesta de valor y acceso a la plataforma. |
| `/login`, `/register`, `/register/*`, `/forgot-password` | `pages/AuthExperience.tsx` | Público | Inicio de sesión, registro diferenciado (Tutor / Veterinario) y recuperación por OTP de 6 dígitos. |
| `/client`, `/client/*` | `pages/ClientApp.tsx` | `CLIENT` | Portal del tutor: mascotas, formulario de admisión clínica (`ClinicalIntakeForm`), consultas, chat, recetas y perfil. |
| `/vet`, `/vet/*` | `vet/VetApp.tsx` | `VET` | Consola clínica: estado de disponibilidad, cola priorizada por triaje, consultas, pacientes, agenda, mensajería y emisión de recetas. |
| `/call/:id` | `vet/CallRoom.tsx` | `CLIENT`, `VET`, `ADMIN` | Sala híbrida de videoconsulta (LiveKit WebRTC + `ClinicalChatThread` + soporte puente WebView móvil). |
| `/admin`, `/admin/*` | `pages/AdminApp.tsx` | `ADMIN` | Panel de administración: validación SENASA, CRUD de usuarios/mascotas, auditoría, `AdminFeatureFlagsModal` y `AdminExecutiveMetrics`. |
| `/prescriptions/:id`, `/verify-rx` | `pages/PrescriptionView.tsx` | Público | Visor imprimible A4 y verificación pública de receta mediante código QR. |
| `/privacy`, `/terms`, `/cookies`, `/refunds` | `pages/PrivacyPolicy.tsx`, etc. | Público | Páginas legales y gestión de preferencias de cookies. |
| `*` | `pages/NotFound.tsx` | Público | Fallback 404. |

---

## 3. Gestión de Sesión, Tiempo Real y Aislamiento de Estilos

- **Autenticación y Refresco (`context/AuthContext.tsx`, `services/api.ts`):**
  - El refresco usa cookie `HttpOnly` (`withCredentials: true`).
  - Ante respuestas `401`, el interceptor pausa peticiones concurrentes en `failedQueue`, ejecuta un único `POST /api/auth/refresh` y reintenta la cola completa.
  - Si el backend responde `SESSION_REVOKED`, dispara el evento de terminación de sesión y muestra `SessionTerminatedModal`.
  - Se inyecta el header `x-device-id` para trazabilidad de sesión activa entre dispositivos.
- **Llamadas Entrantes (`components/call/GlobalCallListener.tsx`):** Escucha `call:incoming` cuando hay sesión iniciada y sintetiza timbre vía Web Audio API sin depender de archivos de audio externos.
- **Estilos Aislados (`ScopedStyle`):** Cada portal (`landing`, `auth`, `client`, `vet`, `admin`) carga su hoja CSS acotada para evitar colisiones visuales entre el portal del tutor, la consola clínica y la landing.

---

## 4. Comandos del Workspace Web

```bash
npm run dev:web           # Servidor de desarrollo Vite (http://localhost:5173)
npm run typecheck -w web  # Verificación TypeScript (tsc --noEmit)
npm test -w web           # Suite Vitest (single-run)
npm run build -w web      # Compilación productiva en web/dist
npm run storybook -w web  # Catálogo de componentes UI (puerto 6006)
```
