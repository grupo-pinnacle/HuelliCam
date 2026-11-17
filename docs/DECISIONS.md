# Registro de Decisiones de Arquitectura (ADRs) — Huellicam

Este registro consolida las 32 decisiones de diseño adoptadas durante la evolución de **Huellicam**, reflejando qué decisiones están activas en el código y cuáles delimitan evolución futura.

---

## Índice de Decisiones

| ID | Decisión | Estado | Área |
|---|---|---|---|
| **ADR-001** | Monolito modular frente a microservicios | Implementado | Backend |
| **ADR-002** | Prisma ORM 6 sobre PostgreSQL 16 | Implementado | Base de datos |
| **ADR-003** | PostgreSQL administrado (Supabase) / Docker local | Implementado | Infraestructura |
| **ADR-004** | Autenticación JWT dual (Web cookie `HttpOnly` / Mobile `SecureStore`) + `tokenVersion` | Implementado | Seguridad / Auth |
| **ADR-005** | Soft-deletes y preservación de historial clínico (Ley 25.326) | Implementado | Compliance |
| **ADR-006** | Singleton `PrismaClient` con pool controlado | Implementado | Performance |
| **ADR-007** | Validación estricta de contratos REST con Zod | Implementado | API |
| **ADR-008** | Monorepo de 3 workspaces sin paquete `packages/shared` compilado | Implementado | Arquitectura |
| **ADR-009** | Tiempo real con Socket.io y Redis Adapter opcional | Implementado | Realtime |
| **ADR-010** | Almacenamiento desacoplado (S3 / fallback local) sin serving estático | Implementado | Storage / Seguridad |
| **ADR-011** | Notificaciones Push con Expo Push API y bandeja in-app | Implementado | Notificaciones |
| **ADR-012** | Teleconsulta WebRTC con LiveKit SFU (perfil 720p, cero PII en tokens) | Implementado | Video / WebRTC |
| **ADR-013** | Sala de espera profesional (`PENDING -> APPROVED/REJECTED`) | Implementado | Compliance / Ops |
| **ADR-014** | Registro de auditoría administrativa (`AuditLog`) | Implementado | Auditoría |
| **ADR-015** | TanStack React Query v5 para sincronización y caché en Web | Implementado | Frontend Web |
| **ADR-016** | Flujo de desarrollo móvil por USB con `adb reverse` | Implementado | DX Mobile |
| **ADR-017** | Despliegue backend autocontenido (Docker / Coolify VPS) | Adoptado | Infraestructura |
| **ADR-018** | Estrategia tripartita Android (EAS AAB, APK directo y build local) | Adoptado | Mobile Release |
| **ADR-019** | Denormalización atómica de calificaciones e índices compuestos | Implementado | Base de datos |
| **ADR-020** | Streaming temporal a disco e inspección binaria por *Magic Bytes* | Implementado | Seguridad Media |
| **ADR-021** | Pipeline CI en GitHub Actions y endurecimiento de ejecución | Implementado | CI / DevOps |
| **ADR-022** | Vercel como plataforma principal para Web SPA | Adoptado | Infraestructura Web |
| **ADR-023** | Escala unificada de calificación profesional (1 a 5 estrellas) | Implementado | Producto / Datos |
| **ADR-024** | FSM de consultas, timeouts deterministas y auditoría de concurrencia | Implementado | Backend / FSM |
| **ADR-025** | Precedencia del código fuente y esquema Prisma como fuente de verdad | Vigente | Gobernanza |
| **ADR-026** | Alertas Web Audio (`GlobalCallListener`), dossier imprimible y verificación QR pública | Implementado | Web / Telemedicina |
| **ADR-027** | Blindaje regulatorio (Leyes 25.326, 24.240, 14.072), cookies y WCAG 2.1 AA | Implementado | Legal / UX |
| **ADR-028** | Motor determinista de triaje clínico y desacoplamiento del selector de prioridad | Implementado | Backend / Clínica |
| **ADR-029** | Separación entre ficha declarativa de mascota y expediente clínico inmutable | Implementado | Clínica / Legal |
| **ADR-030** | Sanitización de tags internos en notas clínicas y layout responsivo de tarjetas | Implementado | UX Web |
| **ADR-031** | Resolución singleton de React 19/18 en Metro para el monorepo Expo SDK 54 | Implementado | Mobile / Bundler |
| **ADR-032** | Diseño de pagos marca blanca (`IPaymentGateway`) + Plan B PagoFlex | Config. base / Roadmap | Negocio / Pagos |

---

## Detalle de Decisiones Clave

### ADR-001 a ADR-008: Fundamentos de Backend, Datos y Monorepo
- **Monolito modular (`ADR-001`):** Módulos encapsulados por dominio (`auth`, `users`, `pets`, `consultations`, `prescriptions`, `calls`, `media`, `notifications`, `admin`) para evitar complejidad de red y facilitar despliegue único.
- **Prisma 6 + PostgreSQL (`ADR-002`, `ADR-003`, `ADR-006`):** Mapeo explícito `@map` a `snake_case`, instancia singleton en `backend/src/lib/prisma.ts` y migraciones versionadas en `backend/prisma/migrations/`.
- **Auth dual y revocación (`ADR-004`):** Cookies `HttpOnly` para navegadores web, `expo-secure-store` (con header `X-Client-Platform: mobile`) para móvil y campo `User.tokenVersion` para invalidar sesiones al instante sin listas negras distribuidas.
- **Contratos Zod y ausencia de `packages/shared` (`ADR-007`, `ADR-008`):** Validación declarativa en backend y sincronización limpia de tipos en `web/` y `mobile/` para evitar transpilaciones intermedias entre Vite y Metro.

### ADR-009 a ADR-014: Tiempo Real, Storage, Video y Auditoría
- **Socket.io + Redis opcional (`ADR-009`):** Multiplexación por sala (`consultation:{id}`, `user:{id}`, `device:{id}`, `role:vets`), deduplicación de chat por `clientMsgId` y fallback automático a `InMemoryAdapter` cuando no hay Redis local.
- **Storage protegido (`ADR-010`, `ADR-020`):** Subida temporal a disco (prevención OOM), validación de los primeros bytes (*Magic Bytes* JPEG/PNG/PDF), tope de 10 MB/archivo y 50 MB/día por usuario (`DailyUploadCounter`), sin `express.static` público; descarga exclusiva por `GET /api/media/:id`.
- **LiveKit SFU y cero PII (`ADR-012`):** Tokens efímeros generados en backend con identificador opaco y nombre de pila; cierre de sala automático al finalizar/cancelar la consulta.
- **Gobernanza sanitaria y auditoría (`ADR-005`, `ADR-013`, `ADR-014`):** Validación manual de veterinarios (`PENDING -> APPROVED/REJECTED`), preservación de historiales clínicos ante bajas (`deletedAt`) y trazabilidad en `AuditLog`.

### ADR-015 a ADR-023: Clientes, Infraestructura y Calidad
- **Web SPA (`ADR-015`, `ADR-022`):** React 18.3.1 LTS (fijado por compatibilidad con LiveKit Components), Vite 6, TanStack Query v5 y despliegue en Vercel (`vercel.json` en raíz).
- **Mobile Pragmático sobre WebView (`ADR-016`, `ADR-018`, `ADR-031`):** La aplicación móvil utiliza Expo SDK 54 / Expo Router y **delega las videoconsultas WebRTC al WebView embebido de la Web SPA** (`mobile/app/(app)/call/[consultationId].tsx`), inyectando sesión antes de carga (`buildAuthSeedScript`) y sincronizando eventos vía `postMessage`. Esta arquitectura pragmática se mantiene vigente hasta planificar una eventual migración al SDK nativo de LiveKit. En desarrollo local, `metro.config.js` fija el singleton de React 19.1.0 para evitar colisión con React 18.3.1 del root.

### ADR-024 a ADR-030: Máquina de Estados, Triaje y Regulación
- **FSM y Concurrencia (`ADR-024`):** Flujo principal de 4 estados (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`), timeout de cola a los 15 minutos, ventana de gracia de 3 minutos por desconexión, bloqueo de fila en reclamo y auditoría de transición en `ConsultationAuditLog`.
- **Fuentes de verdad (`ADR-025`):** El código real y `backend/prisma/schema.prisma` prevalecen sobre cualquier documentación descriptiva.
- **Triaje Determinista (`ADR-028`):** El tutor completa un intake estructurado de síntomas y duración (`ClinicalIntakeForm`) sin elegir colores de urgencia. El motor `clinicalTriage.engine.ts` calcula la severidad (`ROJO`/`AMARILLO`/`VERDE`), índice `1..10` y banderas rojas de forma determinista y auditable.
- **Ficha vs. Expediente y Sanitización (`ADR-029`, `ADR-030`):** Separación legal entre datos declarativos de mascota (editables por tutor) y evolución/recetas médicas (inmutables). En UI, `parseConsultationNotes` limpia etiquetas técnicas de sistema antes de mostrar notas al tutor.
- **Compliance Legal (`ADR-027`):** Páginas dedicadas (`/privacy`, `/terms`, `/cookies`, `/refunds`), consentimiento de términos en registro y banner accesible de cookies.

### ADR-032: Pagos Marca Blanca (Configuración Base / Roadmap)
- El núcleo clínico permanece agnóstico respecto de procesadores de pago mediante el contrato conceptual `IPaymentGateway`, contemplando Stripe/Mercado Pago como adaptadores universales (Plan A) y PagoFlex como alternativa local aislada (Plan B).
- **Estado actual:** El panel admin ya cuenta con gestión de tarifas base (`pricing-settings`), proyección ejecutiva (`executive-metrics`) y el flag `PAYMENTS_ENABLED`, mientras que la conexión efectiva con una pasarela de cobro externa queda para la siguiente etapa comercial.
