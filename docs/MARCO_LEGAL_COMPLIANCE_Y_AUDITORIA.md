# Marco Legal, Compliance y Accesibilidad — Huellicam

> **Entidad Titular:** Pinnacle Group S.A.  
> **Ámbito:** Plataforma Web (`web/`), API Backend (`backend/`) y App Mobile (`mobile/`).

---

## 1. Principios de Cumplimiento (Privacy & Legal by Design)

1. **Deslinde de Responsabilidad Médica (Ley 14.072):** Huellicam provee infraestructura tecnológica de intermediación y teleorientación; el acto médico veterinario, el diagnóstico y la prescripción corresponden exclusivamente al profesional matriculado interviniente.
2. **Advertencia de Emergencias Vitales:** La plataforma informa explícitamente que cuadros con riesgo vital inmediato requieren traslado presencial a un centro veterinario de guardia 24hs.
3. **Minimización de Datos (Ley 25.326):** Separación estricta entre datos personales de contacto y registros clínicos, sin exposición de PII en tokens multimedia.
4. **Transparencia Comercial (Ley 24.240):** Ausencia de métricas ficticias, consentimiento informado explícito en el registro y políticas claras de cancelación y reembolso.

---

## 2. Páginas y Controles Implementados en Web

| Ruta | Archivo | Contenido Regulatorio |
|---|---|---|
| `/privacy` | `web/src/pages/PrivacyPolicy.tsx` | Tratamiento de datos personales, Ley 25.326, derechos ARCO y conservación de historiales clínicos ante baja de cuenta. |
| `/terms` | `web/src/pages/TermsConditions.tsx` | Condiciones de uso, autonomía profesional (Ley 14.072), aviso de emergencias y validez de recetas digitales (SENASA Res. 1442/2021). |
| `/cookies` | `web/src/pages/CookiePolicy.tsx` | Diferenciación entre almacenamiento técnico necesario y telemetría opcional, con mecanismo de revocación. |
| `/refunds` | `web/src/pages/RefundPolicy.tsx` | Reglas de cancelación sin cargo en espera (`WAITING`), timeout automático de 15 min y ventana de desconexión técnica. |

Controles complementarios en UI:
- **`CookieConsentBanner.tsx`:** Permite elegir entre cookies estrictamente necesarias o aceptación completa de telemetría.
- **Consentimiento en Registro (`AuthExperience.tsx` / `Register.tsx`):** Casilla obligatoria no premarcada de aceptación de Términos y Políticas antes de crear cuenta.

---

## 3. Privacidad en Integraciones y Storage

| Componente | Datos Transmitidos | Medida de Protección |
|---|---|---|
| **LiveKit SFU** | ID opaco (`user.id` o `tutor_<id>:<deviceId>`) y `firstName` | Cero correos, teléfonos o matrículas en el token JWT WebRTC. |
| **Media / Storage** | Adjuntos clínicos (JPEG, PNG, PDF) | Sin serving estático público; inspección de *Magic Bytes* en subida y control de acceso por relación consulta/mascota en `GET /api/media/:id`. |
| **PostgreSQL** | Fichas clínicas y credenciales | Contraseñas con `bcryptjs`, soft-delete (`deletedAt`) y anonimización en bajas de usuario. |
| **Sentry** | Trazas de error (opcional) | Sujeto a configuración de DSN y consentimiento de cookies analíticas. |

---

## 4. Fiscalización Profesional y Trazabilidad

- **Habilitación de Veterinarios (`ADR-013`):** Toda cuenta `VET` se registra en estado `PENDING` y requiere aprobación explícita de un administrador (`PATCH /api/admin/vets/:id/approve`) para atender consultas en producción.
- **Recetas Digitales Verificables:** Cada prescripción genera un identificador único verificable públicamente mediante código QR (`/prescriptions/:id` y `/verify-rx`) exponiendo únicamente los datos necesarios de verificación profesional y tratamiento sin filtrar datos privados sensibles del tutor.
- **Auditoría Inmutable (`AuditLog`):** Registro persistente de aprobaciones/rechazos de matrícula, suspensiones, revocaciones de sesión, modificaciones administrativas y cambios de configuración.

---

## 5. Accesibilidad (WCAG 2.1 Nivel AA)

- Uso de landmarks semánticos (`<header>`, `<nav>`, `<main>`, `<section>`, `<aside>`, `<footer>`).
- Navegación completa por teclado con anillos de foco visibles (`focus-visible`) y cierre de modales con `Escape`.
- Contraste tipográfico alto entre la paleta institucional (`#183C3A`, `#0F172A`, `#609F9C` y fondos claros `#FFFAEF`/`#FFFFFF`).
- Atributos `aria-label`, `role="status"` / `aria-live` en cargas y estados vacíos, y `alt` descriptivos en imágenes.
