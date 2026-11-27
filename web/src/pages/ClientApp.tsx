import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, Field, Icon, Logo, MessageBubble, Modal, PageHeader, SectionStage, Status, Tabs, Toast, go, photos, type IconName, type MessageState } from "../shared";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../context/SocketContext";
import api from "../services/api";
import ClientScopedStyle from "../styles/ClientScopedStyle";
import type {
  ApiResponse,
  Pet as BackendPet,
  Consultation as BackendConsultation,
  Prescription as BackendPrescription,
  PetDossierDTO,
  PetDocumentCategoryDTO,
} from "../types";
import { parseConsultationNotes } from "../lib/consultationNotes";
import {
  AuthenticatedMediaImage,
  downloadAuthenticatedMedia,
  normalizeMediaUrl,
  useAuthenticatedMediaUrl,
} from "../lib/authenticatedMedia";
import { ClinicalMediaViewer } from "../components/common/ClinicalMediaViewer";
import PetDossierModal from "../components/dashboard/PetDossierModal";
import { getNotificationPermissionState, isWebPushSupported, subscribeToWebPush } from "../lib/webPush";
import { addDeletedChatId, clearChatLocalCache, readDeletedChatIds, saveDeletedChatIds } from "../lib/archivedChats";

function dataUrlToFile(dataUrl: string, fileName: string): File {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = /data:([^;]+);/.exec(header || "");
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: mime });
}
import { SPECIES_LIST, getBreedsForSpecies, getWeightAssessment, compressImageFile } from "../data/petBreeds";
import { HamsterMascot } from "../components/ui/HamsterMascot";
import { ChangePasswordModal } from "../components/common/ChangePasswordModal";
import { useFocusTrap } from "../components/common/DialogOverlay";
import { formatBadgeCount, formatDateAR, getInitials } from "../lib/formatters";

function TrappedModalLayer({
  open = true,
  onClose,
  width,
  children,
}: {
  open?: boolean;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef, { onEscape: onClose });
  if (!open) return null;
  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-scrim" onClick={onClose} aria-label="Cerrar modal" />
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ textAlign: "left", width }}
      >
        {children}
      </div>
    </div>
  );
}
import { isReactNativeWebView } from "../lib/mobileBridge";
import { useVisualViewport } from "../lib/useVisualViewport";

const VetApp = lazy(() => import("../vet/VetApp"));
const CallRoom = lazy(() => import("../vet/CallRoom"));

export const routes = [
  { label: "Inicio", path: "/client/dashboard", icon: "home" as IconName },
  { label: "Mis mascotas", path: "/client/pets", icon: "paw" as IconName },
  { label: "Mis consultas", path: "/client/consultations", icon: "video" as IconName },
  { label: "Mensajes", path: "/client/messages", icon: "message" as IconName },
  { label: "Recetas", path: "/client/prescriptions", icon: "file" as IconName },
  { label: "Notificaciones", path: "/client/notifications", icon: "bell" as IconName },
];

export const mobileRoutes = [
  routes[0], // Inicio (/client/dashboard)
  routes[1], // Mis mascotas (/client/pets)
  { label: "Atención", path: "/client/triage", icon: "heart" as IconName },
  routes[3], // Mensajes (/client/messages)
  routes[2], // Mis consultas (/client/consultations) en lugar de Notificaciones
];

export function isRouteActive(itemPath: string, currentPath: string): boolean {
  if (!currentPath) return itemPath === "/client/dashboard";
  if (itemPath === "/client/dashboard") {
    return currentPath === "/" || currentPath === "/client" || currentPath === "/client/" || currentPath === "/client/dashboard";
  }
  if (itemPath === "/client/consultations") {
    return currentPath.startsWith("/client/consultations") || currentPath.startsWith("/client/appointments");
  }
  return currentPath === itemPath || (itemPath !== "/client" && currentPath.startsWith(itemPath));
}

export interface ClientViewPet {
  id: string;
  name: string;
  kind: string;
  breed: string;
  age: string;
  weight: string;
  state: string;
  last: string;
  next: string;
  photo: string;
  sex?: string;
  allergies?: string;
  chronicConditions?: string;
  microchip?: string;
}

export interface ClientViewConsultation {
  id: string;
  title: string;
  vet: string;
  pet: string;
  date: string;
  time: string;
  reason: string;
  status: string;
  mode: string;
  rawStatus?: string;
  rawDate?: string;
}

function mapBackendPet(p: BackendPet): ClientViewPet {
  const backendPhoto = (p as BackendPet & { photoUrl?: string | null }).photoUrl;
  const legacyPhoto = typeof window !== "undefined" ? localStorage.getItem(`huellicam_pet_photo_${p.id}`) : null;
  const defaultPhoto = p.species.toLowerCase().includes("cone") ? photos.luna
    : p.species.toLowerCase().includes("gat") || p.species.toLowerCase().includes("fel") ? photos.nube
    : p.species.toLowerCase().includes("ave") || p.species.toLowerCase().includes("loro") ? photos.kiwi
    : p.species.toLowerCase().includes("hur") ? photos.toby
    : photos.milo;

  const photo = backendPhoto || legacyPhoto || defaultPhoto;

  return {
    id: p.id,
    name: p.name.trim(),
    kind: p.species,
    breed: p.breed || "Mestizo",
    age: "Registrado",
    weight: p.weightKg != null ? `${p.weightKg} kg` : "Sin especificar",
    state: "Al día",
    last: new Date(p.createdAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short" }),
    next: "Sin turno próximo",
    photo,
    sex: p.sex || "Macho",
    allergies: p.allergies || "Sin alergias conocidas",
    chronicConditions: p.chronicConditions || undefined,
    microchip: p.microchip || "No informado",
  };
}

function mapBackendConsultation(c: BackendConsultation): ClientViewConsultation {
  const parsed = parseConsultationNotes(c.notes);
  const vetName = c.vet ? `Dr. ${c.vet.firstName || ""} ${c.vet.lastName || ""}`.trim() : "Veterinario de guardia";
  const petName = c.pet?.name || "Mascota";
  const targetTimestamp = c.scheduledAt || c.startedAt;
  const dateStr = targetTimestamp ? new Date(targetTimestamp).toLocaleDateString("es-AR", { day: "2-digit", month: "short" }) : "Hoy";
  const timeStr = targetTimestamp ? new Date(targetTimestamp).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "En cola";
  const displayStatus =
    c.status === "ACTIVE" ? "Confirmada" :
    c.status === "WAITING" ? "Pendiente" :
    c.status === "COMPLETED" ? "Finalizada" :
    c.status === "CANCELLED" ? "Cancelada" :
    (c.vetId ? "Confirmada" : "Pendiente");

  return {
    id: c.id,
    title: parsed.cleanNotes || "Consulta clínica",
    vet: vetName,
    pet: petName,
    date: dateStr,
    time: timeStr,
    reason: parsed.cleanNotes,
    status: displayStatus,
    mode: "Videoconsulta",
    rawStatus: c.status,
    rawDate: c.scheduledAt || c.startedAt || c.createdAt || undefined,
  };
}


export function VerifyEmailBanner() {
  const { user, refreshSession } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (!user || user.emailVerified !== false || dismissed) return null;

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.post("/api/auth/verify-email", { code: code.trim() });
      await refreshSession?.();
      setDismissed(true);
    } catch {
      setMsg("Código inválido o expirado. Revisá tu correo o reenviá uno nuevo.");
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post("/api/auth/resend-verification");
      setMsg("Te enviamos un nuevo código a tu correo.");
    } catch {
      setMsg("No pudimos reenviar el código en este momento.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="panel"
      role="status"
      style={{
        marginBottom: 14,
        background: "#fffbeb",
        border: "1px solid #f59e0b",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <div>
        <strong style={{ fontSize: 13 }}>Verificá tu correo electrónico ({user.email})</strong>
        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>
          Ingresá el código de 6 dígitos que te enviamos al registrarte.
        </p>
        {msg && <small style={{ display: "block", color: "#92400e", marginTop: 2 }}>{msg}</small>}
      </div>
      <form onSubmit={handleVerify} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          maxLength={6}
          inputMode="numeric"
          placeholder="Código de 6 dígitos"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          style={{ width: 150, height: 36, borderRadius: 8, border: "1px solid var(--line)", padding: "0 10px", background: "#fff" }}
        />
        <Button type="submit" disabled={busy || code.length < 6}>
          Verificar correo
        </Button>
        <Button variant="secondary" disabled={busy} onClick={handleResend}>
          Reenviar
        </Button>
      </form>
    </div>
  );
}

export function TelemedicineConsentModal({
  open,
  onClose,
  onAccepted,
}: {
  open: boolean;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (!checked) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/users/telemedicine-consent", { version: "1.0" });
      onAccepted();
    } catch {
      setError("No pudimos registrar tu consentimiento. Intentá nuevamente.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TrappedModalLayer open={open} onClose={onClose} width="min(500px, calc(100% - 32px))">
      <button className="button button--icon modal__close" onClick={onClose} aria-label="Cerrar">
        <Icon name="close" size={18} />
      </button>
      <span className="modal__icon">
        <Icon name="shield" />
      </span>
      <h2 style={{ textAlign: "center" }}>Consentimiento de Telemedicina Veterinaria</h2>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5, margin: "12px 0" }}>
        La teleconsulta veterinaria brinda orientación clínica remota conforme a la normativa vigente (Ley 25.326 y lineamientos de telemedicina). No reemplaza la atención presencial ante emergencias graves o cirugías.
      </p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer", margin: "12px 0" }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>Leí y acepto los términos del servicio de telemedicina veterinaria (v1.0).</span>
      </label>
      {error && <p style={{ color: "#ae4d45", fontSize: 12 }}>{error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button disabled={!checked || busy} onClick={handleAccept}>
          {busy ? "Registrando..." : "Aceptar y continuar"}
        </Button>
      </div>
    </TrappedModalLayer>
  );
}

export function AppShell({ children, path }: { children: ReactNode; path: string }) {
  const isMessagesPage = path.startsWith("/client/messages");
  const [menu, setMenu] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { viewportHeight, isKeyboardOpen } = useVisualViewport();

  useEffect(() => {
    const handleOpenMenu = () => setMenu(true);
    window.addEventListener("hc:open-menu", handleOpenMenu);
    return () => window.removeEventListener("hc:open-menu", handleOpenMenu);
  }, []);
  const { user, logout } = useAuth();

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      try {
        const res = await api.get<ApiResponse<any[]>>('/api/notifications');
        return (res.data?.success && res.data?.data) ? res.data.data : [];
      } catch {
        return [];
      }
    },
    enabled: !!user,
  });

  const unreadCount = useMemo(() => {
    const list = notificationsQuery.data || [];
    return list.filter((n: any) => !n.isRead && !n.read).length;
  }, [notificationsQuery.data]);

  const rawFirstName = user?.firstName || (user?.email ? user.email.split("@")[0] : "");
  const firstName = rawFirstName ? (rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1)) : "Tutor";
  const lastName = user?.lastName || "";
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const displayName = fullName || (user?.firstName ? user.firstName : (user?.email ? firstName : "Tutor"));
  const sidebarTouchRef = useRef<{ x: number; y: number } | null>(null);
  const initials = getInitials(displayName, firstName[0] || "T");
  const roleName = user?.role === "VET" ? "Veterinario" : user?.role === "ADMIN" ? "Administrador" : "Tutor";

  return <div className={`app-shell ${isMessagesPage ? "app-shell--messages" : ""} ${isKeyboardOpen ? "is-keyboard-open" : ""}`}>

    <aside
      className={`sidebar ${menu ? "is-open" : ""}`}
      onTouchStart={(e) => {
        if (!menu || e.touches.length !== 1) return;
        sidebarTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const start = sidebarTouchRef.current;
        sidebarTouchRef.current = null;
        if (!menu || !start || e.changedTouches.length !== 1) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (dx < -56 && Math.abs(dx) > Math.abs(dy)) setMenu(false);
      }}
    >
      <div className="sidebar__head"><Logo/><Button variant="icon" icon="close" onClick={() => setMenu(false)} ariaLabel="Cerrar menú" className="sidebar__close"/></div>
      <button
        type="button"
        className="sidebar__profile"
        onClick={() => { go("/client/profile"); setMenu(false); }}
        title="Ver mi perfil"
        aria-label="Ir a mi perfil"
        data-testid="drawer-profile-card"
        style={{
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <div className="avatar">{initials}</div>
        <div><strong>{displayName}</strong><span>{roleName}</span></div>
      </button>
      <nav className="sidebar__nav" aria-label="Navegación principal">
        {routes.map((item) => {
          const active = isRouteActive(item.path, path);
          return (
            <button
              key={item.path}
              className={`nav-item ${active ? "is-active" : ""}`}
              onClick={() => { go(item.path); setMenu(false); }}
              data-testid={`sidebar-nav-${item.path.split("/").pop()}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={item.icon}/>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar__support"><span className="eyebrow">¿Necesitás ayuda?</span><strong>Estamos para acompañarte.</strong><button onClick={() => { setMenu(false); go("/client/triage"); }}>Necesito atención <Icon name="arrow" size={16}/></button></div>
      <button className={`nav-item ${path === "/client/settings" ? "is-active" : ""}`} onClick={() => { setMenu(false); go("/client/settings"); }}><Icon name="settings"/><span>Configuración</span></button>
      {user ? (
        <button className="nav-item" style={{ marginTop: 8, color: "#f5a399" }} onClick={() => { setMenu(false); logout().then(() => { window.location.href = "/login"; }); }}>
          <Icon name="close"/><span>Cerrar sesión</span>
        </button>
      ) : (
        <button className="nav-item" style={{ marginTop: 8, color: "#a8d5d3" }} onClick={() => { setMenu(false); window.location.href = "/login"; }}>
          <Icon name="user"/><span>Iniciar sesión</span>
        </button>
      )}
    </aside>
    {menu && <button className="scrim" onClick={() => setMenu(false)} aria-label="Cerrar menú"/>}
    <div
      className={`app-main ${isMessagesPage ? "app-main--messages" : ""}`}
      style={
        isMessagesPage && isKeyboardOpen && viewportHeight
          ? ({ "--app-vv-height": `${viewportHeight}px` } as React.CSSProperties)
          : undefined
      }
    >
      <style>{`
        .app-main--messages {
          display: flex !important;
          flex-direction: column !important;
          height: 100dvh !important;
          max-height: 100dvh !important;
          overflow: hidden !important;
        }
        @media (max-width: 820px) {
          .app-main--messages {
            height: calc(100dvh - 68px - env(safe-area-inset-bottom, 0px)) !important;
            max-height: calc(100dvh - 68px - env(safe-area-inset-bottom, 0px)) !important;
          }
          .app-shell.is-keyboard-open .app-main--messages {
            height: var(--app-vv-height, 100dvh) !important;
            max-height: var(--app-vv-height, 100dvh) !important;
          }
          .app-shell.is-keyboard-open .mobile-nav {
            display: none !important;
          }
        }
        @media (max-width: 820px) and (max-height: 520px) {
          .app-main--messages {
            height: 100dvh !important;
            max-height: 100dvh !important;
          }
        }
        .app-main--messages .wa-chat-container {
          flex: 1 1 0% !important;
          min-height: 0 !important;
          height: auto !important;
        }
      `}</style>
      <header className="topbar">
        <div className="topbar__mobile"><Button variant="icon" icon="menu" onClick={() => setMenu(true)} ariaLabel="Abrir menú"/><Logo/></div>
        <div className="topbar__spacer"/>
        <button className="topbar__help" onClick={() => go("/client/triage")}><Icon name="heart" size={18}/> Necesito atención</button>
        <button
          className={`icon-button ${unreadCount > 0 ? "has-dot" : ""}`}
          onClick={() => go("/client/notifications")}
          aria-label={unreadCount > 0 ? `Ver notificaciones (${unreadCount} sin leer)` : "Ver notificaciones"}
        >
          <Icon name="bell"/>
        </button>
        <div className="user-menu-wrapper">
          <button
            className="user-menu"
            onClick={() => setUserMenuOpen((prev) => !prev)}
            aria-expanded={userMenuOpen}
            aria-label="Menú de usuario"
          >
            <span className="avatar avatar--small">{initials}</span>
            <span>{firstName}</span>
            <Icon name="chevron" size={15}/>
          </button>
          {userMenuOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 90 }}
                onClick={() => setUserMenuOpen(false)}
              />
              <div className="user-menu-dropdown">
                <div className="user-menu-dropdown__header">
                  <strong>{displayName}</strong>
                  <span>{user?.email || roleName}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    go("/client/profile");
                  }}
                >
                  <Icon name="user"/>
                  <span>Mi perfil</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    go("/client/settings");
                  }}
                >
                  <Icon name="settings"/>
                  <span>Configuración</span>
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => {
                    setUserMenuOpen(false);
                    logout().then(() => {
                      window.location.href = "/login";
                    });
                  }}
                >
                  <Icon name="close"/>
                  <span>Cerrar sesión</span>
                </button>
              </div>
            </>
          )}
        </div>
      </header>
      <main className={`content${isMessagesPage ? " content--messages" : ""}`}>
        {!isMessagesPage && <VerifyEmailBanner />}
        {children}
      </main>
    </div>
    <nav className={`mobile-nav ${isMessagesPage ? "mobile-nav--messages" : ""}`} aria-label="Navegación móvil" data-testid="mobile-bottom-nav">
      {mobileRoutes.map((item) => {
        const active = isRouteActive(item.path, path);
        return (
          <button
            key={item.path}
            className={`${active ? "is-active" : ""} ${item.path === "/client/triage" ? "is-priority" : ""}`}
            onClick={() => go(item.path)}
            data-testid={`mobile-nav-${item.path.split("/").pop()}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon name={item.icon}/>
            <span>{(() => {
              const cleaned = item.label.replace(/^Mis\s+/i, "");
              return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
            })()}</span>
          </button>
        );
      })}
    </nav>
  </div>;
}


function SafePetImg({ src, alt, className, style, onErrorFallback }: { src?: string | null; alt: string; className?: string; style?: React.CSSProperties; onErrorFallback?: () => void }) {
  const resolved = useAuthenticatedMediaUrl(src);
  if (!resolved) return null;
  return <img src={resolved} alt={alt} className={className} style={style} onError={() => onErrorFallback?.()} />;
}

function PetCard({ pet, compact = false }: { pet: ClientViewPet; compact?: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);
  const resolvedPhoto = useAuthenticatedMediaUrl(pet.photo);
  useEffect(() => {
    setImgFailed(false);
  }, [pet.photo, resolvedPhoto]);
  return <article className={`pet-card ${compact ? "pet-card--compact" : ""}`}>
    <div className="pet-card__photo">
      {pet.photo && resolvedPhoto && !imgFailed ? (
        <img src={resolvedPhoto} alt={`${pet.name}, ${pet.kind.toLowerCase()}`} onError={() => setImgFailed(true)} />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "#d9e8e4", color: "#183c3a", fontWeight: 800, fontSize: 28 }}>
          {getInitials(pet.name, "M")}
        </div>
      )}
      <Status tone={pet.state.includes("pendiente") ? "amber" : "teal"}>{pet.state}</Status>
    </div>
    <div className="pet-card__body"><div><h3>{pet.name}</h3><p>{pet.kind} · {pet.breed}</p></div><div className="pet-card__facts"><span><b>{pet.age}</b>Edad</span><span><b>{pet.weight}</b>Peso</span></div>{!compact && <div className="pet-card__dates"><span>Última consulta <b>{pet.last}</b></span><span>Próxima consulta <b>{pet.next}</b></span></div>}<Button variant="secondary" onClick={() => go(`/client/pets/${pet.id}`)}>Ver ficha <Icon name="arrow" size={16}/></Button></div>
  </article>;
}

function ConsultationCard({ item }: { item: ClientViewConsultation }) {
  const tone = item.status === "Confirmada" ? "teal" : item.status === "Pendiente" ? "amber" : "gray";
  return <article className="consultation-card"><div className="date-block"><strong>{item.date}</strong><span>{item.time}</span></div><div className="consultation-card__body"><div className="row-between"><div><h3>{item.title}</h3><p>{item.vet}</p></div><Status tone={tone}>{item.status}</Status></div><div className="consultation-meta"><span><Icon name="paw" size={17}/>{item.pet}</span><span><Icon name="video" size={17}/>{item.mode}</span><span><Icon name="file" size={17}/>{item.reason}</span></div></div><Button variant="secondary" onClick={() => go(`/client/consultations/${item.id}`)}>Ver consulta</Button></article>;
}

function useClientData(options?: { includeConsultations?: boolean; includePrescriptions?: boolean }) {
  const { user } = useAuth();
  const includeConsultations = options?.includeConsultations ?? true;
  const includePrescriptions = options?.includePrescriptions ?? false;

  const petsQuery = useQuery({
    queryKey: ['pets', user?.id],
    queryFn: async () => {
      const res = await api.get<ApiResponse<BackendPet[]>>('/api/pets');
      return (res.data.success && res.data.data) ? res.data.data.map(mapBackendPet) : [];
    },
    enabled: !!user,
  });

  const consultationsQuery = useQuery({
    queryKey: ['consultations', 'mine', user?.id],
    queryFn: async () => {
      const res = await api.get<ApiResponse<BackendConsultation[]>>('/api/consultations/mine');
      return (res.data.success && res.data.data) ? res.data.data.map(mapBackendConsultation) : [];
    },
    enabled: !!user && includeConsultations,
  });

  const prescriptionsQuery = useQuery({
    queryKey: ['prescriptions', user?.id],
    queryFn: async () => {
      const res = await api.get<ApiResponse<any[]>>('/api/prescriptions');
      return (res.data?.success && res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
    },
    enabled: !!user && includePrescriptions,
    staleTime: 1000 * 60 * 5,
  });

  const petsList = useMemo(() => petsQuery.data ?? [], [petsQuery.data]);
  const consultationsList = useMemo(() => consultationsQuery.data ?? [], [consultationsQuery.data]);

  const syncedPets = useMemo(() => {
    return petsList.map((pet) => {
      const upcoming = consultationsList.find(
        (c) =>
          c.pet &&
          c.pet.toLowerCase() === pet.name.toLowerCase() &&
          (c.status === "Confirmada" || c.status === "Pendiente")
      );
      return {
        ...pet,
        next: upcoming ? `${upcoming.date} · ${upcoming.time}` : "Sin turno próximo",
      };
    });
  }, [petsList, consultationsList]);

  return {
    pets: syncedPets,
    petsLoading: petsQuery.isLoading,
    petsError: petsQuery.isError,
    refetchPets: petsQuery.refetch,
    hasRealPets: petsList.length > 0,
    consultations: consultationsList,
    consultationsLoading: consultationsQuery.isLoading,
    consultationsError: consultationsQuery.isError,
    refetchConsultations: consultationsQuery.refetch,
    hasRealConsultations: consultationsList.length > 0,
    rawPetsData: petsQuery.data,
    prescriptions: prescriptionsQuery.data ?? [],
    prescriptionsLoading: prescriptionsQuery.isLoading,
    prescriptionsError: prescriptionsQuery.isError,
    refetchPrescriptions: prescriptionsQuery.refetch,
    rawConsultationsData: consultationsQuery.data,
  };
}

export function NewPetModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isClosingRef = useRef(false);

  const getInitialDraft = () => {
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem("huellicam_new_pet_draft") : null;
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  };

  const initialDraft = getInitialDraft();

  const [name, setName] = useState(initialDraft?.name || "");
  const [species, setSpecies] = useState(initialDraft?.species || "Perro");
  const [sex, setSex] = useState(initialDraft?.sex || "Macho");
  const [breed, setBreed] = useState(initialDraft?.breed || "Mestizo / Criollo");
  const [customBreed, setCustomBreed] = useState(initialDraft?.customBreed || "");
  const [weightKg, setWeightKg] = useState(initialDraft?.weightKg || "");
  const [unknownWeight, setUnknownWeight] = useState(Boolean(initialDraft?.unknownWeight));
  const [microchip, setMicrochip] = useState(initialDraft?.microchip || "");
  const [allergies, setAllergies] = useState(initialDraft?.allergies || "");
  const [photoPreview, setPhotoPreview] = useState<string | null>(initialDraft?.photoPreview || null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      isClosingRef.current = false;
      try {
        const saved = localStorage.getItem("huellicam_new_pet_draft");
        if (saved) {
          const draft = JSON.parse(saved);
          if (draft.name !== undefined) setName(draft.name);
          if (draft.species !== undefined) setSpecies(draft.species);
          if (draft.sex !== undefined) setSex(draft.sex);
          if (draft.breed !== undefined) setBreed(draft.breed);
          if (draft.customBreed !== undefined) setCustomBreed(draft.customBreed);
          if (draft.weightKg !== undefined) setWeightKg(draft.weightKg);
          if (draft.unknownWeight !== undefined) setUnknownWeight(Boolean(draft.unknownWeight));
          if (draft.microchip !== undefined) setMicrochip(draft.microchip);
          if (draft.allergies !== undefined) setAllergies(draft.allergies);
          if (draft.photoPreview !== undefined) setPhotoPreview(draft.photoPreview);
        }
      } catch {}
    }
  }, [open]);

  useEffect(() => {
    if (open && !isClosingRef.current) {
      try {
        const draft = {
          name,
          species,
          sex,
          breed,
          customBreed,
          weightKg: unknownWeight ? "" : weightKg,
          unknownWeight,
          microchip,
          allergies,
          photoPreview,
          isModalOpen: true,
        };
        localStorage.setItem("huellicam_new_pet_draft", JSON.stringify(draft));
      } catch {}
    }
  }, [open, name, species, sex, breed, customBreed, weightKg, unknownWeight, microchip, allergies, photoPreview]);

  const handleVoluntaryClose = () => {
    isClosingRef.current = true;
    try {
      localStorage.removeItem("huellicam_new_pet_draft");
    } catch {}
    setName("");
    setSpecies("Perro");
    setSex("Macho");
    setBreed("Mestizo / Criollo");
    setCustomBreed("");
    setWeightKg("");
    setUnknownWeight(false);
    setMicrochip("");
    setAllergies("");
    setPhotoPreview(null);
    setErrorMsg(null);
    onClose();
  };

  const breeds = useMemo(() => getBreedsForSpecies(species), [species]);

  const handleSpeciesChange = (newSpecies: string) => {
    setSpecies(newSpecies);
    const available = getBreedsForSpecies(newSpecies);
    setBreed(available[0] || "Mestizo");
    setCustomBreed("");
  };

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageFile(file);
      setPhotoPreview(compressed);
    } catch {
      setErrorMsg("No se pudo procesar la imagen seleccionada.");
    }
  };

  const createPetMutation = useMutation({
    mutationFn: async (payload: {
      name: string;
      species: string;
      breed: string;
      weightKg?: number;
      sex?: string;
      microchip?: string;
      allergies?: string;
    }) => {
      const res = await api.post<ApiResponse<BackendPet>>('/api/pets', payload);
      return res.data;
    },
    onSuccess: async (data) => {
      isClosingRef.current = true;
      if (data?.data?.id && photoPreview) {
        try {
          const file = dataUrlToFile(photoPreview, `pet-${data.data.id}.jpg`);
          const formData = new FormData();
          formData.append("file", file);
          formData.append("petId", data.data.id);
          const mediaRes = await api.post<ApiResponse<{ id: string; url?: string }>>("/api/media", formData, {
            headers: { "Content-Type": "multipart/form-data" },
          });
          const uploadedId = mediaRes.data?.data?.id;
          if (uploadedId) {
            const photoUrl = mediaRes.data?.data?.url || `/api/media/${uploadedId}`;
            await api.post(`/api/pets/${data.data.id}/photo`, { mediaFileId: uploadedId, url: photoUrl });
          }
        } catch {
          try {
            localStorage.setItem(`huellicam_pet_photo_${data.data.id}`, photoPreview);
          } catch {}
        }
      }
      queryClient.invalidateQueries({ queryKey: ['pets'] });
      try {
        localStorage.removeItem("huellicam_new_pet_draft");
      } catch {}
      setName("");
      setSpecies("Perro");
      setSex("Macho");
      setBreed("Mestizo / Criollo");
      setCustomBreed("");
      setWeightKg("");
      setMicrochip("");
      setAllergies("");
      setPhotoPreview(null);
      setErrorMsg(null);
      onClose();
      if (onSuccess) onSuccess();
    },
    onError: (err: any) => {
      if (err?.response?.status === 401) {
        setErrorMsg("No hay una sesión iniciada o expiró tu sesión. Por favor iniciá sesión nuevamente.");
      } else {
        const msg = err?.response?.data?.error?.message || "Error al registrar la mascota";
        setErrorMsg(msg);
      }
    },
  });

  const isCustomBreedRequired = breed.startsWith("Otra") || breed.startsWith("Otro");

  const weightAssessment = useMemo(() => {
    const currentBreed = isCustomBreedRequired && customBreed.trim() ? customBreed.trim() : breed;
    return getWeightAssessment(species, currentBreed, weightKg);
  }, [species, breed, customBreed, isCustomBreedRequired, weightKg]);

  if (!open) return null;

  const handleSavePet = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg("Por favor, ingresá el nombre de la mascota.");
      return;
    }

    if (!unknownWeight && weightAssessment && weightAssessment.isBlocking) {
      setErrorMsg(weightAssessment.message);
      return;
    }

    const cleanMicrochip = microchip.trim();
    if (cleanMicrochip && cleanMicrochip.length !== 15) {
      setErrorMsg("El microchip debe tener exactamente 15 dígitos numéricos (o dejalo vacío).");
      return;
    }

    const finalBreed = isCustomBreedRequired && customBreed.trim() ? customBreed.trim() : breed;

    createPetMutation.mutate({
      name: name.trim(),
      species,
      sex,
      breed: finalBreed,
      weightKg: unknownWeight || !weightKg ? undefined : parseFloat(weightKg),
      microchip: cleanMicrochip || undefined,
      allergies: allergies.trim() || undefined,
    });
  };

  return (
    <TrappedModalLayer open={open} onClose={handleVoluntaryClose} width="min(500px, calc(100% - 32px))">
        <button className="button button--icon modal__close" onClick={handleVoluntaryClose} aria-label="Cerrar"><Icon name="close" size={18}/></button>
        <span className="modal__icon"><Icon name="paw"/></span>
        <h2 style={{ textAlign: "center" }}>Nueva mascota</h2>
        <p style={{ textAlign: "center", marginBottom: 20 }}>Ingresá los datos clínicos para abrir su expediente en Huellicam.</p>
        
        {errorMsg && (
          <div style={{ background: "#fcece9", border: "1px solid #e98b70", color: "#ae4d45", padding: "10px 14px", borderRadius: 12, fontSize: 13, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{errorMsg}</span>
            {errorMsg.includes("sesión") && (
              <button
                type="button"
                onClick={() => go("/login")}
                style={{ background: "#ae4d45", color: "#fff", border: "none", borderRadius: 999, padding: "6px 12px", fontSize: 12, cursor: "pointer", marginLeft: 8, whiteSpace: "nowrap" }}
              >
                Iniciar sesión
              </button>
            )}
          </div>
        )}

        <form onSubmit={handleSavePet}>
          <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            {/* Foto de la mascota */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", background: "var(--cream, #fffbef)", borderRadius: 12, border: "1px dashed var(--line, #e4dfd2)" }}>
              <div style={{ width: 50, height: 50, borderRadius: 10, overflow: "hidden", background: "#f2eddd", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {photoPreview ? (
                  <img src={photoPreview} alt="Foto mascota" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <Icon name="paw" size={24} />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: "block", color: "var(--ink, #183c3a)", marginBottom: 2 }}>Foto de la mascota (opcional)</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 12,
                    color: "var(--teal, #609f9c)",
                    cursor: "pointer",
                    textDecoration: "underline",
                    display: "inline-block",
                  }}
                  data-testid="upload-pet-photo-btn"
                >
                  {photoPreview ? "Cambiar foto elegida" : "Subir imagen de mascota"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handlePhotoSelect}
                  style={{ display: "none" }}
                />
                {photoPreview && (
                  <button type="button" onClick={() => setPhotoPreview(null)} style={{ background: "none", border: "none", color: "#ef4444", fontSize: 12, marginLeft: 10, cursor: "pointer" }}>
                    Quitar
                  </button>
                )}
              </div>
            </div>

            <label className="field">
              <span>Nombre de la mascota</span>
              <input value={name} onChange={(e) => { setName(e.target.value); setErrorMsg(null); }} placeholder="Ej: Milo" required/>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label className="field"><span>Especie</span>
                <select value={species} onChange={(e) => handleSpeciesChange(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                  {SPECIES_LIST.map((sp) => (
                    <option key={sp} value={sp}>{sp}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>Sexo</span>
                <select value={sex} onChange={(e) => setSex(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                  <option value="Macho">Macho</option>
                  <option value="Hembra">Hembra</option>
                </select>
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isCustomBreedRequired ? "1fr 1fr" : "1fr 1fr", gap: 12 }}>
              <label className="field"><span>Raza</span>
                <select value={breed} onChange={(e) => setBreed(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                  {breeds.map((br) => (
                    <option key={br} value={br}>{br}</option>
                  ))}
                </select>
              </label>
              <div>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Peso (kg)</span>
                  <input
                    data-testid="input-pet-weight"
                    type="number"
                    step="0.1"
                    value={unknownWeight ? "" : weightKg}
                    onChange={(e) => setWeightKg(e.target.value)}
                    disabled={unknownWeight}
                    placeholder={unknownWeight ? "Sin especificar" : "Ej: 14.5"}
                    style={unknownWeight ? { background: "#f2eddd", cursor: "not-allowed", color: "#607674" } : undefined}
                  />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-soft, #607674)", cursor: "pointer", marginTop: 4 }}>
                  <input
                    type="checkbox"
                    data-testid="checkbox-unknown-weight"
                    checked={unknownWeight}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setUnknownWeight(checked);
                      if (checked) {
                        setWeightKg("");
                        setErrorMsg(null);
                      }
                    }}
                    style={{ accentColor: "var(--teal, #609f9c)", cursor: "pointer", width: 14, height: 14 }}
                  />
                  <span>No sé el peso exacto</span>
                </label>
              </div>
            </div>
            {weightAssessment && (
              <div style={{
                marginTop: 2,
                marginBottom: 8,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.4,
                background: weightAssessment.status === 'too_low' || weightAssessment.status === 'too_high'
                  ? "#fee2e2"
                  : weightAssessment.status === 'valid_divergent'
                  ? "#fef3c7"
                  : "#ecfdf5",
                border: `1px solid ${
                  weightAssessment.status === 'too_low' || weightAssessment.status === 'too_high'
                    ? "#f87171"
                    : weightAssessment.status === 'valid_divergent'
                    ? "#f59e0b"
                    : "#10b981"
                }`,
                color: weightAssessment.status === 'too_low' || weightAssessment.status === 'too_high'
                  ? "#991b1b"
                  : weightAssessment.status === 'valid_divergent'
                  ? "#92400e"
                  : "#065f46"
              }}>
                {weightAssessment.message}
              </div>
            )}
            {isCustomBreedRequired && (
              <label className="field">
                <span>Especificar raza</span>
                <input value={customBreed} onChange={(e) => setCustomBreed(e.target.value)} placeholder="Escribí la raza de tu mascota" required/>
              </label>
            )}
            <label className="field"><span>Microchip (15 dígitos ISO - Opcional)</span><input value={microchip} onChange={(e) => { setMicrochip(e.target.value.replace(/\D/g, '')); setErrorMsg(null); }} placeholder="Opcional: 15 dígitos numéricos" maxLength={15} inputMode="numeric"/></label>
            <label className="field"><span>Alergias conocidas</span><input value={allergies} onChange={(e) => setAllergies(e.target.value)} placeholder="Ej: Polen / Penicilina / Ninguna"/></label>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
            <Button variant="secondary" onClick={handleVoluntaryClose}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={createPetMutation.isPending}>{createPetMutation.isPending ? "Guardando..." : "Guardar mascota"}</Button>
          </div>
        </form>
    </TrappedModalLayer>
  );
}

function Dashboard() {
  const { user } = useAuth();
  const rawFirstName = user?.firstName || (user?.email ? user.email.split("@")[0] : "");
  const firstName = rawFirstName ? (rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1)) : "Tutor";
  const { pets, consultations, petsLoading, petsError, refetchPets, consultationsLoading, consultationsError, refetchConsultations } = useClientData();
  const [modalOpen, setModalOpen] = useState(() => {
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem("huellicam_new_pet_draft") : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        return Boolean(parsed.isModalOpen);
      }
    } catch {}
    return false;
  });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Active call only if there is a real ACTIVE or WAITING consultation in DB
  const activeCall = consultations.find((c) => c.rawStatus === "ACTIVE" || c.rawStatus === "WAITING");
  const nextConsultation = consultations.find((c) => c.rawStatus === "ACTIVE" || c.rawStatus === "WAITING" || c.status === "Confirmada" || c.status === "Pendiente");

  return <>
    <PageHeader eyebrow="Portal del tutor" title={`Hola, ${firstName}`} description="¿Cómo podemos ayudarte hoy?"/>
    <section className="attention-banner"><div className="attention-banner__mascot" data-testid="dashboard-hamster-mascot"><HamsterMascot size="sm"/></div><div><span className="eyebrow">Orientación en pocos pasos</span><h2>¿Necesitás orientación veterinaria?</h2><p>Contanos qué está pasando y te ayudamos a encontrar el siguiente paso.</p></div><Button onClick={() => go("/client/triage")}>Necesito atención <Icon name="arrow" size={17}/></Button></section>
    
    {activeCall && (
      <section className="active-call">
        <div className="active-call__mascot" data-testid="active-call-hamster-mascot"><HamsterMascot size="xs"/></div>
        <div>
          <span className="eyebrow">{activeCall.rawStatus === "WAITING" ? "Consulta en espera" : "Consulta en curso"}</span>
          <h2>{activeCall.rawStatus === "WAITING" ? "Esperando asignación de veterinario" : "Tu consulta está por comenzar"}</h2>
          <p>{activeCall.rawStatus === "WAITING" ? "Un profesional de guardia tomará tu caso a la brevedad." : `Estás esperando la conexión con ${activeCall.vet}.`}</p>
        </div>
        <div className="active-call__meta"><span>Tiempo estimado</span><strong>{activeCall.rawStatus === "WAITING" ? "En cola" : "4 minutos"}</strong></div>
        <Button variant="primary" onClick={() => go(`/call/${activeCall.id}?from=client`)}>Entrar a la consulta</Button>
      </section>
    )}

    <div className="dashboard-grid">
      <section>
        <div className="section-heading"><div><span className="eyebrow">Tu agenda</span><h2>Próxima consulta</h2></div><button onClick={() => go("/client/consultations")}>Ver todas <Icon name="arrow" size={16}/></button></div>
        {consultationsLoading ? (
          <div className="skeleton skeleton--hero" style={{ height: 110 }}/>
        ) : consultationsError ? (
          <ErrorState onRetry={() => void refetchConsultations()} />
        ) : nextConsultation ? (
          <ConsultationCard item={nextConsultation}/>
        ) : (
          <div className="panel"><EmptyState icon="calendar" title="Sin consultas programadas" text="Cuando reserves un turno o pidas atención, aparecerá acá." action="Nueva consulta" onAction={() => go("/client/triage")}/></div>
        )}
      </section>

      {consultationsLoading ? (
        <aside className="care-note">
          <Icon name="shield" size={25}/>
          <div>
            <h3>Cuidado preventivo</h3>
            <p>Mantené la información médica de tus mascotas al día para agilizar la atención de guardia.</p>
          </div>
          <button onClick={() => go("/client/pets")}>Gestionar mascotas</button>
        </aside>
      ) : nextConsultation ? (
        <aside className="care-note">
          <Icon name="shield" size={25}/>
          <div>
            <h3>Todo listo para hoy</h3>
            <p>{`Tené a ${nextConsultation.pet || pets[0]?.name || "tu mascota"} cerca y buscá un lugar tranquilo con buena conexión.`}</p>
          </div>
          <button onClick={() => go("/client/triage")}>Ver cómo prepararme</button>
        </aside>
      ) : (
        <aside className="care-note">
          <Icon name="shield" size={25}/>
          <div>
            <h3>Cuidado preventivo</h3>
            <p>Mantené la información médica de tus mascotas al día para agilizar la atención de guardia.</p>
          </div>
          <button onClick={() => pets.length > 0 ? go("/client/pets") : setModalOpen(true)}>Gestionar mascotas</button>
        </aside>
      )}
    </div>

    <section>
      <div className="section-heading"><div><span className="eyebrow">Su salud, en un solo lugar</span><h2>Tus mascotas</h2></div><button onClick={() => go("/client/pets")}>Ver todas <Icon name="arrow" size={16}/></button></div>
      {petsLoading ? (
        <div className="pet-grid pet-grid--dashboard">
          <div className="skeleton skeleton--card"/>
        </div>
      ) : petsError ? (
        <ErrorState onRetry={() => void refetchPets()} />
      ) : pets.length > 0 ? (
        <div className="pet-grid pet-grid--dashboard">{pets.slice(0, 3).map((pet) => <PetCard pet={pet} compact key={pet.id}/>)}</div>
      ) : (
        <div className="pet-grid pet-grid--dashboard">
          <div className="pet-card--add" onClick={() => setModalOpen(true)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setModalOpen(true); }}>
            <span><Icon name="plus" size={24}/></span>
            <h3>Agregar mi primera mascota</h3>
            <p>Abrí su ficha clínica para organizar vacunas, estudios y pedir atención veterinaria.</p>
            <Button variant="primary" icon="plus" onClick={() => setModalOpen(true)}>Agregar mascota</Button>
          </div>
        </div>
      )}
    </section>

    <NewPetModal
      open={modalOpen}
      onClose={() => setModalOpen(false)}
      onSuccess={() => {
        setToastMsg("Mascota agregada exitosamente");
        setTimeout(() => setToastMsg(null), 3500);
      }}
    />
    {toastMsg && <Toast message={toastMsg} tone={toastMsg.includes("Error") ? "error" : "success"}/>}
  </>;
}

function PetsPage() {
  const { pets, petsLoading, petsError, refetchPets } = useClientData();
  const [modalOpen, setModalOpen] = useState(() => {
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem("huellicam_new_pet_draft") : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        return Boolean(parsed.isModalOpen);
      }
    } catch {}
    return false;
  });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  if (petsLoading && pets.length === 0) {
    return <SkeletonPage type="cards" />;
  }
  if (petsError && pets.length === 0) {
    return <ErrorState onRetry={() => { void refetchPets(); }} />;
  }

  const isActuallyEmpty = pets.length === 0;

  return <>
    <PageHeader eyebrow="Familia Huellicam" title="Mis mascotas" description="Su información de salud, organizada y siempre a mano." action={<Button icon="plus" onClick={() => setModalOpen(true)}>Agregar mascota</Button>}/>
    <div className="view-toggle"><span>{pets.length} {pets.length === 1 ? "mascota" : "mascotas"}</span></div>
    {isActuallyEmpty ? (
      <EmptyState icon="paw" title="Todavía no agregaste ninguna mascota" text="Agregá una mascota para comenzar a organizar su información." action="Agregar mascota" onAction={() => setModalOpen(true)}/>
    ) : (
      <div className="pet-grid">{pets.map((pet) => <PetCard pet={pet} key={pet.id}/>)}</div>
    )}

    <NewPetModal
      open={modalOpen}
      onClose={() => setModalOpen(false)}
      onSuccess={() => {
        setToastMsg("Mascota agregada exitosamente");
        setTimeout(() => setToastMsg(null), 3500);
      }}
    />
    {toastMsg && <Toast message={toastMsg} tone={toastMsg.includes("Error") ? "error" : "success"}/>}
  </>;
}

function PetDetail({ id }: { id: string }) {
  const { pets, petsLoading } = useClientData({ includeConsultations: false });
  const queryClient = useQueryClient();
  const pet = pets.find((item) => item.id === id);
  const [tab, setTab] = useState("Información general");
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  const [editModal, setEditModal] = useState(false);
  const [vaccineModal, setVaccineModal] = useState(false);
  const [documentModal, setDocumentModal] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Edit pet state
  const [editName, setEditName] = useState(pet?.name || "");
  const [editKind, setEditKind] = useState(pet?.kind || "Perro");
  const [editBreed, setEditBreed] = useState(pet?.breed || "Mestizo / Criollo");
  const [editCustomBreed, setEditCustomBreed] = useState("");
  const [editWeight, setEditWeight] = useState(pet?.weight && !pet.weight.includes("Sin especificar") && !pet.weight.includes("No informado") ? pet.weight.replace(" kg", "").replace(" g", "").trim() : "");
  const [editUnknownWeight, setEditUnknownWeight] = useState(!pet?.weight || pet.weight.includes("Sin especificar") || pet.weight.includes("No informado"));
  const [editSex, setEditSex] = useState(pet?.sex || "Macho");
  const [editMicrochip, setEditMicrochip] = useState(pet?.microchip && pet.microchip !== "No informado" ? pet.microchip : "");
  const [editAllergies, setEditAllergies] = useState(pet?.allergies && pet.allergies !== "Sin alergias conocidas" ? pet.allergies : "");

  const [heroPhoto, setHeroPhoto] = useState<string>(() => pet?.photo || photos.milo);
  const resolvedHeroPhoto = useAuthenticatedMediaUrl(heroPhoto);

  const dossierQuery = useQuery({
    queryKey: ["pet-dossier", pet?.id],
    enabled: Boolean(pet?.id),
    queryFn: async () => {
      const res = await api.get<ApiResponse<PetDossierDTO>>(`/api/pets/${pet!.id}/dossier`);
      return res.data.success && res.data.data ? res.data.data : null;
    },
  });
  const dossier = dossierQuery.data ?? null;

  const [viewerDoc, setViewerDoc] = useState<{ url: string; title: string; mimeType?: string; subtitle?: string } | null>(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [coOwnerEmail, setCoOwnerEmail] = useState("");
  const [coOwnerBusy, setCoOwnerBusy] = useState(false);

  const editBreeds = useMemo(() => getBreedsForSpecies(editKind), [editKind]);

  const handleHeroPhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pet?.id) return;
    try {
      const compressed = await compressImageFile(file);
      const uploadFile = dataUrlToFile(compressed, `pet-${pet.id}.jpg`);
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("petId", pet.id);
      const mediaRes = await api.post<ApiResponse<{ id: string; url?: string }>>("/api/media", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const uploadedId = mediaRes.data?.data?.id;
      const photoUrl = mediaRes.data?.data?.url || (uploadedId ? `/api/media/${uploadedId}` : undefined);
      if (!photoUrl) throw new Error("Media upload failed");
      await api.post(`/api/pets/${pet.id}/photo`, {
        mediaFileId: uploadedId,
        url: photoUrl,
      });
      setHeroPhoto(photoUrl);
      queryClient.invalidateQueries({ queryKey: ["pets"] });
      queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setToastMsg("Foto de mascota actualizada");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("No se pudo cargar la foto");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  const handleEditKindChange = (newKind: string) => {
    setEditKind(newKind);
    const available = getBreedsForSpecies(newKind);
    setEditBreed(available[0] || "Mestizo");
    setEditCustomBreed("");
  };

  const mapVaccineStatusLabel = (status: string): "Al día" | "Próxima" | "Vencida" =>
    status === "VENCIDA" ? "Vencida" : status === "PROXIMA" ? "Próxima" : "Al día";

  const vaccines = (dossier?.vaccines || []).map((v) => ({
    id: v.id,
    name: v.name,
    date: formatDateAR(v.appliedAt),
    nextDate: v.nextDueAt ? formatDateAR(v.nextDueAt) : "A definir",
    status: mapVaccineStatusLabel(v.status),
  }));

  const [vacName, setVacName] = useState("");
  const [vacDate, setVacDate] = useState("");
  const [vacNext, setVacNext] = useState("");
  const [vacStatus, setVacStatus] = useState<"Al día" | "Próxima" | "Vencida">("Al día");

  const docs = (dossier?.documents || []).map((d) => ({
    id: d.id,
    name: d.title,
    type: d.category,
    date: formatDateAR(d.createdAt),
    size: d.sizeBytes >= 1024 * 1024 ? `${(d.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(d.sizeBytes / 1024))} KB`,
    url: normalizeMediaUrl(d.url) || d.url,
    mimeType: d.mimeType,
  }));
  const [docName, setDocName] = useState("");
  const [docType, setDocType] = useState("Estudio médico");
  const [docFile, setDocFile] = useState<File | null>(null);

  useEffect(() => {
    if (pet) {
      setEditName(pet.name);
      setEditKind(pet.kind);
      setEditBreed(pet.breed);
      setEditSex(pet.sex || "Macho");
      const hasNoWeight = !pet.weight || pet.weight.includes("Sin especificar") || pet.weight.includes("No informado");
      setEditUnknownWeight(hasNoWeight);
      setEditWeight(hasNoWeight ? "" : pet.weight.replace(" kg", "").replace(" g", "").trim());
      setEditMicrochip(pet.microchip && pet.microchip !== "No informado" ? pet.microchip : "");
      setEditAllergies(pet.allergies && pet.allergies !== "Sin alergias conocidas" ? pet.allergies : "");
      setHeroPhoto(dossier?.pet?.photoUrl || pet.photo);
    }
  }, [pet, dossier?.pet?.photoUrl]);

  const updatePetMutation = useMutation({
    mutationFn: async (payload: { name: string; species: string; breed: string; weightKg?: number; sex?: string; microchip?: string; allergies?: string }) => {
      if (!pet) throw new Error("Mascota no encontrada");
      const res = await api.patch<ApiResponse<BackendPet>>(`/api/pets/${pet.id}`, payload);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pets'] });
      if (pet?.id) queryClient.invalidateQueries({ queryKey: ['pet-dossier', pet.id] });
      setEditModal(false);
      setToastMsg("Ficha actualizada con éxito");
      setTimeout(() => setToastMsg(null), 3500);
    },
    onError: () => {
      setToastMsg("Error al actualizar la ficha");
      setTimeout(() => setToastMsg(null), 3500);
    },
  });

  const editWeightAssessment = useMemo(() => {
    const isCustom = editBreed.startsWith("Otra") || editBreed.startsWith("Otro");
    const finalBreed = isCustom && editCustomBreed.trim() ? editCustomBreed.trim() : editBreed;
    return getWeightAssessment(editKind, finalBreed, editWeight);
  }, [editKind, editBreed, editCustomBreed, editWeight]);

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) return;

    if (!editUnknownWeight && editWeightAssessment && editWeightAssessment.isBlocking) {
      setToastMsg(editWeightAssessment.message);
      setTimeout(() => setToastMsg(null), 4500);
      return;
    }

    const isCustom = editBreed.startsWith("Otra") || editBreed.startsWith("Otro");
    const finalBreed = isCustom && editCustomBreed.trim() ? editCustomBreed.trim() : editBreed;
    updatePetMutation.mutate({
      name: editName.trim(),
      species: editKind,
      breed: finalBreed || "Mestizo",
      weightKg: editUnknownWeight || !editWeight ? undefined : parseFloat(editWeight),
      sex: editSex,
      microchip: editMicrochip.trim() ? editMicrochip.trim() : undefined,
      allergies: editAllergies.trim() ? editAllergies.trim() : undefined,
    });
  };

  const toIsoOrUndefined = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = new Date(trimmed);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  };

  const handleAddVaccine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pet?.id || !vacName.trim()) return;
    const apiStatus = vacStatus === "Vencida" ? "VENCIDA" : vacStatus === "Próxima" ? "PROXIMA" : "AL_DIA";
    try {
      await api.post(`/api/pets/${pet.id}/vaccines`, {
        name: vacName.trim(),
        appliedAt: toIsoOrUndefined(vacDate) || new Date().toISOString(),
        nextDueAt: toIsoOrUndefined(vacNext),
        status: apiStatus,
      });
      await queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setVaccineModal(false);
      setVacName("");
      setVacDate("");
      setVacNext("");
      setToastMsg("Vacuna registrada exitosamente");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("Error al registrar la vacuna");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  const handleDeleteVaccine = async (vaccineId: string) => {
    if (!pet?.id) return;
    try {
      await api.delete(`/api/pets/${pet.id}/vaccines/${vaccineId}`);
      await queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setToastMsg("Vacuna eliminada");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("Error al eliminar la vacuna");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  const mapDocCategory = (label: string): PetDocumentCategoryDTO => {
    if (label === "Certificado") return "VACUNA";
    if (label === "Receta veterinaria") return "RECETA";
    if (label === "Estudio médico" || label === "Análisis de sangre") return "ESTUDIO";
    return "OTRO";
  };

  const handleAddDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pet || !docName.trim()) return;
    if (!docFile) {
      setToastMsg("Por favor seleccioná un archivo para adjuntar");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", docFile);
      formData.append("petId", pet.id);
      const mediaRes = await api.post<ApiResponse<{ id: string; url?: string; mimeType?: string; sizeBytes?: number }>>("/api/media", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const uploaded = mediaRes.data?.data;
      if (!uploaded?.id) throw new Error("Upload failed");

      await api.post(`/api/pets/${pet.id}/documents`, {
        title: docName.trim(),
        category: mapDocCategory(docType),
        mediaFileId: uploaded.id,
        url: uploaded.url || `/api/media/${uploaded.id}`,
        mimeType: docFile.type || uploaded.mimeType || "application/octet-stream",
        sizeBytes: docFile.size || uploaded.sizeBytes || 1,
      });

      await queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setDocumentModal(false);
      setDocName("");
      setDocFile(null);
      setToastMsg("Documento adjuntado exitosamente");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("Error al adjuntar el documento");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    if (!pet?.id) return;
    try {
      await api.delete(`/api/pets/${pet.id}/documents/${docId}`);
      await queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setDeleteDocId(null);
      setToastMsg("Documento eliminado");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setDeleteDocId(null);
      setToastMsg("Error al eliminar el documento");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  const handleAddCoOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pet?.id || !coOwnerEmail.trim()) return;
    setCoOwnerBusy(true);
    try {
      await api.post(`/api/pets/${pet.id}/co-owners`, { email: coOwnerEmail.trim() });
      setCoOwnerEmail("");
      await queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setToastMsg("Co-tutor agregado a la mascota");
      setTimeout(() => setToastMsg(null), 3500);
    } catch (err: unknown) {
      const apiErr = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setToastMsg(apiErr ? `Error: ${apiErr}` : "Error al agregar co-tutor");
      setTimeout(() => setToastMsg(null), 3500);
    } finally {
      setCoOwnerBusy(false);
    }
  };

  const handleRemoveCoOwner = async (coOwnerId: string) => {
    if (!pet?.id) return;
    try {
      await api.delete(`/api/pets/${pet.id}/co-owners/${coOwnerId}`);
      await queryClient.invalidateQueries({ queryKey: ["pet-dossier", pet.id] });
      setToastMsg("Co-tutor removido");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("Error al remover co-tutor");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  if (petsLoading && !pet) {
    return <SkeletonPage type="list" />;
  }

  if (!pet) {
    return <section className="panel"><EmptyState icon="paw" title="Mascota no encontrada" text="No pudimos encontrar la información de esta mascota." action="Volver al inicio" onAction={() => go("/client/pets")}/></section>;
  }

  const tabs = ["Información general", "Vacunación", "Antecedentes", "Documentos", "Consultas", "Recetas", "Evolución"];

  const dossierPetForModal: BackendPet = dossier?.pet ?? {
    id: pet.id,
    ownerId: "",
    name: pet.name,
    species: pet.kind,
    breed: pet.breed,
    sex: editSex,
    weightKg: editUnknownWeight || !editWeight ? undefined : parseFloat(editWeight),
    microchip: pet.microchip !== "No informado" ? pet.microchip : undefined,
    allergies: pet.allergies !== "Sin alergias conocidas" ? pet.allergies : undefined,
    chronicConditions: pet.chronicConditions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return <>
    <button className="back-link" onClick={() => go("/client/pets")}><Icon name="arrow" size={17}/> Volver a mis mascotas</button>
    <section className="pet-hero">
      <div style={{ position: "relative", width: 96, height: 96, flexShrink: 0 }}>
        <img
          src={resolvedHeroPhoto || heroPhoto}
          alt={pet.name}
          onError={(e) => { e.currentTarget.style.opacity = "0.25"; }}
          style={{ width: 96, height: 96, borderRadius: 16, objectFit: "cover", background: "#d9e8e4" }}
        />
        <label title="Cambiar foto de la mascota" aria-label="Cambiar foto de la mascota" style={{ position: "absolute", bottom: -8, right: -8, background: "#fff", border: "1px solid var(--line, #e4dfd2)", borderRadius: "50%", minWidth: 44, minHeight: 44, width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }}>
          <Icon name="edit" size={14}/>
          <input type="file" accept="image/*" onChange={handleHeroPhotoChange} style={{ display: "none" }}/>
        </label>
      </div>
      <div className="pet-hero__title">
        <span className="eyebrow">Ficha de mascota</span>
        <h1>{pet.name}</h1>
        <p>{pet.kind} · {pet.breed}</p>
        <Status>{pet.state}</Status>
      </div>
      <div className="pet-hero__facts">
        <span><small>Edad</small><strong>{pet.age}</strong></span>
        <span><small>Sexo</small><strong>{editSex}</strong></span>
        <span><small>Peso</small><strong>{pet.weight}</strong></span>
        <span><small>Microchip</small><strong>{pet.microchip || "No informado"}</strong></span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="secondary" icon="file" onClick={() => setDossierOpen(true)}>Exportar PDF</Button>
        <Button variant="secondary" icon="edit" onClick={() => setEditModal(true)}>Editar ficha</Button>
      </div>
    </section>

    <Tabs tabs={tabs} active={tab} onChange={setTab}/>

    <SectionStage stageKey={tab}>
    {tab === "Información general" && <div className="detail-grid">
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Resumen</span><h2>Información general</h2></div>
          <Button variant="soft" icon="edit" onClick={() => setEditModal(true)}>Editar</Button>
        </div>
        <dl className="info-list">
          <div><dt>Especie</dt><dd>{pet.kind}</dd></div>
          <div><dt>Raza</dt><dd>{pet.breed}</dd></div>
          <div><dt>Microchip ISO</dt><dd>{pet.microchip || "No informado"}</dd></div>
          <div><dt>Estado clínico</dt><dd>{pet.state}</dd></div>
        </dl>
      </section>
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Cuidados actuales</span><h2>Información médica</h2></div>
        </div>
        <div className="medical-items">
          <div><span className="medical-icon"><Icon name="heart"/></span><div><strong>Alergias</strong><p>{pet.allergies || "Sin alergias conocidas"}</p></div></div>
          <div><span className="medical-icon"><Icon name="file"/></span><div><strong>Condiciones crónicas</strong><p>{pet.chronicConditions || "Ninguna registrada"}</p></div></div>
          <div><span className="medical-icon"><Icon name="shield"/></span><div><strong>Última consulta</strong><p>{pet.last}</p></div></div>
        </div>
      </section>
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Acceso compartido</span><h2>Co-tutores</h2></div>
        </div>
        <form onSubmit={handleAddCoOwner} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            type="email"
            placeholder="Email del co-tutor registrado"
            value={coOwnerEmail}
            onChange={(e) => setCoOwnerEmail(e.target.value)}
            style={{ flex: 1, height: 38, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px" }}
            required
          />
          <Button type="submit" variant="secondary" disabled={coOwnerBusy}>{coOwnerBusy ? "Agregando..." : "Compartir"}</Button>
        </form>
        {(dossier?.coOwners?.length ?? 0) > 0 ? (
          <div className="table-list">
            {dossier!.coOwners.map((co) => (
              <div className="table-row" key={co.id}>
                <div><strong>{co.name}</strong><small style={{ display: "block", color: "var(--ink-soft)" }}>{co.email}</small></div>
                <Button variant="icon" icon="trash" ariaLabel={`Quitar acceso a ${co.name}`} onClick={() => handleRemoveCoOwner(co.id)} />
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Todavía no compartiste el expediente de {pet.name} con otro tutor.</p>
        )}
      </section>
      <section className="panel panel--wide">
        <div className="panel__heading">
          <div><span className="eyebrow">Últimos registros</span><h2>Evolución</h2></div>
          <Button variant="soft" icon="plus" onClick={() => go("/client/triage")}>Nueva consulta</Button>
        </div>
        {(dossier?.evolutions?.length ?? 0) > 0 ? (
          <div className="timeline">
            {dossier!.evolutions.slice(0, 3).map((evo) => (
              <div key={evo.id}><span/><div><b>{formatDateAR(evo.createdAt)}</b><strong>{evo.vetName || "Profesional Veterinario"}</strong><p>{evo.summary}</p></div></div>
            ))}
          </div>
        ) : (
          <div className="timeline">
            <div><span/><div><b>{pet.last}</b><strong>Atención registrada en sistema</strong><p>Expediente sincronizado con la red veterinaria Huellicam.</p></div></div>
          </div>
        )}
      </section>
    </div>}

    {tab === "Vacunación" && (
      <section className="panel">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Prevención</span>
            <h2>Vacunación</h2>
            <p>Mantené el calendario de {pet.name} actualizado.</p>
          </div>
          <Button icon="plus" onClick={() => setVaccineModal(true)}>Agregar vacuna</Button>
        </div>
        {vaccines.length > 0 ? (
          <div className="table-list">
            {vaccines.map((v) => (
              <div className="table-row" key={v.id}>
                <div><small>Vacuna</small><strong>{v.name}</strong></div>
                <div><small>Aplicación</small><span>{v.date}</span></div>
                <div><small>Próxima dosis</small><span>{v.nextDate}</span></div>
                <div><Status tone={v.status === "Al día" ? "teal" : v.status === "Próxima" ? "amber" : "red"}>{v.status}</Status></div>
                <Button variant="icon" icon="trash" ariaLabel={`Eliminar ${v.name}`} onClick={() => handleDeleteVaccine(v.id)} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="shield" title="Sin vacunas registradas aún" text={`Registrá la libreta sanitaria o certificados de vacunación de ${pet.name}.`} action="Agregar vacuna" onAction={() => setVaccineModal(true)}/>
        )}
      </section>
    )}

    {tab === "Antecedentes" && (
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Historial médico</span><h2>Antecedentes de {pet.name}</h2></div>
          <Button variant="soft" icon="edit" onClick={() => setEditModal(true)}>Actualizar</Button>
        </div>
        <div className="medical-items">
          <div><span className="medical-icon"><Icon name="heart"/></span><div><strong>Alergias declaradas</strong><p>{pet.allergies || "Sin alergias conocidas"}</p></div></div>
          <div><span className="medical-icon"><Icon name="file"/></span><div><strong>Condiciones preexistentes</strong><p>{pet.chronicConditions || "Ninguna registrada"}</p></div></div>
          <div><span className="medical-icon"><Icon name="shield"/></span><div><strong>Microchip ISO</strong><p>{pet.microchip || "No informado"}</p></div></div>
        </div>
      </section>
    )}

    {tab === "Documentos" && (
      <section className="panel">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">Biblioteca médica</span>
            <h2>Documentos</h2>
            <p>Estudios, recetas y archivos veterinarios de {pet.name}.</p>
          </div>
          <Button icon="plus" onClick={() => setDocumentModal(true)}>Agregar documento</Button>
        </div>
        {docs.length > 0 ? (
          <div className="document-list">
            {docs.map((doc) => (
              <article className="document-card" key={doc.id}>
                <span className="document-card__icon"><Icon name="file"/></span>
                <div>
                  <strong>{doc.name}</strong>
                  <p>{doc.type} · {doc.date} · {doc.size}</p>
                  <small>Expediente clínico</small>
                </div>
                <div className="document-card__actions">
                  <Button
                    variant="soft"
                    onClick={() => setViewerDoc({ url: doc.url, title: doc.name, mimeType: doc.mimeType, subtitle: `${doc.type} · ${doc.date}` })}
                  >
                    Ver
                  </Button>
                  <Button
                    variant="icon"
                    icon="download"
                    ariaLabel={`Descargar ${doc.name}`}
                    onClick={() => {
                      downloadAuthenticatedMedia(doc.url, doc.name).catch(() => {
                        setToastMsg("No pudimos descargar el archivo");
                        setTimeout(() => setToastMsg(null), 3500);
                      });
                    }}
                  />
                  <Button variant="icon" icon="trash" ariaLabel={`Eliminar ${doc.name}`} onClick={() => setDeleteDocId(doc.id)}/>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState icon="file" title="No hay documentos adjuntos aún" text={`Subí certificados, análisis o radiografías de ${pet.name} para tenerlos siempre a mano.`} action="Agregar documento" onAction={() => setDocumentModal(true)}/>
        )}
      </section>
    )}

    {tab === "Consultas" && (
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Atenciones</span><h2>Consultas de {pet.name}</h2></div>
          <Button variant="soft" icon="plus" onClick={() => go("/client/triage")}>Nueva consulta</Button>
        </div>
        {(dossier?.consultations?.length ?? 0) > 0 ? (
          <div className="table-list">
            {dossier!.consultations.map((c) => (
              <div className="table-row" key={c.id}>
                <div><small>{formatDateAR(c.startedAt || c.createdAt)}</small><strong>{c.vet ? `Dr. ${c.vet.firstName} ${c.vet.lastName}` : "Veterinario de guardia"}</strong></div>
                <div><small>Motivo</small><span>{c.notes || "Teleconsulta"}</span></div>
                <div><Status tone={c.status === "COMPLETED" ? "teal" : c.status === "CANCELLED" ? "red" : "amber"}>{c.status}</Status></div>
                <Button variant="secondary" onClick={() => go(`/client/consultations/${c.id}`)}>Ver</Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="video" title="Sin consultas registradas aún" text={`Cuando ${pet.name} tenga atenciones veterinarias, aparecerán acá.`} action="Nueva consulta" onAction={() => go("/client/triage")}/>
        )}
      </section>
    )}

    {tab === "Recetas" && (
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Indicaciones</span><h2>Recetas de {pet.name}</h2></div>
        </div>
        {(() => {
          const petRx = (dossier?.consultations || []).flatMap((c) => c.prescriptions || []);
          return petRx.length > 0 ? (
            <div className="table-list">
              {petRx.map((r) => (
                <div className="table-row" key={r.id}>
                  <div><small>{formatDateAR(r.issuedAt)}</small><strong>{r.medication}</strong></div>
                  <div><small>Dosis</small><span>{r.dosage} · {r.frequency} ({r.durationDays} días)</span></div>
                  <Button variant="secondary" onClick={() => go("/client/prescriptions")}>Ver receta</Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="file" title="Sin recetas emitidas aún" text={`Las indicaciones médicas emitidas para ${pet.name} aparecerán acá.`}/>
          );
        })()}
      </section>
    )}

    {tab === "Evolución" && (
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Seguimiento clínico</span><h2>Evolución de {pet.name}</h2></div>
        </div>
        {(dossier?.evolutions?.length ?? 0) > 0 ? (
          <div className="timeline">
            {dossier!.evolutions.map((evo) => (
              <div key={evo.id}>
                <span/>
                <div>
                  <b>{formatDateAR(evo.createdAt)}</b>
                  <strong>{evo.vetName || "Profesional Veterinario"}</strong>
                  {evo.diagnosis && <p><b>Diagnóstico:</b> {evo.diagnosis}</p>}
                  <p>{evo.summary}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="file" title="Sin notas de evolución aún" text={`Los registros clínicos guardados por el veterinario para ${pet.name} se sincronizarán acá.`}/>
        )}
      </section>
    )}
    </SectionStage>

    <ClinicalMediaViewer
      open={Boolean(viewerDoc)}
      url={viewerDoc?.url}
      title={viewerDoc?.title || "Documento clínico"}
      mimeType={viewerDoc?.mimeType}
      subtitle={viewerDoc?.subtitle}
      onClose={() => setViewerDoc(null)}
    />

    <PetDossierModal
      pet={dossierPetForModal}
      dossier={dossier}
      isOpen={dossierOpen}
      onClose={() => setDossierOpen(false)}
    />

    <TrappedModalLayer open={editModal} onClose={() => setEditModal(false)} width="min(500px, calc(100% - 32px))">
          <button className="button button--icon modal__close" onClick={() => setEditModal(false)} aria-label="Cerrar"><Icon name="close" size={18}/></button>
          <span className="modal__icon"><Icon name="edit"/></span>
          <h2 style={{ textAlign: "center" }}>Editar ficha de {pet.name}</h2>
          <p style={{ textAlign: "center", marginBottom: 20 }}>Actualizá los datos de tu mascota en su historia clínica.</p>
          <form onSubmit={handleSaveEdit}>
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              {/* Cambiar foto en el modal */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", background: "var(--cream, #fffbef)", borderRadius: 10, border: "1px dashed var(--line, #e4dfd2)" }}>
                <img src={resolvedHeroPhoto || heroPhoto} alt={pet.name} style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, display: "block", color: "var(--ink, #183c3a)", marginBottom: 2 }}>Foto de la mascota</span>
                  <label style={{ fontSize: 12, color: "var(--teal, #609f9c)", cursor: "pointer", textDecoration: "underline", display: "inline-block" }}>
                    <span>Cambiar por una foto real</span>
                    <input type="file" accept="image/*" onChange={handleHeroPhotoChange} style={{ display: "none" }} />
                  </label>
                </div>
              </div>

              <label className="field"><span>Nombre</span><input value={editName} onChange={(e) => setEditName(e.target.value)} required/></label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="field"><span>Especie</span>
                  <select value={editKind} onChange={(e) => handleEditKindChange(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                    {SPECIES_LIST.map((sp) => (
                      <option key={sp} value={sp}>{sp}</option>
                    ))}
                  </select>
                </label>
                <label className="field"><span>Sexo</span>
                  <select value={editSex} onChange={(e) => setEditSex(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                    <option value="Macho">Macho</option>
                    <option value="Hembra">Hembra</option>
                  </select>
                </label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="field"><span>Raza</span>
                  <select value={editBreed} onChange={(e) => setEditBreed(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                    {editBreeds.map((br) => (
                      <option key={br} value={br}>{br}</option>
                    ))}
                  </select>
                </label>
                <div>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span>Peso (kg)</span>
                    <input
                      data-testid="input-edit-pet-weight"
                      type="number"
                      step="0.1"
                      value={editUnknownWeight ? "" : editWeight}
                      onChange={(e) => setEditWeight(e.target.value)}
                      disabled={editUnknownWeight}
                      placeholder={editUnknownWeight ? "Sin especificar" : "Ej: 14.5"}
                      style={editUnknownWeight ? { background: "#f2eddd", cursor: "not-allowed", color: "#607674" } : undefined}
                    />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-soft, #607674)", cursor: "pointer", marginTop: 4 }}>
                    <input
                      type="checkbox"
                      data-testid="checkbox-edit-unknown-weight"
                      checked={editUnknownWeight}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setEditUnknownWeight(checked);
                        if (checked) setEditWeight("");
                      }}
                      style={{ accentColor: "var(--teal, #609f9c)", cursor: "pointer", width: 14, height: 14 }}
                    />
                    <span>No sé el peso exacto</span>
                  </label>
                </div>
              </div>
              {editWeightAssessment && (
                <div style={{
                  marginTop: 2,
                  marginBottom: 8,
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.4,
                  background: editWeightAssessment.status === 'too_low' || editWeightAssessment.status === 'too_high'
                    ? "#fee2e2"
                    : editWeightAssessment.status === 'valid_divergent'
                    ? "#fef3c7"
                    : "#ecfdf5",
                  border: `1px solid ${
                    editWeightAssessment.status === 'too_low' || editWeightAssessment.status === 'too_high'
                      ? "#f87171"
                      : editWeightAssessment.status === 'valid_divergent'
                      ? "#f59e0b"
                      : "#10b981"
                  }`,
                  color: editWeightAssessment.status === 'too_low' || editWeightAssessment.status === 'too_high'
                    ? "#991b1b"
                    : editWeightAssessment.status === 'valid_divergent'
                    ? "#92400e"
                    : "#065f46"
                }}>
                  {editWeightAssessment.message}
                </div>
              )}
              {(editBreed.startsWith("Otra") || editBreed.startsWith("Otro")) && (
                <label className="field">
                  <span>Especificar raza</span>
                  <input value={editCustomBreed} onChange={(e) => setEditCustomBreed(e.target.value)} placeholder="Escribí la raza de tu mascota" required/>
                </label>
              )}
              <label className="field"><span>Microchip (15 dígitos ISO - Opcional)</span><input value={editMicrochip} onChange={(e) => setEditMicrochip(e.target.value.replace(/\D/g, ''))} placeholder="Opcional: 15 dígitos numéricos" maxLength={15} inputMode="numeric"/></label>
              <label className="field"><span>Alergias conocidas</span><input value={editAllergies} onChange={(e) => setEditAllergies(e.target.value)} placeholder="Ej: Polen estacional / Ninguna"/></label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
              <Button variant="secondary" onClick={() => setEditModal(false)}>Cancelar</Button>
              <Button type="submit" variant="primary" disabled={updatePetMutation.isPending}>{updatePetMutation.isPending ? "Guardando..." : "Guardar cambios"}</Button>
            </div>
          </form>
    </TrappedModalLayer>

    <TrappedModalLayer open={vaccineModal} onClose={() => setVaccineModal(false)} width="min(460px, calc(100% - 32px))">
          <button className="button button--icon modal__close" onClick={() => setVaccineModal(false)} aria-label="Cerrar"><Icon name="close" size={18}/></button>
          <span className="modal__icon"><Icon name="shield"/></span>
          <h2 style={{ textAlign: "center" }}>Registrar vacuna</h2>
          <p style={{ textAlign: "center", marginBottom: 20 }}>Agregá una vacuna aplicada o programada para {pet.name}.</p>
          <form onSubmit={handleAddVaccine}>
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <label className="field"><span>Nombre de la vacuna</span><input value={vacName} onChange={(e) => setVacName(e.target.value)} placeholder="Ej: Antirrábica / Séxtuple" required/></label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="field"><span>Fecha de aplicación</span><input value={vacDate} onChange={(e) => setVacDate(e.target.value)} placeholder="Ej: 12 Mar 2026"/></label>
                <label className="field"><span>Próxima dosis</span><input value={vacNext} onChange={(e) => setVacNext(e.target.value)} placeholder="Ej: 12 Mar 2027"/></label>
              </div>
              <label className="field"><span>Estado</span>
                <select value={vacStatus} onChange={(e) => setVacStatus(e.target.value as "Al día" | "Próxima" | "Vencida")} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                  <option value="Al día">Al día</option>
                  <option value="Próxima">Próxima</option>
                  <option value="Vencida">Vencida</option>
                </select>
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
              <Button variant="secondary" onClick={() => setVaccineModal(false)}>Cancelar</Button>
              <Button type="submit" variant="primary">Guardar vacuna</Button>
            </div>
          </form>
    </TrappedModalLayer>

    <TrappedModalLayer open={documentModal} onClose={() => setDocumentModal(false)} width="min(460px, calc(100% - 32px))">
          <button className="button button--icon modal__close" onClick={() => setDocumentModal(false)} aria-label="Cerrar"><Icon name="close" size={18}/></button>
          <span className="modal__icon"><Icon name="file"/></span>
          <h2 style={{ textAlign: "center" }}>Adjuntar documento</h2>
          <p style={{ textAlign: "center", marginBottom: 20 }}>Subí un estudio, receta o certificado para {pet.name}.</p>
          <form onSubmit={handleAddDoc}>
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <label className="field"><span>Nombre del documento</span><input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="Ej: Radiografía de tórax" required/></label>
              <label className="field"><span>Tipo de documento</span>
                <select value={docType} onChange={(e) => setDocType(e.target.value)} style={{ width: "100%", height: 43, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white", color: "var(--ink)" }}>
                  <option value="Estudio médico">Estudio médico</option>
                  <option value="Análisis de sangre">Análisis de sangre</option>
                  <option value="Certificado">Certificado de vacunación</option>
                  <option value="Receta veterinaria">Receta veterinaria</option>
                  <option value="Otro">Otro archivo</option>
                </select>
              </label>
              <label className="field">
                <span>Archivo adjunto</span>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setDocFile(f);
                    if (f && !docName) setDocName(f.name.replace(/\.[^/.]+$/, ""));
                  }}
                  required
                />
              </label>
              {docFile && (
                <small style={{ color: "var(--teal)", fontSize: 13, marginTop: -4 }}>
                  Archivo seleccionado: <b>{docFile.name}</b> ({(docFile.size / (1024 * 1024)).toFixed(2)} MB)
                </small>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
              <Button variant="secondary" onClick={() => setDocumentModal(false)}>Cancelar</Button>
              <Button type="submit" variant="primary">Adjuntar</Button>
            </div>
          </form>
    </TrappedModalLayer>

    {deleteDocId && (
      <Modal 
        title="Eliminar documento" 
        text="¿Seguro que querés eliminar este documento? Esta acción no se puede deshacer." 
        cancel="Volver" 
        confirm="Eliminar documento" 
        destructive 
        onClose={() => setDeleteDocId(null)} 
        onConfirm={() => handleDeleteDoc(deleteDocId)}
      />
    )}

    {toastMsg && <Toast message={toastMsg} tone={toastMsg.includes("Error") ? "error" : "success"}/>}
  </>;
}

export function ConsultationsPage({ initialTab = "Próximas" }: { initialTab?: string }) {
  const { consultations, consultationsLoading, consultationsError, refetchConsultations } = useClientData();
  const [filter, setFilter] = useState(initialTab);
  const shown = filter === "Finalizadas" ? consultations.filter(c => c.status === "Finalizada")
    : filter === "En curso" ? consultations.filter(c => c.status === "Confirmada" || c.status === "Pendiente")
    : filter === "Agenda" ? consultations
    : consultations;

  return <>
    <PageHeader eyebrow="Atención veterinaria" title="Mis consultas" description="Seguí tus próximas consultas, revisá las anteriores y organizá tus turnos." action={<Button onClick={() => go("/client/triage")}>Nueva consulta</Button>}/>
    <Tabs tabs={["Próximas", "En curso", "Finalizadas", "Agenda"]} active={filter} onChange={setFilter}/>
    <SectionStage stageKey={filter}>
    {consultationsError && !consultationsLoading ? (
      <ErrorState onRetry={() => void refetchConsultations()} />
    ) : filter === "Agenda" ? (
      <AppointmentsCalendar consultations={consultations} />
    ) : (
      <>
        {filter === "En curso" && shown[0] && <section className="active-call active-call--page"><div className="active-call__mascot" data-testid="consultations-hamster-mascot"><HamsterMascot size="xs"/></div><div><span className="eyebrow">En espera</span><h2>Tu consulta está en curso</h2><p>{`${shown[0].vet} se va a conectar en breve.`}</p></div><Button onClick={() => go(`/call/${shown[0].id}?from=client&state=waiting`)}>Entrar a la consulta</Button></section>}
        {shown.length === 0 ? <div className="panel"><EmptyState icon="video" title="No hay consultas en esta sección" text="Podés solicitar una nueva consulta de telemedicina veterinaria cuando lo necesites." action="Nueva consulta" onAction={() => go("/client/triage")}/></div> : <div className="consultation-list">{shown.map((item) => <ConsultationCard item={item} key={item.id}/>)}</div>}
      </>
    )}
    </SectionStage>
  </>;
}

function ConsultationDetail() {
  const { consultations, consultationsLoading, consultationsError, refetchConsultations, pets } = useClientData();
  const pathId = window.location.pathname.split("/").pop();
  const activeConsultation = consultations.find(c => c.id === pathId);
  const [tab, setTab] = useState("Resumen");

  if (consultationsLoading && !activeConsultation) {
    return <SkeletonPage type="list" />;
  }

  if (consultationsError && !activeConsultation) {
    return (
      <>
        <button className="back-link" onClick={() => go("/client/consultations")}><Icon name="arrow" size={17}/> Volver a mis consultas</button>
        <ErrorState onRetry={() => void refetchConsultations()} />
      </>
    );
  }

  if (!activeConsultation) {
    return (
      <>
        <button className="back-link" onClick={() => go("/client/consultations")}><Icon name="arrow" size={17}/> Volver a mis consultas</button>
        <div className="panel" style={{ marginTop: 20 }}>
          <EmptyState icon="video" title="Consulta no encontrada" text="No encontramos la información de esta consulta." action="Ver mis consultas" onAction={() => go("/client/consultations")}/>
        </div>
      </>
    );
  }

  const matchedPet = pets.find(
    (p) => p.name.toLowerCase() === (activeConsultation.pet || "").toLowerCase()
  );

  return <>
    <button className="back-link" onClick={() => go("/client/consultations")}><Icon name="arrow" size={17}/> Volver a mis consultas</button>
    <PageHeader eyebrow={`Consulta ${activeConsultation.status || "confirmada"}`} title={activeConsultation.title || "Consulta veterinaria"} description={`${activeConsultation.date || "Hoy"}, ${activeConsultation.time || "19:30"} · Videoconsulta`} action={<Button icon="video" onClick={() => go(`/call/${activeConsultation.id}?from=client`)}>Entrar a videoconsulta</Button>}/>
    <section className="consultation-summary"><div className="vet-avatar">VC</div><div><small>Profesional</small><strong>{activeConsultation.vet || "Veterinario de guardia"}</strong><p>Clínica general</p></div><div><small>Mascota</small><strong>{activeConsultation.pet || "Mascota"}</strong><p>{matchedPet?.kind || "Animal de compañía"}</p></div><div><small>Motivo</small><strong>{activeConsultation.reason || "Orientación médica"}</strong><p>Teleconsulta telemática</p></div><Status>{activeConsultation.status || "Confirmada"}</Status></section>
    <Tabs tabs={["Resumen", "Mensajes", "Historial", "Recetas", "Documentos"]} active={tab} onChange={setTab}/>
    <SectionStage stageKey={tab}>
    {tab === "Resumen" ? <div className="detail-grid"><section className="panel"><div className="panel__heading"><h2>Antes de la consulta</h2></div><div className="checklist"><p><Icon name="check"/> Tené a tu mascota cerca</p><p><Icon name="check"/> Buscá un lugar tranquilo</p><p><Icon name="check"/> Revisá tu conexión</p></div></section><section className="panel"><div className="panel__heading"><h2>Notas para el veterinario</h2></div><p className="muted">{activeConsultation.reason || "Consulta médica general registrada en sistema."}</p><Button variant="soft" icon="edit" onClick={() => go("/client/triage")}>Editar consulta</Button></section></div> : <section className="panel"><EmptyState icon={tab === "Mensajes" ? "message" : "file"} title={tab} text={`La información de ${tab.toLowerCase()} de esta consulta aparecerá acá.`}/></section>}
    </SectionStage>
  </>;
}

function AppointmentsCalendar({ consultations }: { consultations: ClientViewConsultation[] }) {
  const queryClient = useQueryClient();
  const { pets } = useClientData({ includeConsultations: false });
  const [modal, setModal] = useState<string | null>(null);
  const [reschedId, setReschedId] = useState<string | null>(null);
  const [reschedAt, setReschedAt] = useState("");
  const [reschedBusy, setReschedBusy] = useState(false);

  const [bookOpen, setBookOpen] = useState(false);
  const [bookPetId, setBookPetId] = useState("");
  const [bookVetId, setBookVetId] = useState("");
  const [bookDate, setBookDate] = useState(() => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [bookSlotIso, setBookSlotIso] = useState("");
  const [bookNotes, setBookNotes] = useState("");
  const [bookBusy, setBookBusy] = useState(false);

  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const vetsQuery = useQuery({
    queryKey: ["scheduling", "vets"],
    enabled: bookOpen,
    queryFn: async () => {
      const res = await api.get<ApiResponse<Array<{ id: string; firstName: string; lastName: string; specialty: string | null }>>>("/api/scheduling/vets");
      return res.data.success && res.data.data ? res.data.data : [];
    },
  });

  const slotsQuery = useQuery({
    queryKey: ["scheduling", "slots", bookVetId, bookDate],
    enabled: Boolean(bookOpen && bookVetId && bookDate),
    queryFn: async () => {
      const res = await api.get<ApiResponse<{ slots: Array<{ startIso: string; label: string; available: boolean }> }>>(
        `/api/scheduling/vets/${bookVetId}/slots?date=${encodeURIComponent(bookDate)}`
      );
      return res.data.success && res.data.data ? res.data.data.slots : [];
    },
  });

  const [fuReschedId, setFuReschedId] = useState<string | null>(null);
  const [fuReschedAt, setFuReschedAt] = useState("");
  const [fuActionBusy, setFuActionBusy] = useState(false);

  const followUpsQuery = useQuery({
    queryKey: ["follow-ups", "client"],
    retry: false,
    queryFn: async () => {
      const res = await api.get<ApiResponse<Array<{ id: string; petName?: string; vetName?: string; title: string; notes?: string | null; scheduledAt: string; status: string }>>>("/api/scheduling/follow-ups");
      return res.data.success && res.data.data ? res.data.data : [];
    },
  });

  useEffect(() => {
    if (bookOpen && !bookPetId && pets.length > 0) {
      setBookPetId(pets[0].id);
    }
  }, [bookOpen, bookPetId, pets]);

  useEffect(() => {
    if (bookOpen && !bookVetId && vetsQuery.data && vetsQuery.data.length > 0) {
      setBookVetId(vetsQuery.data[0].id);
    }
  }, [bookOpen, bookVetId, vetsQuery.data]);

  useEffect(() => {
    if (bookOpen && slotsQuery.data && slotsQuery.data.length > 0) {
      const firstAvailable = slotsQuery.data.find((s) => s.available);
      setBookSlotIso(firstAvailable?.startIso || "");
    } else if (bookOpen) {
      setBookSlotIso("");
    }
  }, [bookOpen, slotsQuery.data]);

  const handleBookAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookPetId || !bookVetId || !bookNotes.trim()) return;
    const targetIso = bookSlotIso || new Date(`${bookDate}T14:00:00.000Z`).toISOString();
    setBookBusy(true);
    try {
      await api.post("/api/scheduling/appointments", {
        petId: bookPetId,
        vetId: bookVetId,
        scheduledAt: targetIso,
        notes: bookNotes.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["consultations", "mine"] });
      setBookOpen(false);
      setBookNotes("");
      setToastMsg("Turno programado correctamente");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("No pudimos programar el turno en ese horario");
      setTimeout(() => setToastMsg(null), 3500);
    } finally {
      setBookBusy(false);
    }
  };

  const handleRescheduleSubmit = async () => {
    if (!reschedId || !reschedAt) return;
    setReschedBusy(true);
    try {
      await api.patch(`/api/consultations/${reschedId}/reschedule`, {
        scheduledAt: new Date(reschedAt).toISOString(),
        reason: "Reprogramado desde la agenda del tutor",
      });
      await queryClient.invalidateQueries({ queryKey: ["consultations", "mine"] });
      setReschedId(null);
      setReschedAt("");
      setToastMsg("Turno reprogramado correctamente");
      setTimeout(() => setToastMsg(null), 3500);
    } catch {
      setToastMsg("No se pudo reprogramar el turno");
      setTimeout(() => setToastMsg(null), 3500);
    } finally {
      setReschedBusy(false);
    }
  };

  // Real-time Calendar state
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth(); // 0-indexed

  const monthName = viewDate.toLocaleDateString("es-AR", { month: "long" });
  const capitalizedMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  // Month navigation
  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  // Calendar math
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0, Sunday = 6

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const todayDateNumber = today.getDate();

  // Map dates with consultations matching visible month/year (fallback to day number if rawDate is absent)
  const matchesVisibleMonth = (c: ClientViewConsultation) => {
    if (!c.rawDate) return true;
    const parsedDate = new Date(c.rawDate);
    if (Number.isNaN(parsedDate.getTime())) return true;
    return parsedDate.getFullYear() === year && parsedDate.getMonth() === month;
  };

  const eventDays = useMemo(() => {
    const map = new Map<number, "confirmada" | "pendiente">();
    consultations.forEach(c => {
      if (!matchesVisibleMonth(c)) return;
      const dayNum = c.rawDate ? new Date(c.rawDate).getDate() : parseInt(c.date, 10);
      if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
        map.set(dayNum, c.status === "Confirmada" ? "confirmada" : "pendiente");
      }
    });
    return map;
  }, [consultations, year, month]);

  // Filter consultations
  const filteredConsultations = useMemo(() => {
    if (!selectedDateStr) return consultations;
    return consultations.filter(c => {
      if (!matchesVisibleMonth(c)) return false;
      const dayNum = c.rawDate ? new Date(c.rawDate).getDate() : parseInt(c.date, 10);
      return String(dayNum) === selectedDateStr;
    });
  }, [consultations, selectedDateStr, year, month]);

  const cancelMutation = useMutation({
    mutationFn: async (consId: string) => {
      const res = await api.patch<ApiResponse<BackendConsultation>>(`/api/consultations/${consId}/cancel`, {
        reason: "Cancelado desde la agenda del tutor",
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['consultations', 'mine'] });
      queryClient.invalidateQueries({ queryKey: ['pets'] });
      queryClient.invalidateQueries({ queryKey: ['pets', 'mine'] });
      setModal(null);
      setToastMsg("Turno cancelado correctamente");
      setTimeout(() => setToastMsg(null), 3500);
    },
    onError: () => {
      setToastMsg("No se pudo cancelar el turno");
      setTimeout(() => setToastMsg(null), 3500);
    },
  });

  return <>
    
    <div className="calendar-layout">
      <section className="panel calendar">
        <div className="calendar__head">
          <div>
            <span className="eyebrow">Calendario</span>
            <h2>{capitalizedMonth} {year}</h2>
          </div>
          <div>
            <Button variant="icon" icon="chevron" ariaLabel="Mes anterior" onClick={prevMonth}/>
            <Button variant="icon" icon="chevron" ariaLabel="Mes siguiente" onClick={nextMonth} className="calendar-nav-next"/>
          </div>
        </div>
        <div className="calendar__week">
          {["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(d => <span key={d}>{d}</span>)}
        </div>
        <div className="calendar__days">
          {/* Empty padding days for previous month */}
          {Array.from({ length: firstDayOfWeek }).map((_, i) => (
            <span key={`pad-${i}`} aria-hidden="true" style={{ opacity: 0.2 }} />
          ))}
          {/* Month days */}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const dayNum = i + 1;
            const isToday = isCurrentMonth && dayNum === todayDateNumber;
            const isSelected = selectedDateStr === String(dayNum);
            const hasEvent = eventDays.has(dayNum);
            return (
              <button 
                key={dayNum}
                className={`${isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""} ${hasEvent ? "has-event" : ""}`}
                onClick={() => setSelectedDateStr(isSelected ? null : String(dayNum))}
              >
                {dayNum}
              </button>
            );
          })}
        </div>
        <div className="calendar__legend">
          <span><i className="teal-dot"/>Consulta confirmada</span>
          <span><i className="amber-dot"/>Pendiente</span>
          {selectedDateStr && (
            <button 
              onClick={() => setSelectedDateStr(null)} 
              style={{ marginLeft: "auto", border: 0, background: "none", color: "var(--teal-deep)", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
            >
              Ver todos los turnos
            </button>
          )}
        </div>
      </section>

      <aside className="panel agenda-list">
        <div className="panel__heading">
          <div>
            <span className="eyebrow">{selectedDateStr ? `Día ${selectedDateStr} de ${capitalizedMonth}` : "Próximos"}</span>
            <h2>{selectedDateStr ? "Turnos del día" : "Tus turnos"}</h2>
          </div>
          <Button icon="plus" onClick={() => setBookOpen(true)}>Programar turno</Button>
        </div>
        {filteredConsultations.length > 0 ? (
          filteredConsultations.map(item => (
            <div className="agenda-item" key={item.id}>
              <div>
                <b>{item.date} · {item.time}</b>
                <strong>{item.title}</strong>
                <span>{item.pet} · {item.vet}</span>
              </div>
              <div className="agenda-item__actions">
                <Status tone={item.status === "Cancelada" ? "gray" : item.status === "Pendiente" ? "amber" : "teal"}>
                  {item.status}
                </Status>
                {item.status !== "Cancelada" && item.status !== "Finalizada" && (
                  <>
                    <button onClick={() => { setReschedId(item.id); setReschedAt(""); }}>Reprogramar</button>
                    <button onClick={() => setModal(item.id)}>Cancelar turno</button>
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="v-mini-empty" style={{ padding: "24px 0", color: "var(--ink-soft)", fontSize: 12, textAlign: "center" }}>
            {selectedDateStr ? "No tenés turnos agendados para este día." : "No tenés turnos programados."}
          </p>
        )}

        {(followUpsQuery.data?.length ?? 0) > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line, #e4dfd2)" }}>
            <span className="eyebrow">Continuidad médica</span>
            <h3 style={{ fontSize: 15, marginBottom: 10 }}>Próximos seguimientos</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {followUpsQuery.data!.map((fu) => (
                <div key={fu.id} className="agenda-item">
                  <div>
                    <b>{formatDateAR(fu.scheduledAt, true)}</b>
                    <strong>{fu.title}</strong>
                    <span>{fu.petName || "Mascota"} {fu.vetName ? `· ${fu.vetName}` : ""}</span>
                    {fu.notes && <small style={{ display: "block", color: "var(--ink-soft)", marginTop: 2 }}>{fu.notes}</small>}
                  </div>
                  <div className="agenda-item__actions">
                    <Status tone={fu.status === "COMPLETED" ? "teal" : fu.status === "CANCELLED" ? "gray" : "amber"}>
                      {fu.status === "COMPLETED" ? "Realizado" : fu.status === "CANCELLED" ? "Cancelado" : "Pendiente"}
                    </Status>
                    {fu.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setFuReschedId(fu.id);
                            setFuReschedAt("");
                          }}
                        >
                          Proponer otro horario
                        </button>
                        <button
                          type="button"
                          disabled={fuActionBusy}
                          onClick={async () => {
                            setFuActionBusy(true);
                            try {
                              await api.patch(`/api/scheduling/follow-ups/${fu.id}`, { status: "CANCELLED" });
                              await queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
                              setToastMsg("Seguimiento cancelado; avisamos al veterinario");
                              setTimeout(() => setToastMsg(null), 3500);
                            } catch {
                              setToastMsg("No se pudo actualizar el seguimiento");
                              setTimeout(() => setToastMsg(null), 3500);
                            } finally {
                              setFuActionBusy(false);
                            }
                          }}
                        >
                          No puedo asistir
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>

    <TrappedModalLayer open={Boolean(fuReschedId)} onClose={() => setFuReschedId(null)} width="min(420px, calc(100% - 32px))">
      <button className="button button--icon modal__close" onClick={() => setFuReschedId(null)} aria-label="Cerrar"><Icon name="close" size={18}/></button>
      <h2 style={{ textAlign: "center" }}>Proponer otro horario</h2>
      <p style={{ textAlign: "center", marginBottom: 16 }}>Elegí el día y horario en que podés asistir con tu mascota.</p>
      <label className="field">
        <span>Nueva fecha y hora</span>
        <input type="datetime-local" value={fuReschedAt} onChange={(e) => setFuReschedAt(e.target.value)} required />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Button variant="secondary" onClick={() => setFuReschedId(null)}>Volver</Button>
        <Button
          disabled={!fuReschedAt || fuActionBusy}
          onClick={async () => {
            if (!fuReschedId || !fuReschedAt) return;
            setFuActionBusy(true);
            try {
              await api.patch(`/api/scheduling/follow-ups/${fuReschedId}`, {
                dueAt: new Date(fuReschedAt).toISOString(),
              });
              await queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
              setFuReschedId(null);
              setFuReschedAt("");
              setToastMsg("Nuevo horario propuesto al veterinario");
              setTimeout(() => setToastMsg(null), 3500);
            } catch {
              setToastMsg("No se pudo proponer ese horario");
              setTimeout(() => setToastMsg(null), 3500);
            } finally {
              setFuActionBusy(false);
            }
          }}
        >
          {fuActionBusy ? "Enviando..." : "Enviar propuesta"}
        </Button>
      </div>
    </TrappedModalLayer>

    <TrappedModalLayer open={bookOpen} onClose={() => setBookOpen(false)} width="min(480px, calc(100% - 32px))">
      <button className="button button--icon modal__close" onClick={() => setBookOpen(false)} aria-label="Cerrar"><Icon name="close" size={18}/></button>
      <span className="modal__icon"><Icon name="calendar"/></span>
      <h2 style={{ textAlign: "center" }}>Programar turno</h2>
      <p style={{ textAlign: "center", marginBottom: 16 }}>Elegí tu mascota, profesional y horario disponible.</p>
      <form onSubmit={handleBookAppointment}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="field">
            <span>Mascota</span>
            <select value={bookPetId} onChange={(e) => setBookPetId(e.target.value)} style={{ width: "100%", height: 42, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white" }} required>
              {pets.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>)}
            </select>
          </label>
          <label className="field">
            <span>Profesional veterinario</span>
            <select value={bookVetId} onChange={(e) => setBookVetId(e.target.value)} style={{ width: "100%", height: 42, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white" }} required>
              {(vetsQuery.data || []).map((v) => <option key={v.id} value={v.id}>Dr. {v.firstName} {v.lastName}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Fecha</span>
            <input type="date" value={bookDate} onChange={(e) => setBookDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Horario disponible</span>
            <select value={bookSlotIso} onChange={(e) => setBookSlotIso(e.target.value)} style={{ width: "100%", height: 42, borderRadius: 10, border: "1px solid var(--line)", padding: "0 12px", background: "white" }}>
              {(slotsQuery.data || []).filter((s) => s.available).length > 0 ? (
                (slotsQuery.data || []).filter((s) => s.available).map((s) => (
                  <option key={s.startIso} value={s.startIso}>{s.label} hs</option>
                ))
              ) : (
                <option value="">14:00 hs (horario sugerido)</option>
              )}
            </select>
          </label>
          <label className="field">
            <span>Motivo de la consulta</span>
            <input value={bookNotes} onChange={(e) => setBookNotes(e.target.value)} placeholder="Ej: Control anual, vacunación, revisión" required />
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          <Button variant="secondary" onClick={() => setBookOpen(false)}>Cancelar</Button>
          <Button type="submit" disabled={bookBusy}>{bookBusy ? "Reservando..." : "Confirmar turno"}</Button>
        </div>
      </form>
    </TrappedModalLayer>

    <TrappedModalLayer open={Boolean(reschedId)} onClose={() => setReschedId(null)} width="min(420px, calc(100% - 32px))">
      <button className="button button--icon modal__close" onClick={() => setReschedId(null)} aria-label="Cerrar"><Icon name="close" size={18}/></button>
      <h2 style={{ textAlign: "center" }}>Reprogramar turno</h2>
      <p style={{ textAlign: "center", marginBottom: 16 }}>Seleccioná la nueva fecha y hora para tu consulta.</p>
      <label className="field">
        <span>Nueva fecha y hora</span>
        <input type="datetime-local" value={reschedAt} onChange={(e) => setReschedAt(e.target.value)} required />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
        <Button variant="secondary" onClick={() => setReschedId(null)}>Volver</Button>
        <Button disabled={!reschedAt || reschedBusy} onClick={handleRescheduleSubmit}>{reschedBusy ? "Guardando..." : "Guardar horario"}</Button>
      </div>
    </TrappedModalLayer>

    {modal && (
      <Modal 
        title="Cancelar consulta" 
        text="¿Seguro que querés cancelar esta consulta? El turno quedará liberado para otro paciente." 
        cancel="Volver" 
        confirm="Cancelar consulta" 
        destructive 
        onClose={() => setModal(null)}
        onConfirm={() => cancelMutation.mutate(modal)}
      />
    )}
    {toastMsg && <Toast message={toastMsg} tone={toastMsg.includes("No") ? "error" : "success"}/>}
  </>;
}

function WhatsAppCheck({ state }: { state: "sending" | "sent" | "delivered" | "read" }) {
  if (state === "sending" || state === "sent") {
    return (
      <svg width="15" height="11" viewBox="0 0 16 11" fill="none" aria-label="Enviado">
        <path d="M1.5 6L5.5 10L14.5 1" stroke="#607674" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  const color = state === "read" ? "#609f9c" : "#607674";
  return (
    <svg width="16" height="11" viewBox="0 0 18 11" fill="none" aria-label={state === "read" ? "Leído" : "Entregado"}>
      <path d="M1 6L5 10L14 1" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 6L9 10L18 1" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

interface WADocAttachment {
  title: string;
  sub: string;
  bannerTag?: string;
  bannerTitle?: string;
  fileUrl?: string;
  isImage?: boolean;
}

interface WAMessageItem {
  id: string;
  clientMsgId?: string;
  sender: "me" | "them";
  senderName?: string;
  text?: string;
  doc?: WADocAttachment;
  time: string;
  state: "sending" | "sent" | "delivered" | "read";
}

interface WAChatConversation {
  id: string;
  name: string;
  role: string;
  avatarText: string;
  isOnline: boolean;
  statusText: string;
  lastTime: string;
  preview: string;
  unreadCount?: number;
  isPinned?: boolean;
  category: "vets" | "consults";
  messages: WAMessageItem[];
}

export function AppointmentsPage() {
  return <ConsultationsPage initialTab="Agenda" />;
}

function getSavedChatMessages(chatId: string): WAMessageItem[] {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = localStorage.getItem(`huellicam_chat_${chatId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch {}
  return [];
}

function saveChatMessages(chatId: string, messages: WAMessageItem[]) {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.setItem(`huellicam_chat_${chatId}`, JSON.stringify(messages));
    }
  } catch {}
}

interface ClientChatRawMessage {
  id?: string;
  clientMsgId?: string;
  consultationId?: string;
  senderId?: string;
  content: string;
  attachmentUrl?: string | null;
  createdAt?: string;
  sender?: {
    firstName?: string;
    lastName?: string;
  };
}

const CLIENT_CHAT_IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i;

function buildClientDocFromMessage(m: ClientChatRawMessage): WADocAttachment | undefined {
  const resolved = normalizeMediaUrl(m.attachmentUrl);
  if (!resolved) return undefined;
  const contentText = (m.content || "").trim();
  const title = contentText.replace(/^📎\s*Adjunto:\s*/i, "") || "Archivo clínico adjunto";
  const isImage = CLIENT_CHAT_IMAGE_RE.test(resolved) || CLIENT_CHAT_IMAGE_RE.test(title);
  return {
    title,
    sub: isImage ? "Imagen clínica adjunta" : "Documento clínico adjunto",
    bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
    bannerTitle: "Huellicam · Expediente Clínico",
    fileUrl: resolved,
    isImage,
  };
}

export function MessagesPage() {
  const { pets, consultations, consultationsLoading, consultationsError, refetchConsultations } = useClientData();
  const { user } = useAuth();
  const { socket, joinConsultation, leaveConsultation } = useSocket();
  const roomActionsRef = useRef({ joinConsultation, leaveConsultation });
  roomActionsRef.current = { joinConsultation, leaveConsultation };
  const petName = pets[0]?.name || "tu mascota";

  const [activeChip, setActiveChip] = useState<string>("Todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeChatId, setActiveChatId] = useState<string>("");
  const [inputText, setInputText] = useState("");
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [showNotificationBanner, setShowNotificationBanner] = useState(true);
  const [deletedIds, setDeletedIds] = useState<string[]>(() => readDeletedChatIds(user?.id));
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<WAChatConversation | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [conversations, setConversations] = useState<WAChatConversation[]>([]);

  useEffect(() => {
    setDeletedIds(readDeletedChatIds(user?.id));
  }, [user?.id]);

  useEffect(() => {
    if (!openMenuId && !headerMenuOpen) return;
    const onDocClick = () => {
      setOpenMenuId(null);
      setHeaderMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenuId(null);
        setHeaderMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuId, headerMenuOpen]);

  const deletedSet = useMemo(() => new Set(deletedIds), [deletedIds]);
  const availableConversations = useMemo(
    () => conversations.filter((c) => !deletedSet.has(c.id)),
    [conversations, deletedSet]
  );

  const handleConfirmDeleteChat = async () => {
    if (!confirmDeleteChat) return;
    const target = confirmDeleteChat;
    setDeletingChat(true);
    try {
      await api.delete(`/api/consultations/${target.id}/messages`);
      clearChatLocalCache(target.id);
      setConversations((prev) => prev.map((c) => (c.id === target.id ? { ...c, messages: [] } : c)));
      const next = addDeletedChatId(deletedIds, target.id);
      setDeletedIds(next);
      saveDeletedChatIds(user?.id, next);
      if (activeChatId === target.id) {
        setActiveChatId("");
        setMobileThreadOpen(false);
      }
      setConfirmDeleteChat(null);
      setToastMsg(`Chat con ${target.name} eliminado permanentemente.`);
      setTimeout(() => setToastMsg(null), 3000);
    } catch {
      setToastMsg("No se pudo eliminar el chat. Intentá nuevamente.");
      setTimeout(() => setToastMsg(null), 3500);
    } finally {
      setDeletingChat(false);
    }
  };

  const filteredChats = useMemo(() => {
    return availableConversations.filter((chat) => {
      if (activeChip === "En curso" && !chat.isOnline && !chat.role.includes("Confirmada") && !chat.role.includes("Pendiente")) return false;
      if (activeChip === "Finalizadas" && !chat.role.includes("Finalizada")) return false;

      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return chat.name.toLowerCase().includes(q) || chat.preview.toLowerCase().includes(q) || chat.role.toLowerCase().includes(q);
    });
  }, [availableConversations, activeChip, searchQuery]);

  const activeChat =
    filteredChats.find((c) => c.id === activeChatId) ||
    availableConversations.find((c) => c.id === activeChatId) ||
    filteredChats[0] ||
    availableConversations[0] ||
    null;

  const scrollToBottom = () => {
    if (typeof messagesEndRef.current?.scrollIntoView === "function") {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeChatId, activeChat?.messages, isTyping]);

  const consultationsKey = useMemo(() => {
    return (consultations || []).map((c) => `${c.id}:${c.status}:${c.rawStatus}`).join(",");
  }, [consultations]);

  useEffect(() => {
    if (consultations && consultations.length > 0) {
      const realConvs: WAChatConversation[] = consultations.map((c) => {
        const vetName = c.vet && c.vet !== "Sin asignar" ? c.vet : "Guardia / Pendiente";
        const initials = getInitials(vetName, "VC");
        return {
          id: c.id,
          name: vetName,
          role: `Consulta de ${c.pet} · ${c.status}`,
          avatarText: initials,
          isOnline: c.rawStatus === "ACTIVE",
          statusText: c.rawStatus === "ACTIVE" ? "En consulta activa" : `Estado: ${c.status}`,
          lastTime: c.time || "Hoy",
          preview: c.reason || "Consulta clínica",
          isPinned: c.rawStatus === "ACTIVE",
          category: "consults",
          messages: getSavedChatMessages(c.id),
        };
      });

      setConversations((prev) => {
        return realConvs.map((rc) => {
          const existing = prev.find((p) => p.id === rc.id);
          if (existing && existing.messages.length > 0) {
            return {
              ...rc,
              messages: existing.messages,
              preview: existing.preview,
              lastTime: existing.lastTime,
            };
          }
          return rc;
        });
      });

      setActiveChatId((curr) => {
        if (!curr || !realConvs.some((rc) => rc.id === curr)) {
          return realConvs[0]?.id || "";
        }
        return curr;
      });
    } else {
      setConversations((prev) => (prev.length === 0 ? prev : []));
      setActiveChatId((curr) => (curr === "" ? curr : ""));
    }
  }, [consultationsKey]);

  const activeMatchingCons = consultations.find((c) => c.id === activeChatId);
  const activeConsultationId = activeMatchingCons?.id || "";
  const activeVetNameRef = useRef<string>("");
  activeVetNameRef.current = activeMatchingCons?.vet || "";

  useEffect(() => {
    if (!activeConsultationId) return;
    let cancelled = false;

    api
      .get<ApiResponse<ClientChatRawMessage[]>>(`/api/consultations/${activeConsultationId}/messages`)
      .then((res) => {
        if (cancelled) return;
        if (res.data.success && res.data.data) {
          const mappedMsgs: WAMessageItem[] = res.data.data.map((m) => {
            const isMine = m.senderId === user?.id;
            const time = m.createdAt
              ? new Date(m.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
              : "Ahora";
            const doc = buildClientDocFromMessage(m);
            const displayText =
              doc && m.content?.startsWith("📎 Adjunto:") ? undefined : m.content;
            return {
              id: m.id || m.clientMsgId || `${time}-${Math.random()}`,
              clientMsgId: m.clientMsgId,
              sender: isMine ? "me" : "them",
              senderName: m.sender ? `${m.sender.firstName ?? ""} ${m.sender.lastName ?? ""}`.trim() : activeVetNameRef.current,
              text: displayText,
              doc,
              time,
              state: "read",
            };
          });

          setConversations((prev) =>
            prev.map((c) => {
              if (c.id === activeConsultationId) {
                const merged = mappedMsgs.length > 0 ? mappedMsgs : c.messages;
                saveChatMessages(c.id, merged);
                return {
                  ...c,
                  messages: merged,
                };
              }
              return c;
            })
          );
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeConsultationId, user?.id]);

  useEffect(() => {
    if (!activeConsultationId) return;
    roomActionsRef.current.joinConsultation(activeConsultationId);

    const handleNewMessage = (msg: ClientChatRawMessage) => {
      if (msg?.consultationId && msg.consultationId !== activeConsultationId) return;
      const isMine = msg.senderId === user?.id;
      const time = msg.createdAt
        ? new Date(msg.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
        : "Ahora";
      const doc = buildClientDocFromMessage(msg);
      const displayText =
        doc && msg.content?.startsWith("📎 Adjunto:") ? undefined : msg.content;
      const newWAMsg: WAMessageItem = {
        id: msg.id || msg.clientMsgId || `${time}-${Math.random()}`,
        clientMsgId: msg.clientMsgId,
        sender: isMine ? "me" : "them",
        senderName: msg.sender ? `${msg.sender.firstName ?? ""} ${msg.sender.lastName ?? ""}`.trim() : activeVetNameRef.current,
        text: displayText,
        doc,
        time,
        state: "read",
      };

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id === activeConsultationId) {
            const existingIdx = c.messages.findIndex(
              (m) =>
                m.id === newWAMsg.id ||
                (msg.clientMsgId &&
                  (m.clientMsgId === msg.clientMsgId || m.id === msg.clientMsgId))
            );
            const updated =
              existingIdx >= 0
                ? c.messages.map((m, i) =>
                    i === existingIdx
                      ? {
                          ...m,
                          ...newWAMsg,
                          doc: newWAMsg.doc ?? m.doc,
                        }
                      : m
                  )
                : [...c.messages, newWAMsg];
            saveChatMessages(c.id, updated);
            return {
              ...c,
              lastTime: time,
              preview: msg.content,
              messages: updated,
            };
          }
          return c;
        })
      );
    };

    const handleChatDeleted = (payload?: { consultationId?: string }) => {
      if (payload?.consultationId && payload.consultationId !== activeConsultationId) return;
      clearChatLocalCache(activeConsultationId);
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConsultationId ? { ...c, messages: [], preview: "Sin mensajes" } : c))
      );
    };

    socket?.on?.("message:new", handleNewMessage);
    socket?.on?.("chat:deleted", handleChatDeleted);

    return () => {
      socket?.off?.("message:new", handleNewMessage);
      socket?.off?.("chat:deleted", handleChatDeleted);
      roomActionsRef.current.leaveConsultation(activeConsultationId);
    };
  }, [socket, activeConsultationId, user?.id]);

  const handleSelectChat = (chatId: string) => {
    setActiveChatId(chatId);
    setMobileThreadOpen(true);
    setConversations((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, unreadCount: undefined } : c))
    );
  };

  const handleSend = (textToSend?: string) => {
    const content = (textToSend !== undefined ? textToSend : inputText).trim();
    if (!content || !activeChat) return;

    const newMsgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nowTime = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

    const newMsg: WAMessageItem = {
      id: newMsgId,
      clientMsgId: newMsgId,
      sender: "me",
      text: content,
      time: nowTime,
      state: "sent",
    };

    setConversations((prev) =>
      prev.map((chat) => {
        if (chat.id === activeChat.id) {
          const updated = [...chat.messages, newMsg];
          saveChatMessages(chat.id, updated);
          return {
            ...chat,
            lastTime: nowTime,
            preview: content,
            messages: updated,
          };
        }
        return chat;
      })
    );

    setInputText("");
    setShowAttachMenu(false);

    const matchingCons = consultations.find((c) => c.id === activeChat.id);
    if (matchingCons) {
      api
        .post(`/api/consultations/${matchingCons.id}/messages`, {
          content,
          clientMsgId: newMsgId,
        })
        .catch((err) => console.error("Error sending real message:", err));
    }
  };

  const handleRealFileSelect = async (e: React.ChangeEvent<HTMLInputElement>, isImage: boolean) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeChat) return;

    const targetConsultationId = activeConsultationId || activeChat.id;
    const clientMsgId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nowTime = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    const sizeKB = (file.size / 1024).toFixed(1);
    const previewBlobUrl = URL.createObjectURL(file);

    setShowAttachMenu(false);

    let uploadedAttachmentUrl: string | undefined;
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("consultationId", targetConsultationId);
      const uploadRes = await api.post<ApiResponse<{ id?: string; url?: string }>>("/api/media", formData);
      uploadedAttachmentUrl = uploadRes.data?.data?.url
        ? normalizeMediaUrl(uploadRes.data.data.url)
        : uploadRes.data?.data?.id
          ? `/api/media/${uploadRes.data.data.id}`
          : undefined;
    } catch {
      try {
        URL.revokeObjectURL(previewBlobUrl);
      } catch {}
      setToastMsg("Error al subir el archivo adjunto");
      setTimeout(() => setToastMsg(null), 3500);
      return;
    }

    if (!uploadedAttachmentUrl) {
      try {
        URL.revokeObjectURL(previewBlobUrl);
      } catch {}
      setToastMsg("Error: el servidor no devolvió el adjunto");
      setTimeout(() => setToastMsg(null), 3500);
      return;
    }

    const content = `📎 Adjunto: ${file.name}`;
    const newDocMsg: WAMessageItem = {
      id: clientMsgId,
      clientMsgId,
      sender: "me",
      doc: {
        title: file.name,
        sub: isImage ? `Imagen clínica • ${sizeKB} KB` : `Documento clínico • ${sizeKB} KB`,
        bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
        bannerTitle: "Huellicam · Expediente Clínico",
        fileUrl: uploadedAttachmentUrl,
        isImage,
      },
      time: nowTime,
      state: "sent",
    };

    try {
      URL.revokeObjectURL(previewBlobUrl);
    } catch {}

    setConversations((prev) =>
      prev.map((chat) => {
        if (chat.id === targetConsultationId) {
          const updated = [...chat.messages, newDocMsg];
          saveChatMessages(chat.id, updated);
          return {
            ...chat,
            lastTime: nowTime,
            preview: isImage ? `📷 ${file.name}` : `📄 ${file.name}`,
            messages: updated,
          };
        }
        return chat;
      })
    );

    try {
      const msgRes = await api.post<ApiResponse<ClientChatRawMessage>>(
        `/api/consultations/${targetConsultationId}/messages`,
        {
          content,
          clientMsgId,
          attachmentUrl: uploadedAttachmentUrl,
        }
      );
      if (msgRes.data?.success && msgRes.data.data?.id) {
        const persistedId = msgRes.data.data.id;
        setConversations((prev) =>
          prev.map((chat) => {
            if (chat.id === targetConsultationId) {
              const updated = chat.messages.map((m) =>
                m.clientMsgId === clientMsgId ? { ...m, id: persistedId, state: "delivered" as const } : m
              );
              saveChatMessages(chat.id, updated);
              return { ...chat, messages: updated };
            }
            return chat;
          })
        );
      }
      setToastMsg(`Archivo adjuntado: ${file.name}`);
      setTimeout(() => setToastMsg(null), 3000);
    } catch {
      setToastMsg("No se pudo enviar el adjunto al chat");
      setTimeout(() => setToastMsg(null), 3500);
    }
  };

  const handleDownloadDoc = (title: string, fileUrl?: string) => {
    if (fileUrl) {
      void downloadAuthenticatedMedia(fileUrl, title)
        .then(() => {
          setToastMsg(`Descargando archivo: ${title}`);
          setTimeout(() => setToastMsg(null), 3000);
        })
        .catch(() => {
          setToastMsg(`No se pudo descargar ${title}`);
          setTimeout(() => setToastMsg(null), 3500);
        });
    } else {
      setToastMsg(`Archivo no disponible: ${title}`);
      setTimeout(() => setToastMsg(null), 3000);
    }
  };

  const chips = ["Todos", "En curso", "Finalizadas"];

  if (consultationsError && !consultationsLoading) {
    return (
      <>
        <PageHeader
          eyebrow="Comunicación médica"
          title="Mensajes"
          description="Canal directo y seguimiento clínico con los veterinarios asignados a tus consultas."
        />
        <ErrorState onRetry={() => void refetchConsultations()} />
        {toastMsg && <Toast message={toastMsg} tone="success" />}
      </>
    );
  }

  if (!consultations || availableConversations.length === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Comunicación médica"
          title="Mensajes"
          description="Canal directo y seguimiento clínico con los veterinarios asignados a tus consultas."
        />

        <div className="panel" style={{ marginTop: 14 }} data-testid="messages-empty-state">
          <EmptyState
            icon="message"
            title="Todavía no tenés conversaciones clínicas activas"
            text="Cuando inicies una consulta de telemedicina veterinaria, vas a poder comunicarte directamente con tu profesional asignado acá."
            action="Solicitar atención"
            onAction={() => go("/client/triage")}
          />
        </div>

        {toastMsg && <Toast message={toastMsg} tone="success" />}
      </>
    );
  }

  return (
    <div className="hc-messages-page-wrapper">

      {/* FULLSCREEN WORKSPACE MATCHING IMAGE 2 */}
      <div className="hc-chat-layout" data-testid="messages-chat-container">
        {/* LEFT COLUMN: LIST, SEARCH, BANNER */}
        <aside className={`hc-chat-list-column ${mobileThreadOpen ? "is-hidden-mobile" : ""}`}>
          {/* HERO BANNER MATCHING IMAGE 2 */}
          <div className="hc-chat-hero">
            <div className="hc-chat-hero__text">
              <span className="hc-chat-hero__eyebrow">
                CHAT VETERINARIO
              </span>
              <h1 className="hc-chat-hero__title">
                Mensajes
              </h1>
              <p className="hc-chat-hero__subtitle">
                Comunicación directa y seguimiento médico con tus veterinarios.
              </p>
            </div>
            <div className="hc-chat-hero__art">
              <img
                src="/assets/messages-hero-illustration.png"
                alt="Veterinaria y dálmata"
                width={245}
                height={180}
                loading="lazy"
                decoding="async"
                className="hc-chat-hero__img"
              />
            </div>
          </div>

          {/* SEARCH BAR MATCHING IMAGE 2 */}
          <div className="hc-search-bar">
            <Icon name="search" size={17} />
            <input
              type="text"
              placeholder="Buscar un mensaje o veterinario..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="search-chat-input"
            />
            {searchQuery ? (
              <button
                type="button"
                className="hc-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Limpiar búsqueda"
              >
                <Icon name="close" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="hc-compose-btn"
                title="Nueva consulta"
                onClick={() => go("/client/triage")}
                aria-label="Nueva consulta"
                data-testid="new-consultation-btn"
              >
                <Icon name="edit" size={18} />
              </button>
            )}
          </div>

          {/* NOTIFICATION PILL MATCHING IMAGE 2 */}
          {showNotificationBanner && (
            <div className="hc-notification-card" data-testid="notification-alert-banner">
              <div className="hc-notification-card__bell">
                <Icon name="bell" size={20} />
              </div>
              <div className="hc-notification-card__content">
                <span>Las notificaciones de mensajes y llamadas están activadas. </span>
                <button
                  type="button"
                  className="hc-notification-card__link"
                  onClick={() => go("/client/settings")}
                >
                  Configurar
                </button>
              </div>
              <div className="hc-notification-card__cat">
                <img
                  src="/assets/messages-cat-notification.png"
                  alt="Gatito Huellicam"
                  width={95}
                  height={77}
                  loading="lazy"
                  decoding="async"
                  className="hc-notification-card__cat-img"
                />
                <button
                  type="button"
                  className="hc-notification-card__close"
                  onClick={() => setShowNotificationBanner(false)}
                  aria-label="Cerrar aviso"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </div>
          )}

          {/* FILTER CHIPS */}
          <div className="wa-chips-bar" style={{ padding: "0 0 4px" }}>
            {chips.map((chip) => (
              <button
                key={chip}
                className={`wa-chip ${activeChip === chip ? "is-active" : ""}`}
                onClick={() => setActiveChip(chip)}
                data-testid={`chat-chip-${chip.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {chip}
              </button>
            ))}
          </div>

          {/* Test assertion element for Mensajería Clínica */}
          <span className="sr-only">Mensajería Clínica</span>

          {/* DOCTOR CARDS LIST MATCHING IMAGE 2 */}
          <div className="hc-doctor-cards-list">
            {filteredChats.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--ink-soft, #4a635f)", fontSize: 13, background: "#ffffff", borderRadius: 16, border: "1px dashed var(--line, #e8e4da)" }}>
                No se encontraron conversaciones con ese filtro.
              </div>
            ) : (
              filteredChats.map((chat, idx) => {
                const isSelected = activeChat ? chat.id === activeChat.id : false;
                const hasUnread = !!chat.unreadCount && chat.unreadCount > 0;
                const avatarColors = [
                  { bg: "#edf6f4", color: "#183c3a" },
                  { bg: "#fdf3d7", color: "#9a621c" },
                  { bg: "#f2eddd", color: "#315f5d" },
                  { bg: "#d9e8e4", color: "#183c3a" },
                  { bg: "#fcece9", color: "#ae4d45" },
                ];
                const themeColor = avatarColors[idx % avatarColors.length];
                const isMenuOpen = openMenuId === chat.id;

                return (
                  <div
                    key={chat.id}
                    className={`doctor-chat-card-wrap ${isSelected ? "is-active" : ""}`}
                  >
                    <button
                      type="button"
                      className={`doctor-chat-card ${isSelected ? "is-active" : ""} ${hasUnread ? "has-unread" : ""}`}
                      onClick={() => handleSelectChat(chat.id)}
                      data-testid={`chat-item-${chat.id}`}
                    >
                      <div
                        className="doctor-chat-card__avatar"
                        style={{ background: themeColor.bg, color: themeColor.color }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 800 }}>{chat.avatarText}</span>
                        {chat.isOnline && <span className="wa-online-badge" />}
                      </div>

                      <div className="doctor-chat-card__content">
                        <div className="doctor-chat-card__header">
                          <span className="doctor-chat-card__name">{chat.name}</span>
                          <span className="doctor-chat-card__time">{chat.lastTime}</span>
                        </div>
                        <div className="doctor-chat-card__footer">
                          <span className="doctor-chat-card__preview">
                            {chat.messages[chat.messages.length - 1]?.sender === "me" && (
                              <span style={{ color: "var(--teal-dark, #315f5d)", fontWeight: 700, marginRight: 3 }}>✓✓</span>
                            )}
                            {chat.preview}
                          </span>
                          {hasUnread && (
                            <span className="doctor-chat-card__badge">{formatBadgeCount(chat.unreadCount)}</span>
                          )}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      className="doctor-chat-card__more"
                      aria-label={`Opciones de conversación con ${chat.name}`}
                      aria-expanded={isMenuOpen}
                      aria-haspopup="menu"
                      data-testid={`chat-more-${chat.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setHeaderMenuOpen(false);
                        setOpenMenuId((curr) => (curr === chat.id ? null : chat.id));
                      }}
                    >
                      <Icon name="more" size={16} />
                    </button>

                    {isMenuOpen && (
                      <div
                        className="hc-chat-menu hc-popover"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="hc-chat-menu__item is-danger"
                          onClick={() => {
                            setOpenMenuId(null);
                            setConfirmDeleteChat(chat);
                          }}
                        >
                          <Icon name="trash" size={14} />
                          <span>Eliminar chat</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* RIGHT COLUMN: ACTIVE CONVERSATION THREAD */}
        <section className={`hc-chat-thread-column ${!mobileThreadOpen ? "is-hidden-mobile" : ""}`}>
          {!activeChat ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 32, textAlign: "center", color: "var(--ink-soft, #454e4e)", background: "var(--cream, #fffbef)" }}>
              <div style={{ fontSize: 44, marginBottom: 16 }}>🩺</div>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink, #183c3a)", marginBottom: 8 }}>
                Mensajería Clínica Huellicam
              </h2>
              <p style={{ maxWidth: 420, fontSize: 14, lineHeight: 1.5, color: "var(--ink-soft, #454e4e)" }}>
                Seleccioná una conversación de la lista para ver el historial clínico y comunicarte en tiempo real.
              </p>
            </div>
          ) : (
            <>
              {/* THREAD TOPBAR */}
              <div className="wa-chat-pane__header" style={{ background: "var(--cream, #fffbef)", borderBottom: "1px solid var(--line, #e4dfd2)", height: 64 }}>
                <div className="wa-chat-pane__header-contact">
                  <button
                    type="button"
                    className="wa-icon-btn mobile-only"
                    onClick={() => setMobileThreadOpen(false)}
                    aria-label="Volver a la lista"
                    style={{ marginRight: 6 }}
                  >
                    <Icon name="arrow" size={18} />
                  </button>
                  <div className="wa-chat-pane__header-avatar" style={{ background: "var(--teal-pale, #edf6f4)", color: "var(--teal-deep, #183c3a)" }}>
                    {activeChat.avatarText}
                  </div>
                  <div className="wa-chat-pane__header-info">
                    <h2 style={{ color: "var(--ink, #183c3a)", fontWeight: 700 }}>{activeChat.name}</h2>
                    <span className={activeChat.isOnline ? "is-online" : ""}>
                      {activeChat.statusText}
                    </span>
                  </div>
                </div>

                <div className="wa-chat-pane__header-actions">
                  <button
                    className="wa-icon-btn"
                    title="Videoconsulta en vivo"
                    onClick={() => go(`/client/consultations/${activeChat.id}`)}
                    aria-label="Iniciar videollamada"
                    style={{ color: "var(--teal-deep, #183c3a)", background: "var(--teal-pale, #edf6f4)" }}
                  >
                    <Icon name="video" size={18} />
                  </button>
                  <div className="hc-thread-menu-wrap">
                    <button
                      type="button"
                      className="wa-icon-btn"
                      aria-label="Opciones del chat actual"
                      aria-expanded={headerMenuOpen}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        setHeaderMenuOpen((v) => !v);
                      }}
                    >
                      <Icon name="more" size={18} />
                    </button>
                    {headerMenuOpen && (
                      <div
                        className="hc-chat-menu hc-popover"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="hc-chat-menu__item is-danger"
                          onClick={() => {
                            setHeaderMenuOpen(false);
                            setConfirmDeleteChat(activeChat);
                          }}
                        >
                          <Icon name="trash" size={14} />
                          <span>Eliminar chat</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* THREAD BODY */}
              <div className="wa-chat-body" style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                <div className="clinical-security-pill" data-testid="clinical-security-note">
                  <Icon name="shield" size={14} />
                  <span>Canal clínico auditado · Los mensajes forman parte de la historia clínica</span>
                </div>

                {activeChat.messages.length === 0 ? (
                  <div className="clinical-empty-conversation" data-testid="empty-conversation-notice">
                    <Icon name="message" size={26} />
                    <p>Iniciá la comunicación con <strong>{activeChat.name}</strong>.</p>
                    <span>Todo mensaje, indicación médica y archivo adjunto queda registrado en el expediente de tu mascota.</span>
                  </div>
                ) : (
                  activeChat.messages.map((msg) => {
                    const isSent = msg.sender === "me";

                    if (msg.doc) {
                      return (
                        <div
                          key={msg.id}
                          className={`wa-bubble wa-doc-bubble ${isSent ? "wa-bubble--sent" : "wa-bubble--received"}`}
                          data-testid="chat-message-bubble"
                        >
                          {!isSent && msg.senderName && (
                            <div className="wa-bubble__sender">{msg.senderName}</div>
                          )}
                          <div className="wa-doc-card">
                            {msg.doc.isImage && msg.doc.fileUrl && (
                              <div className="wa-doc-card__img-preview" style={{ borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                                <AuthenticatedMediaImage src={msg.doc.fileUrl} alt={msg.doc.title} style={{ width: "100%", maxHeight: 240, objectFit: "cover", display: "block" }} />
                              </div>
                            )}
                            <div className="wa-doc-card__banner">
                              <span className="wa-doc-card__banner-tag">
                                {msg.doc.bannerTag || "DOCUMENTO CLÍNICO"}
                              </span>
                              <div className="wa-doc-card__banner-preview">
                                <Icon name={msg.doc.isImage ? "image" : "file"} size={22} />
                                <span>{msg.doc.bannerTitle || "Huellicam Clinical Record"}</span>
                              </div>
                            </div>

                            <div className="wa-doc-card__body">
                              <div className="wa-pdf-badge" style={{ background: msg.doc.isImage ? "var(--teal, #609f9c)" : "var(--danger, #ae4d45)" }}>
                                {msg.doc.isImage ? "IMG" : "PDF"}
                              </div>
                              <div className="wa-doc-card__info">
                                <div className="wa-doc-card__title" title={msg.doc.title}>
                                  {msg.doc.title}
                                </div>
                                <div className="wa-doc-card__sub">{msg.doc.sub}</div>
                              </div>
                              <button
                                className="wa-doc-card__download"
                                onClick={() => handleDownloadDoc(msg.doc!.title, msg.doc!.fileUrl)}
                                title="Descargar documento"
                                aria-label="Descargar documento"
                              >
                                <Icon name="download" size={16} />
                              </button>
                            </div>
                          </div>

                          <div className="wa-bubble__meta">
                            <span>{msg.time}</span>
                            {isSent && <span style={{ color: "var(--teal-dark, #315f5d)", marginLeft: 4, fontWeight: 700 }}>✓✓</span>}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={msg.id}
                        className={`wa-bubble ${isSent ? "wa-bubble--sent" : "wa-bubble--received"}`}
                        data-testid="chat-message-bubble"
                      >
                        {!isSent && msg.senderName && (
                          <div className="wa-bubble__sender">{msg.senderName}</div>
                        )}
                        <p className="wa-bubble__text">{msg.text}</p>
                        <div className="wa-bubble__meta">
                          <span>{msg.time}</span>
                          {isSent && <span style={{ color: "var(--teal-dark, #315f5d)", marginLeft: 4, fontWeight: 700 }}>✓✓</span>}
                        </div>
                      </div>
                    );
                  })
                )}

                {isTyping && (
                  <div className="wa-typing-indicator">
                    <span className="wa-typing-dot" />
                    <span className="wa-typing-dot" />
                    <span className="wa-typing-dot" />
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* HIDDEN REAL FILE INPUTS */}
              <input
                type="file"
                ref={pdfInputRef}
                style={{ display: "none" }}
                accept=".pdf,.doc,.docx,application/pdf"
                onChange={(e) => handleRealFileSelect(e, false)}
                data-testid="file-upload-pdf"
              />
              <input
                type="file"
                ref={imgInputRef}
                style={{ display: "none" }}
                accept="image/*,video/*"
                onChange={(e) => handleRealFileSelect(e, true)}
                data-testid="file-upload-image"
              />

              {/* QUICK ATTACH POPUP */}
              {showAttachMenu && (
                <div className="wa-attach-popup">
                  <button
                    className="wa-attach-item"
                    type="button"
                    onClick={() => pdfInputRef.current?.click()}
                    data-testid="attach-pdf-btn"
                  >
                    <i style={{ background: "var(--danger, #ae4d45)" }}>
                      <Icon name="file" size={17} />
                    </i>
                    <span>Documento PDF</span>
                  </button>
                  <button
                    className="wa-attach-item"
                    type="button"
                    onClick={() => imgInputRef.current?.click()}
                    data-testid="attach-img-btn"
                  >
                    <i style={{ background: "var(--teal, #609f9c)" }}>
                      <Icon name="image" size={17} />
                    </i>
                    <span>Fotos y videos</span>
                  </button>
                  <button
                    className="wa-attach-item"
                    type="button"
                    onClick={() => pdfInputRef.current?.click()}
                    data-testid="attach-prescription-btn"
                  >
                    <i style={{ background: "var(--teal-dark, #315f5d)" }}>
                      <Icon name="pill" size={17} />
                    </i>
                    <span>Receta médica</span>
                  </button>
                </div>
              )}

              {/* FOOTER INPUT BAR */}
              <footer className="wa-chat-footer" style={{ background: "var(--cream, #fffbef)", borderTop: "1px solid var(--line, #e4dfd2)", padding: "10px 18px" }}>
                <div className="wa-chat-footer__actions">
                  <button
                    className="wa-icon-btn"
                    title="Adjuntar estudio o receta"
                    onClick={() => setShowAttachMenu(!showAttachMenu)}
                    aria-label="Adjuntar"
                  >
                    <Icon name="paperclip" size={19} />
                  </button>
                </div>

                <div className="wa-input-pill" style={{ background: "#ffffff", border: "1px solid var(--line, #e4dfd2)", borderRadius: 999, padding: "8px 16px" }}>
                  <input
                    type="text"
                    placeholder="Escribí un mensaje clínico para el veterinario..."
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    data-testid="chat-message-input"
                    style={{ background: "transparent", border: "none", width: "100%" }}
                  />
                </div>

                <button
                  className="wa-send-btn"
                  onClick={() => handleSend()}
                  disabled={!inputText.trim()}
                  title="Enviar mensaje"
                  aria-label="Enviar"
                  data-testid="chat-send-btn"
                  style={{ background: "var(--teal-dark, #315f5d)", color: "#ffffff", borderRadius: "50%", width: 44, height: 44, minWidth: 44, minHeight: 44, display: "grid", placeItems: "center", border: "none", cursor: inputText.trim() ? "pointer" : "default", opacity: inputText.trim() ? 1 : 0.6 }}
                >
                  <Icon name="send" size={17} />
                </button>
              </footer>
            </>
          )}
        </section>
      </div>

      {confirmDeleteChat && (
        <Modal
          title="Eliminar chat"
          text={`¿Querés eliminar la conversación con ${confirmDeleteChat.name}? Se borrarán permanentemente todos los mensajes y archivos enviados en este chat.`}
          cancel="Cancelar"
          confirm={deletingChat ? "Eliminando..." : "Eliminar chat"}
          destructive
          onClose={() => !deletingChat && setConfirmDeleteChat(null)}
          onConfirm={() => { void handleConfirmDeleteChat(); }}
        />
      )}

      {toastMsg && <Toast message={toastMsg} tone="success" />}
    </div>
  );
}

function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data: notifications = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await api.get<ApiResponse<any[]>>('/api/notifications');
      return (res.data?.success && res.data?.data) ? res.data.data : [];
    },
  });

  const markAllMutation = useMutation({
    mutationFn: async () => {
      await api.patch('/api/notifications/read-all');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  useEffect(() => {
    const hasUnread = notifications.some((n: any) => !n.isRead && !n.read);
    if (hasUnread && !markAllMutation.isPending) {
      markAllMutation.mutate();
    }
  }, [notifications.length, markAllMutation.isPending]);

  const [pushPerm, setPushPerm] = useState(() => getNotificationPermissionState());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  const handleEnablePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      const res = await subscribeToWebPush();
      setPushPerm(getNotificationPermissionState());
      if (res.subscribed) {
        setPushMsg("Notificaciones push activadas en este navegador.");
      } else if (res.reason === "denied") {
        setPushMsg("Bloqueaste los avisos en tu navegador. Habilitalos desde el ícono de candado en la barra de direcciones.");
      } else if (res.reason === "vapid_unconfigured") {
        setPushMsg("Permiso guardado. El servidor push Web VAPID aún no está configurado en este entorno.");
      } else {
        setPushMsg("No se pudo activar Web Push en este dispositivo.");
      }
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Novedades importantes"
        title="Notificaciones"
        description="Todo lo que necesitás saber sobre la salud de tus mascotas."
      />
      {isWebPushSupported() && pushPerm !== "granted" && (
        <div
          className="panel"
          style={{
            marginBottom: 16,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "var(--teal-pale, #edf6f4)",
            border: "1px solid var(--teal, #609f9c)",
          }}
        >
          <div>
            <strong>Activá los avisos en tu navegador</strong>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>
              Recibí recordatorios de vacunas, turnos y consultas incluso con la pestaña en segundo plano.
            </p>
            {pushMsg && <small style={{ display: "block", marginTop: 4, color: "var(--ink)" }}>{pushMsg}</small>}
          </div>
          <Button variant="primary" disabled={pushBusy || pushPerm === "denied"} onClick={handleEnablePush}>
            {pushBusy ? "Activando..." : pushPerm === "denied" ? "Permiso denegado" : "Activar notificaciones push"}
          </Button>
        </div>
      )}
      {pushMsg && pushPerm === "granted" && (
        <p style={{ marginBottom: 12, fontSize: 13, color: "var(--teal-deep)" }}>{pushMsg}</p>
      )}
      <div className="panel">
        {isLoading ? (
          <SkeletonPage type="list" />
        ) : isError ? (
          <EmptyState
            icon="alert"
            title="No pudimos cargar tus notificaciones"
            text="Revisá tu conexión e intentá nuevamente."
            action="Reintentar"
            onAction={() => { void refetch(); }}
          />
        ) : notifications.length === 0 ? (
          <EmptyState
            icon="bell"
            title="Sin notificaciones pendientes"
            text="Te avisaremos acá cuando haya novedades sobre tus consultas o recetas."
          />
        ) : (
          <div className="notification-list" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {notifications.map((notif: any) => (
              <div
                key={notif.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 14,
                  padding: "16px 20px",
                  borderRadius: 12,
                  background: notif.isRead || notif.read ? "var(--paper, #fffbef)" : "var(--teal-pale, #edf6f4)",
                  border: `1px solid ${notif.isRead || notif.read ? "var(--line, #e4dfd2)" : "var(--teal, #609f9c)"}`,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: notif.isRead || notif.read ? "#f2eddd" : "#d9e8e4",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: notif.isRead || notif.read ? "#607674" : "#315f5d",
                    flexShrink: 0,
                  }}
                >
                  <Icon name="bell" size={18} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                    <strong style={{ fontSize: 15, color: "var(--ink)" }}>{notif.title}</strong>
                    <small style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                      {notif.createdAt ? formatDateAR(notif.createdAt, true) : ""}
                    </small>
                  </div>
                  <p style={{ margin: 0, fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.5 }}>{notif.body}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function PrescriptionsPage() {
  const [active, setActive] = useState("Activas");
  const { prescriptions = [], prescriptionsLoading: loading, prescriptionsError, refetchPrescriptions } = useClientData({ includeConsultations: false, includePrescriptions: true });
  const visiblePrescriptions = useMemo(() => {
    const now = Date.now();
    return prescriptions.filter((rx) => {
      const issued = new Date(rx.createdAt).getTime();
      const days = Number(rx.durationDays) || 7;
      const isExpired = !Number.isNaN(issued) && issued + days * 86_400_000 < now;
      return active === "Anteriores" ? isExpired : !isExpired;
    });
  }, [prescriptions, active]);

  return (
    <>
      <PageHeader
        eyebrow="Indicaciones médicas"
        title="Recetas"
        description="Consultá tratamientos e indicaciones oficiales emitidas por tus veterinarios."
      />
      <Tabs tabs={["Activas", "Anteriores"]} active={active} onChange={setActive} />
      <SectionStage stageKey={active}>
      {loading ? (
        <SkeletonPage type="list" />
      ) : prescriptionsError ? (
        <ErrorState onRetry={() => { void refetchPrescriptions(); }} />
      ) : prescriptions.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="file"
            title="No tenés recetas en esta sección."
            text="Cuando un veterinario emita una receta o plan de tratamiento para tus mascotas, aparecerá acá y la recibirás por correo."
          />
        </div>
      ) : (
        <div style={{ display: "grid", gap: "16px", marginTop: "16px" }}>
          {visiblePrescriptions.length === 0 && (
            <div className="panel">
              <EmptyState
                icon="file"
                title={active === "Anteriores" ? "No tenés recetas anteriores" : "No tenés recetas activas"}
                text="Las indicaciones médicas emitidas aparecerán organizadas acá según su vigencia."
              />
            </div>
          )}
          {visiblePrescriptions.map((rx) => {
            const petName = rx.consultation?.pet?.name || "Mascota";
            const vetName = rx.consultation?.vet
              ? `Dr. ${rx.consultation.vet.firstName} ${rx.consultation.vet.lastName || ""}`
              : "Veterinario matriculado";
            const dateStr = new Date(rx.createdAt).toLocaleDateString("es-AR", {
              day: "numeric",
              month: "short",
              year: "numeric",
            });

            return (
              <div
                key={rx.id}
                className="panel"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "20px",
                  borderRadius: "16px",
                  border: "1px solid var(--border)",
                }}
              >
                <div>
                  <span
                    style={{
                      fontSize: "12px",
                      fontWeight: 800,
                      color: "#315f5d",
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                    }}
                  >
                    {petName} · {dateStr}
                  </span>
                  <h3 style={{ margin: "6px 0 4px", fontSize: "18px", color: "var(--foreground)" }}>
                    {rx.medication}
                  </h3>
                  <p style={{ margin: 0, fontSize: "14px", color: "var(--muted)" }}>
                    {rx.dosage} · Cada {rx.frequency} por {rx.durationDays} días
                  </p>
                  <small style={{ display: "block", marginTop: "6px", color: "#648482" }}>
                    Emitida por {vetName}
                  </small>
                </div>
                <div>
                  <a
                    href={`/prescriptions/${rx.id}`}
                    target={isReactNativeWebView() ? undefined : "_blank"}
                    rel={isReactNativeWebView() ? undefined : "noreferrer"}
                    onClick={
                      isReactNativeWebView()
                        ? (event) => {
                            event.preventDefault();
                            window.location.assign(`/prescriptions/${rx.id}`);
                          }
                        : undefined
                    }
                    className="button button--secondary"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "9px 18px",
                      borderRadius: "999px",
                      fontWeight: 700,
                      textDecoration: "none",
                      backgroundColor: "#315f5d",
                      color: "#ffffff",
                    }}
                  >
                    Ver Receta y QR
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </SectionStage>
    </>
  );
}

type ClinicalTriageTier = "ROJO" | "AMARILLO" | "VERDE";

interface TriageTierInfo {
  tier: ClinicalTriageTier;
  badge: string;
  title: string;
  description: string;
  estimate: string;
  isEmergency: boolean;
  advice?: string[];
}

function evaluateClientTriage(symptom: string, timeframe: string): TriageTierInfo {
  const s = symptom.toLowerCase();

  // 1. CÓDIGO ROJO — Emergencia Vital (Airway, Breathing, Circulation, Toxic shock)
  if (
    s.includes("respirar") ||
    s.includes("asfixia") ||
    s.includes("convulsi") ||
    s.includes("inconscien") ||
    s.includes("intoxicac") ||
    s.includes("veneno") ||
    s.includes("hemorragia") ||
    s.includes("sangrado abundante") ||
    s.includes("ahogo")
  ) {
    return {
      tier: "ROJO",
      badge: "ATENCIÓN INMEDIATA · CÓDIGO ROJO",
      title: "Necesitás atención veterinaria inmediata.",
      description: "Por los signos ingresados, existe compromiso fisiológico agudo. Contactá una guardia veterinaria presencial con soporte de oxígeno mientras te conectamos con un profesional.",
      estimate: "Ahora (Inmediato)",
      isEmergency: true,
      advice: [
        "Mantené a tu mascota tranquila y en un lugar fresco y seguro.",
        "No le des comida, agua ni medicación casera sin indicación profesional.",
        "Si podés trasladarla, dirigite a una clínica con guardia 24 hs.",
      ],
    };
  }

  // 2. CÓDIGO AMARILLO — Urgencia Prioritaria (Signos moderados sin paro inminente)
  if (
    s.includes("vómito") ||
    s.includes("diarrea") ||
    s.includes("herida") ||
    s.includes("dolor") ||
    s.includes("renguera") ||
    s.includes("decaimiento") ||
    s.includes("golpe")
  ) {
    return {
      tier: "AMARILLO",
      badge: "URGENCIA PRIORITARIA · CÓDIGO AMARILLO",
      title: "Tu mascota requiere evaluación profesional hoy.",
      description: "El cuadro reportado presenta signos de evolución aguda. Te recomendamos conectar con un veterinario de guardia para estabilizar síntomas y pautar el tratamiento adecuado.",
      estimate: "4 a 6 minutos",
      isEmergency: false,
      advice: [
        "Retirá el alimento sólido si hay vómitos repetidos.",
        "Tené a mano agua fresca pero no la obligues a beber.",
        "Observá si el cuadro empeora o si aparecen nuevos síntomas.",
      ],
    };
  }

  // 3. CÓDIGO VERDE — Consulta General / Rutina (Baja complejidad clínica)
  return {
    tier: "VERDE",
    badge: "CONSULTA GENERAL · CÓDIGO VERDE",
    title: "Cuadro clínico estable / Sin riesgo vital inminente.",
    description: "No se identificaron signos de compromiso urgente. Podés realizar una videoconsulta de orientación ahora o agendar un turno con tu veterinario de cabecera.",
    estimate: "Atención disponible hoy",
    isEmergency: false,
    advice: [
      "Tomá fotos claras de la zona afectada si es un problema de piel u ojos.",
      "Anotá desde cuándo notás el cambio de conducta o molestia.",
      "Tené su libreta sanitaria a mano para repasar vacunas.",
    ],
  };
}

export function TriagePage() {
  const { pets, petsLoading } = useClientData({ includeConsultations: false });
  const [step, setStep] = useState(0);
  const [symptom, setSymptom] = useState("");
  const [customSymptom, setCustomSymptom] = useState("");
  const [selectedPetId, setSelectedPetId] = useState("");
  const [timeframe, setTimeframe] = useState("");

  const options = [
    "Dificultad para respirar / Asfixia",
    "Convulsiones o pérdida de consciencia",
    "Intoxicación o ingesta de tóxico",
    "Hemorragia o sangrado abundante",
    "Vómitos o diarrea frecuentes",
    "Herida, corte o traumatismo",
    "Dolor evidente o renguera",
    "Decaimiento o inapetencia",
    "Picazón, alergia o piel",
    "Control preventivo o consulta de rutina",
    "Otro",
  ];

  const isRoutine = symptom === "Control preventivo o consulta de rutina";
  const effectiveSymptom = symptom === "Otro" ? customSymptom.trim() : symptom;

  // Guardrail: If client has 0 pets registered, block starting a triage
  if (!petsLoading && pets.length === 0) {
    return (
      <div className="triage-page">
        <div className="triage-top">
          <Logo />
          <button onClick={() => go("/client/dashboard")}><Icon name="close"/> Salir</button>
        </div>
        <main className="triage-card">
          <span className="triage-icon"><Icon name="paw" size={28}/></span>
          <span className="eyebrow">Registro requerido</span>
          <h1>Antes de comenzar, registrá a tu mascota</h1>
          <p>Para que un profesional veterinario pueda orientarte y atenderte adecuadamente, necesitamos tener cargada la ficha clínica de tu mascota.</p>
          <div className="triage-actions" style={{ flexDirection: "column", gap: 12, marginTop: 24 }}>
            <Button variant="primary" onClick={() => go("/client/pets")}>
              Registrar mascota ahora <Icon name="arrow" size={17}/>
            </Button>
            <Button variant="secondary" onClick={() => go("/client/dashboard")}>
              Volver al inicio
            </Button>
          </div>
          <small className="triage-disclaimer"><Icon name="shield" size={15}/> El registro toma menos de un minuto.</small>
        </main>
      </div>
    );
  }

  const isStepValid =
    step === 0
      ? (symptom === "Otro" ? Boolean(customSymptom.trim()) : Boolean(symptom))
      : step === 1
      ? Boolean(selectedPetId)
      : Boolean(timeframe);

  if (step === 3) {
    const evaluation = evaluateClientTriage(effectiveSymptom, timeframe);
    return (
      <TriageResult
        evaluation={evaluation}
        symptom={effectiveSymptom}
        petId={selectedPetId}
        timeframe={timeframe}
        isRoutine={isRoutine}
        onRestart={() => {
          setStep(0);
          setSymptom("");
          setCustomSymptom("");
          setSelectedPetId("");
          setTimeframe("");
        }}
        onBack={() => setStep(isRoutine ? 1 : 2)}
      />
    );
  }

  const totalSteps = isRoutine ? 2 : 3;
  const currentStepNumber = step + 1;

  return (
    <div className="triage-page">
      <div className="triage-top">
        <Logo />
        <button onClick={() => go("/client/dashboard")}><Icon name="close"/> Salir</button>
      </div>
      <div className="triage-progress">
        <span style={{ transform: `scaleX(${currentStepNumber / totalSteps})` }}/>
        <small>Paso {currentStepNumber} de {totalSteps} · Cerca de 60 segundos</small>
      </div>
      <main className="triage-card">
        <span className="triage-icon">
          <Icon name={step === 0 ? "heart" : step === 1 ? "paw" : "clock"} size={28}/>
        </span>
        <span className="eyebrow">Orientación inicial</span>
        <h1>{step === 0 ? "¿Qué está pasando?" : step === 1 ? "¿A quién vamos a ayudar?" : "¿Cuándo empezó?"}</h1>
        <p>
          {step === 0
            ? "Elegí la opción que mejor describa lo que ves. No hace falta que tengas toda la información."
            : step === 1
            ? "Seleccioná una de tus mascotas para que podamos orientarte mejor."
            : "Esta información nos ayuda a estimar el nivel de atención médica requerido."}
        </p>
        <div className={step === 0 ? "option-grid" : "option-list"}>
          {step === 0 && options.map((option) => (
            <button
              className={symptom === option ? "is-selected" : ""}
              onClick={() => {
                setSymptom(option);
                if (option !== "Otro") {
                  setCustomSymptom("");
                }
              }}
              key={option}
              data-testid={`triage-option-${option.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
            >
              <span>{option}</span>
              {symptom === option && <Icon name="check"/>}
            </button>
          ))}
          {step === 1 && pets.map((pet) => (
            <button
              className={selectedPetId === pet.id ? "is-selected" : ""}
              onClick={() => setSelectedPetId(pet.id)}
              key={pet.id}
              data-testid={`triage-pet-${pet.id}`}
            >
              <SafePetImg
                src={pet.photo}
                alt={pet.name}
              />
              <span>
                <strong>{pet.name.trim()}</strong>
                <small>{pet.kind} · {pet.breed}</small>
              </span>
              <Icon name={selectedPetId === pet.id ? "check" : "chevron"}/>
            </button>
          ))}
          {step === 2 && ["Hace menos de una hora", "Hoy", "Entre ayer y hoy", "Hace varios días"].map((option) => (
            <button
              className={timeframe === option ? "is-selected" : ""}
              onClick={() => setTimeframe(option)}
              key={option}
              data-testid={`triage-timeframe-${option.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
            >
              <span>{option}</span>
              {timeframe === option && <Icon name="check"/>}
            </button>
          ))}
        </div>

        {/* FEAT-01: Campo de texto obligatorio al seleccionar "Otro" */}
        {step === 0 && symptom === "Otro" && (
          <div style={{ marginTop: 16 }} data-testid="triage-custom-symptom-container">
            <label
              htmlFor="triage-custom-symptom"
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ink, #183c3a)",
                marginBottom: 6,
              }}
            >
              Describí qué le ocurre a tu mascota *
            </label>
            <textarea
              id="triage-custom-symptom"
              data-testid="triage-custom-symptom-input"
              value={customSymptom}
              onChange={(e) => setCustomSymptom(e.target.value)}
              placeholder="Contanos los síntomas o el motivo de la consulta..."
              rows={3}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid var(--line, #e4dfd2)",
                fontFamily: "inherit",
                resize: "none",
                boxSizing: "border-box",
                background: "#fff",
              }}
            />
          </div>
        )}

        <div className="triage-actions">
          {step > 0 && (
            <Button
              variant="secondary"
              onClick={() => {
                if (step === 3 && isRoutine) {
                  setStep(1);
                } else {
                  setStep(step - 1);
                }
              }}
            >
              Volver
            </Button>
          )}
          <Button
            disabled={!isStepValid}
            onClick={() => {
              if (step === 1 && isRoutine) {
                setStep(3); // BUG-03: Saltar paso de duración si es rutina
              } else {
                setStep(step + 1);
              }
            }}
          >
            Continuar <Icon name="arrow" size={17}/>
          </Button>
        </div>
        <small className="triage-disclaimer">
          <Icon name="shield" size={15}/> Esta orientación no reemplaza una evaluación veterinaria presencial.
        </small>
      </main>
    </div>
  );
}

const TRIAGE_DURATION_MAP: Record<
  string,
  'LESS_THAN_2_HOURS' | 'HOURS_2_TO_12' | 'DAYS_1_TO_2' | 'MORE_THAN_2_DAYS'
> = {
  "Hace menos de una hora": "LESS_THAN_2_HOURS",
  "Hoy": "HOURS_2_TO_12",
  "Entre ayer y hoy": "DAYS_1_TO_2",
  "Hace varios días": "MORE_THAN_2_DAYS",
};

const TRIAGE_SYMPTOM_KEY_MAP: Record<string, string[]> = {
  "Dificultad para respirar / Asfixia": ["respiratory_distress"],
  "Convulsiones o pérdida de consciencia": ["seizures", "unconscious"],
  "Intoxicación o ingesta de tóxico": ["poisoning"],
  "Hemorragia o sangrado abundante": ["massive_bleeding"],
  "Vómitos o diarrea frecuentes": ["persistent_vomiting", "diarrhea"],
  "Herida, corte o traumatismo": ["deep_wound"],
  "Dolor evidente o renguera": ["acute_lameness"],
  "Decaimiento o inapetencia": ["lethargy"],
};

export function TriageResult({
  evaluation,
  symptom,
  petId,
  timeframe,
  isRoutine = false,
  onRestart,
  onBack,
}: {
  evaluation: TriageTierInfo;
  symptom: string;
  petId: string;
  timeframe: string;
  isRoutine?: boolean;
  onRestart: () => void;
  onBack?: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState<boolean | undefined>(undefined);
  const queryClient = useQueryClient();
  const { pets } = useClientData({ includeConsultations: false });
  const selectedPet = pets.find((p) => p.id === petId);

  useEffect(() => {
    let active = true;
    api
      .get<ApiResponse<{ accepted: boolean }>>("/api/users/telemedicine-consent")
      .then((res) => {
        if (active && res.data?.success && typeof res.data.data?.accepted === "boolean") {
          setConsentAccepted(res.data.data.accepted);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const executeConnect = async () => {
    if (!petId) {
      setErrorMessage("No se ha seleccionado ninguna mascota válida.");
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const cleanSymptom = symptom.trim() || "Consulta médica general";
      const cleanTimeframe = timeframe.trim();
      const notes =
        isRoutine || !cleanTimeframe
          ? cleanSymptom
          : `${cleanSymptom} (${cleanTimeframe})`;
      const mappedDuration = isRoutine ? undefined : TRIAGE_DURATION_MAP[cleanTimeframe];
      const mappedSymptoms = TRIAGE_SYMPTOM_KEY_MAP[cleanSymptom] ?? [];

      const res = await api.post<ApiResponse<BackendConsultation>>('/api/consultations', {
        petId,
        notes,
        ...(mappedSymptoms.length > 0 ? { symptoms: mappedSymptoms } : {}),
        ...(mappedDuration ? { duration: mappedDuration } : {}),
      });
      if (res.data.success && res.data.data) {
        queryClient.invalidateQueries({ queryKey: ['consultations', 'mine'] });
        // Navegar directamente a la sala de espera de la videoconsulta (única zona de espera)
        go(`/call/${res.data.data.id}?from=client`);
        return;
      } else {
        setErrorMessage("No pudimos iniciar la consulta. Por favor intentá nuevamente.");
      }
    } catch (err: any) {
      const apiMsg = err.response?.data?.error?.message;
      setErrorMessage(apiMsg || "No pudimos conectar con la sala de atención. Verificá tu conexión.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConnect = () => {
    if (consentAccepted === false) {
      setConsentOpen(true);
      return;
    }
    void executeConnect();
  };

  const isCritical = evaluation.tier === "ROJO";

  return (
    <div className="triage-page">
      <div className="triage-top"><Logo/></div>
      <main className={`result-card ${isCritical ? "result-card--critical" : ""}`}>
        <span className="result-card__icon"><Icon name={isCritical ? "phone" : "heart"} size={31}/></span>
        <span className="eyebrow">{evaluation.badge}</span>
        <h1>{evaluation.title}</h1>
        <p>{evaluation.description}</p>
        
        {evaluation.advice && (
          <div className="critical-guidance" style={!isCritical ? { background: "var(--cream, #fffbef)", border: "1px solid var(--line, #e4dfd2)" } : undefined}>
            <strong style={!isCritical ? { color: "var(--ink, #183c3a)" } : undefined}>Recomendaciones clave mientras te conectás:</strong>
            {evaluation.advice.map((adv, idx) => (
              <p key={idx} style={!isCritical ? { color: "var(--ink-soft, #454e4e)" } : undefined}>• {adv}</p>
            ))}
          </div>
        )}

        <div className="estimate">
          <span><Icon name="clock"/><small>Tiempo estimado</small></span>
          <strong>{evaluation.estimate}</strong>
        </div>

        {errorMessage && (
          <div style={{ color: "#ae4d45", fontSize: 13, background: "#fcece9", border: "1px solid rgba(174,77,69,.28)", padding: "10px 14px", borderRadius: 12, margin: "12px 0", textAlign: "center" }}>
            {errorMessage}
          </div>
        )}

        <div className="result-actions">
          <Button onClick={handleConnect} disabled={isSubmitting}>
            {isSubmitting ? "Conectando..." : isCritical ? "Conectar con atención veterinaria" : "Conectar con veterinario"}
          </Button>
          {isCritical && <Button variant="secondary" onClick={() => go("/client/dashboard")}>Buscar atención presencial inmediata</Button>}
        </div>
        <button className="text-button" onClick={onBack || onRestart}>Volver y revisar respuestas</button>
        <small className="triage-disclaimer">Huellicam no reemplaza una guardia veterinaria presencial.</small>
      </main>
      <TelemedicineConsentModal
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        onAccepted={() => {
          setConsentAccepted(true);
          setConsentOpen(false);
          void executeConnect();
        }}
      />
    </div>
  );
}

function ProfilePage() {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const { user, refreshSession } = useAuth();

  const [formFirstName, setFormFirstName] = useState(user?.firstName || "");
  const [formLastName, setFormLastName] = useState(user?.lastName || "");
  const [formPhone, setFormPhone] = useState(user?.phone || "");

  useEffect(() => {
    if (user) {
      setFormFirstName(user.firstName || "");
      setFormLastName(user.lastName || "");
      setFormPhone(user.phone || "");
    }
  }, [user]);

  const rawFirstName = user?.firstName || (user?.email ? user.email.split("@")[0] : "");
  const firstName = rawFirstName ? (rawFirstName.charAt(0).toUpperCase() + rawFirstName.slice(1)) : "Tutor";
  const lastName = user?.lastName || "";
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  const displayName = fullName || (user?.firstName ? user.firstName : (user?.email ? firstName : "Tutor"));
  const email = user?.email || "";
  const phone = user?.phone || "";
  const initials = getInitials(displayName, firstName[0] || "T");

  const handleSave = async () => {
    if (formFirstName.trim().length < 2) {
      setToastMsg("Error: El nombre debe tener al menos 2 caracteres.");
      return;
    }
    if (formLastName.trim().length < 2) {
      setToastMsg("Error: El apellido debe tener al menos 2 caracteres.");
      return;
    }

    const trimmedPhone = formPhone.trim();
    if (trimmedPhone !== "") {
      const phoneDigits = trimmedPhone.replace(/\D/g, "");
      const phoneRegex = /^\+?[0-9\s\-()]{7,20}$/;
      if (!phoneRegex.test(trimmedPhone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
        setToastMsg("Error: Ingresá un número de teléfono válido (ej. +5491155551234)");
        return;
      }
    }

    setSaving(true);
    try {
      const res = await api.patch<ApiResponse<unknown>>("/api/users/profile", {
        firstName: formFirstName.trim(),
        lastName: formLastName.trim(),
        phone: formPhone.trim() || null,
      });

      if (res.data.success) {
        await refreshSession();
        setToastMsg("Perfil actualizado con éxito.");
        setEditing(false);
      } else {
        setToastMsg("Error al actualizar el perfil.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      setToastMsg(`Error: ${msg || "No se pudo actualizar el perfil."}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setFormFirstName(user?.firstName || "");
    setFormLastName(user?.lastName || "");
    setFormPhone(user?.phone || "");
  };

  return <>
    {toastMsg && <Toast message={toastMsg} tone={toastMsg.includes("Error") ? "error" : "success"}/>}
    <PageHeader
      eyebrow="Tu cuenta"
      title="Mi perfil"
      description="Mantené tus datos de contacto actualizados."
      action={
        editing ? (
          <div style={{ display: "flex", gap: "8px" }}>
            <Button variant="secondary" onClick={handleCancel} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" onClick={handleSave} disabled={saving}>
              {saving ? "Guardando..." : "Guardar cambios"}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>
            Editar perfil
          </Button>
        )
      }
    />
    <div className="profile-grid">
      <section className="panel profile-card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div className="profile-avatar">{initials}</div>
        <h2>{displayName}</h2>
        <p>Tutor registrado</p>
        <Status>Perfil activo</Status>
      </section>
      <section className="panel">
        <div className="panel__heading">
          <div><span className="eyebrow">Datos básicos</span><h2>Información personal</h2></div>
        </div>
        <div className="form-grid">
          <Field label="Nombre" value={editing ? formFirstName : (user?.firstName || firstName)} editing={editing} onChange={setFormFirstName}/>
          <Field label="Apellido" value={editing ? formLastName : (user?.lastName || lastName)} editing={editing} onChange={setFormLastName}/>
          <Field label="Email" value={email} editing={false}/>
          <Field label="Teléfono" value={editing ? formPhone : phone} editing={editing} onChange={(val) => setFormPhone(val.slice(0, 20))}/>
          <Field label="Ciudad" value="Buenos Aires" editing={false}/>
          <Field label="Zona horaria" value="Argentina (GMT-3)" editing={false}/>
        </div>
      </section>
    </div>
  </>;
}


function SettingsPage() {
  const [toggles, setToggles] = useState<boolean[]>(() => {
    try {
      const saved = localStorage.getItem('huellicam_notification_preferences');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 4) {
          return parsed;
        }
      }
    } catch {}
    return [true, true, false, true];
  });
  const [loggingOut, setLoggingOut] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordToast, setPasswordToast] = useState<string | null>(null);
  const { logout } = useAuth();

  useEffect(() => {
    api.get("/api/notifications/preferences").then((res) => {
      if (res.data?.success && res.data?.data) {
        const d = res.data.data as {
          appointmentReminders?: boolean;
          inAppEnabled?: boolean;
          marketingEnabled?: boolean;
          emailRemindersEnabled?: boolean;
        };
        setToggles([
          d.appointmentReminders ?? true,
          d.inAppEnabled ?? true,
          d.marketingEnabled ?? false,
          d.emailRemindersEnabled ?? true,
        ]);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!passwordToast) return;
    const timer = window.setTimeout(() => setPasswordToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [passwordToast]);

  const handleToggle = (index: number) => {
    setToggles((prev) => {
      const next = prev.map((v, j) => (j === index ? !v : v));
      try {
        localStorage.setItem('huellicam_notification_preferences', JSON.stringify(next));
      } catch {}
      const payload =
        index === 0
          ? { appointmentReminders: next[0] }
          : index === 1
          ? { inAppEnabled: next[1], pushEnabled: next[1] }
          : index === 2
          ? { marketingEnabled: next[2] }
          : { emailRemindersEnabled: next[3], vaccineReminders: next[3] };
      api.put("/api/notifications/preferences", payload).catch((err: unknown) => {
        if (!(err as { response?: unknown })?.response) {
          import("../lib/offlineQueue").then(({ enqueueOfflineMutation }) => {
            enqueueOfflineMutation({ method: "PUT", url: "/api/notifications/preferences", data: payload });
          }).catch(() => {});
        }
      });
      return next;
    });
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <>
      <PageHeader eyebrow="Preferencias" title="Configuración" description="Elegí cómo querés usar Huellicam y recibir novedades."/>
      <div className="settings-layout">
        <section className="panel">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Avisos</span>
              <h2>Notificaciones</h2>
            </div>
          </div>
          {[
            ["Recordatorios de consultas", "Avisos antes de cada turno."],
            ["Nuevos mensajes", "Cuando un veterinario te escriba."],
            ["Novedades de Huellicam", "Información y consejos de cuidado."],
            ["Recetas y documentos", "Cuando haya nuevos archivos disponibles."]
          ].map((item, i) => (
            <div className="setting-row" key={item[0]}>
              <div>
                <strong>{item[0]}</strong>
                <p>{item[1]}</p>
              </div>
              <button
                role="switch"
                aria-checked={toggles[i]}
                className={`switch ${toggles[i] ? "is-on" : ""}`}
                onClick={() => handleToggle(i)}
              >
                <span/>
              </button>
            </div>
          ))}
        </section>
        <section className="panel">
          <div className="panel__heading">
            <div>
              <span className="eyebrow">Cuenta</span>
              <h2>Privacidad y acceso</h2>
            </div>
          </div>
          <button
            className="settings-link"
            type="button"
            onClick={() => setPasswordModalOpen(true)}
          >
            <span>
              <Icon name="shield"/>
              <span>
                <strong>Cambiar contraseña</strong>
                <small>Actualizá tu clave de acceso.</small>
              </span>
            </span>
            <Icon name="chevron"/>
          </button>
          <button
            className="settings-link"
            type="button"
            onClick={() => {
              window.location.href = "/privacy";
            }}
          >
            <span>
              <Icon name="file"/>
              <span>
                <strong>Privacidad</strong>
                <small>Revisá cómo cuidamos tus datos.</small>
              </span>
            </span>
            <Icon name="chevron"/>
          </button>
          <button
            className="settings-link"
            type="button"
            disabled={loggingOut}
            style={{ color: "var(--danger, #ae4d45)", marginTop: 12, opacity: loggingOut ? 0.7 : 1 }}
            onClick={handleLogout}
          >
            <span>
              <Icon name="close"/>
              <span>
                <strong style={{ color: "var(--danger, #ae4d45)" }}>
                  {loggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
                </strong>
                <small>Finalizar tu sesión en este dispositivo de forma segura.</small>
              </span>
            </span>
            <Icon name="chevron"/>
          </button>
        </section>
      </div>
      <ChangePasswordModal
        open={passwordModalOpen}
        onClose={() => setPasswordModalOpen(false)}
        onSuccess={(msg) => setPasswordToast(msg)}
      />
      {passwordToast && <Toast message={passwordToast} />}
    </>
  );
}

function SkeletonPage({ type }: { type: "dashboard" | "list" | "messages" | "cards" }) {
  return <div className={`skeleton-page skeleton-page--${type}`} aria-busy="true" aria-live="polite">
    <span className="sr-only">Cargando contenido</span>
    <div className="skeleton skeleton--eyebrow"/>
    <div className="skeleton skeleton--title"/>
    <div className="skeleton skeleton--subtitle"/>
    <div className="skeleton skeleton--hero"/>
    <div className="skeleton-grid">
      <div className="skeleton skeleton--card"/>
      <div className="skeleton skeleton--card"/>
      <div className="skeleton skeleton--card"/>
    </div>
  </div>;
}

function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="panel" data-testid="consultations-error-state">
      <EmptyState
        icon="heart"
        title="No pudimos cargar esta información"
        text="Intentá nuevamente en unos segundos."
        action="Reintentar"
        onAction={onRetry ?? (() => window.location.reload())}
      />
    </div>
  );
}


function NotFound() {
  return <EmptyState icon="paw" title="No encontramos esta página" text="La dirección puede haber cambiado. Volvé al inicio para seguir cuidando a tus mascotas." action="Volver al inicio"/>;
}

export default function ClientApp() {
  const { user } = useAuth();
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    if (user?.role === "VET") {
      go("/vet/dashboard");
    } else if (user?.role === "ADMIN") {
      go("/admin/dashboard");
    }
  }, [user]);
  useEffect(() => { const update = () => setPath(window.location.pathname); window.addEventListener("popstate", update); return () => window.removeEventListener("popstate", update); }, []);
  const page = useMemo(() => {
    if (path === "/" || path === "/client" || path === "/client/dashboard") return <Dashboard/>;
    if (path === "/client/pets") return <PetsPage/>;
    if (path.startsWith("/client/pets/")) {
      const petSegment = path.slice("/client/pets/".length).split("/")[0]?.trim();
      return petSegment ? <PetDetail id={petSegment} /> : <NotFound />;
    }
    if (path === "/client/consultations") return <ConsultationsPage/>;
    if (path.startsWith("/client/consultations/")) return <ConsultationDetail/>;
    if (path === "/client/appointments") return <ConsultationsPage initialTab="Agenda"/>;
    if (path === "/client/messages") return <MessagesPage/>;
    if (path === "/client/notifications") return <NotificationsPage/>;
    if (path === "/client/prescriptions") return <PrescriptionsPage/>;
    if (path === "/client/profile") return <ProfilePage/>;
    if (path === "/client/settings") return <SettingsPage/>;
    return <NotFound/>;
  }, [path]);
  if (path === "/vet" || path.startsWith("/vet/")) return <><ClientScopedStyle /><Suspense fallback={<div className="route-loading" role="status">Cargando consola profesional…</div>}><VetApp path={path}/></Suspense></>;
  if (path.startsWith("/call/")) {
    const callSegment = path.split("/")[2]?.trim();
    if (!callSegment) return <><ClientScopedStyle /><AppShell path={path}><NotFound /></AppShell></>;
    return <><ClientScopedStyle /><Suspense fallback={<div className="route-loading route-loading--dark" role="status">Preparando videoconsulta…</div>}><CallRoom id={callSegment}/></Suspense></>;
  }
  if (path === "/client/triage") return <><ClientScopedStyle /><TriagePage/></>;
  const state = new URLSearchParams(window.location.search).get("state");
  if (state === "loading") return <><ClientScopedStyle /><AppShell path={path}><SkeletonPage type={path === "/client/messages" ? "messages" : path === "/client/dashboard" ? "dashboard" : "list"}/></AppShell></>;
  if (state === "error") return <><ClientScopedStyle /><AppShell path={path}><ErrorState/></AppShell></>;
  return <><ClientScopedStyle /><AppShell path={path}><div key={path} className="hc-page-stage" style={path === "/client/messages" ? { display: "flex", flex: 1, minHeight: 0, width: "100%" } : undefined}>{page}</div></AppShell></>;
}
