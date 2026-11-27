import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Drawer } from "vaul";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Icon, Modal, Status, Toast, go } from "../shared";
import { useFocusTrap } from "../components/common/DialogOverlay";
import { useIsMobileViewport } from "../lib/useIsMobileViewport";
import { getInitials } from "../lib/formatters";
import api from "../services/api";
import { ClinicalChatThread, type ClinicalChatDoc, type ClinicalChatMessage } from "../components/chat/ClinicalChatThread";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../context/SocketContext";
import { normalizeMediaUrl, useAuthenticatedMediaUrl } from "../lib/authenticatedMedia";
import type { ApiResponse, Consultation as BackendConsultation, FollowUpDTO, Prescription as BackendPrescription, User } from "../types";
import { parseConsultationNotes } from "../lib/consultationNotes";
import {
  getPatient, initialConsults, initialEvents, initialFollowUps, initialQueue, initialRx, initialThreads, quickReplies, triageMeta,
  registerPatient, getAllPatients,
  type AgendaEvent, type Consult, type FollowUp, type Msg, type Patient, type QueueItem, type Rx, type Thread, type Triage,
} from "./data";
import { mapConsultationToQueueItem, mapConsultationToConsult, mapBackendPetToPatient } from "./mappers";

export type Avail = "Disponible" | "No disponible" | "En consulta";

type Ctx = {
  avail: Avail; requestAvail: (next: Avail) => void; notify: (msg: string) => void;
  queue: QueueItem[]; accept: (id: string) => void;
  consults: Consult[]; consultsLoading: boolean; finish: (id: string, notes?: string) => Promise<void> | void;
  consultsError: boolean; refetchConsults: () => void;
  threads: Thread[]; send: (petId: string, msg: Omit<Msg, "id" | "mine" | "time">) => void; markRead: (petId: string) => void; unread: number;
  events: AgendaEvent[]; setEvents: React.Dispatch<React.SetStateAction<AgendaEvent[]>>;
  rx: Rx[]; rxLoading: boolean; rxError: boolean; refetchRx: () => void; setRx: React.Dispatch<React.SetStateAction<Rx[]>>;
  followUps: FollowUp[]; setFollowUps: React.Dispatch<React.SetStateAction<FollowUp[]>>;
  patientsList: Patient[];
  forceEmpty: boolean;
};

const VetContext = createContext<Ctx | null>(null);
export const useVet = () => {
  const ctx = useContext(VetContext);
  if (!ctx) throw new Error("useVet fuera de VetProvider");
  return ctx;
};

export function VetProvider({ children, forceEmpty }: { children: ReactNode; forceEmpty: boolean }) {
  const { user } = useAuth();
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const [avail, setAvail] = useState<Avail>("Disponible");
  const [pending, setPending] = useState<Avail | null>(null);
  const [toast, setToast] = useState<{ msg: string; id: number; leaving?: boolean } | null>(null);

  // Sync vet availability presence with backend on mount (only for VET role)
  useEffect(() => {
    if (!forceEmpty && user?.role === "VET") {
      api.patch('/api/users/profile', { isOnline: true }).catch(() => {});
    }
  }, [user?.role, forceEmpty]);

  // Backend query for consultations & queue (strictly gated on VET & !forceEmpty)
  const vetConsultsQuery = useQuery({
    queryKey: ['consultations', 'vet'],
    enabled: !forceEmpty && user?.role === "VET",
    queryFn: async ({ signal }) => {
      const res = await api.get<ApiResponse<BackendConsultation[]>>('/api/consultations/mine', { signal });
      return (res.data.success && res.data.data) ? res.data.data : [];
    },
  });

  const notify = useCallback((msg: string) => setToast({ msg, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const leave = window.setTimeout(() => setToast((current) => current?.id === toast.id ? { ...current, leaving: true } : current), 3300);
    const remove = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 3800);
    return () => { window.clearTimeout(leave); window.clearTimeout(remove); };
  }, [toast?.id]);

  // Real-time UI toast notification for incoming guard triage consultations (query invalidation handled by SocketContext)
  useEffect(() => {
    if (!socket || forceEmpty || user?.role !== "VET") return;

    const handleConsultationNew = (newCons?: BackendConsultation) => {
      const petName = newCons?.pet?.name || "un paciente";
      notify(`🚨 Nueva solicitud de guardia para ${petName}`);
    };

    socket.on?.("consultation:new", handleConsultationNew);

    return () => {
      socket.off?.("consultation:new", handleConsultationNew);
    };
  }, [socket, forceEmpty, user?.role, notify]);

  // Dynamically register real patients from DB consultations
  useEffect(() => {
    if (forceEmpty || user?.role !== "VET" || !vetConsultsQuery.data) return;
    vetConsultsQuery.data.forEach((c) => {
      if (c.pet) {
        const patient = mapBackendPetToPatient(c.pet, c.client);
        registerPatient(patient);
      }
    });
  }, [vetConsultsQuery.data, forceEmpty, user?.role]);

  // Derived real queue from WAITING consultations in DB
  const mappedRealQueue = useMemo((): QueueItem[] => {
    if (forceEmpty) return [];
    if (!vetConsultsQuery.data) return [];
    return vetConsultsQuery.data
      .filter((c) => c.status === "WAITING")
      .map(mapConsultationToQueueItem);
  }, [vetConsultsQuery.data, forceEmpty]);

  // Derived real consults from ACTIVE / COMPLETED / CANCELLED in DB
  const mappedRealConsults = useMemo((): Consult[] => {
    if (forceEmpty) return [];
    if (!vetConsultsQuery.data) return [];
    return vetConsultsQuery.data
      .filter((c) => c.status !== "WAITING")
      .map(mapConsultationToConsult);
  }, [vetConsultsQuery.data, forceEmpty]);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [consults, setConsults] = useState<Consult[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [events, setEvents] = useState<AgendaEvent[]>([]);
  const [rx, setRx] = useState<Rx[]>(() => {
    try {
      const saved = localStorage.getItem("huellicam_vet_rx");
      const parsed: Rx[] = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => item.status === "Borrador") : [];
    } catch {
      return [];
    }
  });
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);

  const vetFollowUpsQuery = useQuery({
    queryKey: ['follow-ups', 'vet', user?.id],
    enabled: !forceEmpty && user?.role === "VET",
    queryFn: async () => {
      const res = await api.get<ApiResponse<FollowUpDTO[]>>('/api/scheduling/follow-ups');
      return res.data.success && res.data.data ? res.data.data : [];
    },
  });

  useEffect(() => {
    if (forceEmpty || !vetFollowUpsQuery.data) return;
    const nowMs = Date.now();
    const mapped: FollowUp[] = vetFollowUpsQuery.data.map((item) => {
      const due = new Date(item.scheduledAt);
      const dueStr = Number.isFinite(due.getTime())
        ? `${due.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · ${due.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
        : "Por definir";
      const uiStatus: FollowUp["status"] =
        item.status === "COMPLETED"
          ? "Realizado"
          : due.getTime() < nowMs && item.status === "PENDING"
          ? "Atrasado"
          : "Pendiente";
      return {
        id: item.id,
        petId: item.petId,
        title: item.title,
        when: dueStr,
        status: uiStatus,
        note: item.notes || "Control clínico programado.",
      };
    });
    setFollowUps(mapped);
  }, [vetFollowUpsQuery.data, forceEmpty]);

  useEffect(() => {
    if (forceEmpty) return;
    const consultEvents: AgendaEvent[] = (vetConsultsQuery.data || []).map((c) => {
      const targetIso = c.scheduledAt || c.startedAt || c.createdAt;
      const dt = new Date(targetIso);
      const dayIdx = Number.isFinite(dt.getTime()) ? (dt.getDay() + 6) % 7 : 0;
      const timeStr = Number.isFinite(dt.getTime())
        ? dt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
        : "18:00";
      const status: AgendaEvent["status"] =
        c.status === "COMPLETED"
          ? "Completada"
          : c.status === "CANCELLED"
          ? "Cancelada"
          : c.status === "ACTIVE"
          ? "Confirmada"
          : "Pendiente";
      return {
        id: `ev-c-${c.id}`,
        day: dayIdx,
        time: timeStr,
        petId: c.petId,
        type: "Videoconsulta",
        status,
        consultId: c.id,
      };
    });
    const followUpEvents: AgendaEvent[] = (vetFollowUpsQuery.data || [])
      .filter((f) => f.status !== "CANCELLED")
      .map((f) => {
        const dt = new Date(f.scheduledAt);
        const dayIdx = Number.isFinite(dt.getTime()) ? (dt.getDay() + 6) % 7 : 0;
        const timeStr = Number.isFinite(dt.getTime())
          ? dt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "18:00";
        return {
          id: `fu-${f.id}`,
          day: dayIdx,
          time: timeStr,
          petId: f.petId,
          type: "Seguimiento",
          status: f.status === "COMPLETED" ? "Completada" : "Pendiente",
        };
      });
    setEvents([...consultEvents, ...followUpEvents]);
  }, [vetConsultsQuery.data, vetFollowUpsQuery.data, forceEmpty]);

  const vetPrescriptionsQuery = useQuery({
    queryKey: ['prescriptions', 'vet', user?.id],
    enabled: !forceEmpty && user?.role === "VET",
    queryFn: async () => {
      const res = await api.get<ApiResponse<(BackendPrescription & { consultation?: BackendConsultation })[]>>('/api/prescriptions');
      return (res.data.success && res.data.data) ? res.data.data : [];
    },
  });

  useEffect(() => {
    try {
      const drafts = rx.filter((item) => item.status === "Borrador");
      localStorage.setItem("huellicam_vet_rx", JSON.stringify(drafts));
    } catch {
      // Ignore storage errors
    }
  }, [rx]);

  useEffect(() => {
    if (forceEmpty || !vetPrescriptionsQuery.data) return;
    const mappedIssued: Rx[] = vetPrescriptionsQuery.data.map((item) => {
      if (item.consultation?.pet) {
        registerPatient(mapBackendPetToPatient(item.consultation.pet, item.consultation.client));
      }
      return {
        id: item.id,
        petId: item.consultation?.petId || "",
        consultationId: item.consultationId,
        med: item.medication,
        dose: item.dosage,
        freq: item.frequency,
        duration: `${item.durationDays} días`,
        notes: item.indications,
        status: "Emitida",
        date: item.createdAt
          ? new Date(item.createdAt).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" })
          : "Hoy",
        qrCodeDataUrl: item.qrCodeDataUrl,
        verifyUrl: item.signedVerifyUrl || item.verifyUrl,
      };
    });

    setRx((prev) => {
      const drafts = prev.filter((item) => item.status === "Borrador");
      return [...mappedIssued, ...drafts];
    });
  }, [vetPrescriptionsQuery.data, forceEmpty]);

  // Sync state when backend returns live rows
  useEffect(() => {
    if (!forceEmpty && mappedRealQueue) {
      setQueue(mappedRealQueue);
    }
  }, [mappedRealQueue, forceEmpty]);

  useEffect(() => {
    if (!forceEmpty && mappedRealConsults) {
      setConsults(mappedRealConsults);
      if (mappedRealConsults.length > 0) {
        setThreads((prev) => {
          const mappedThreads: Thread[] = mappedRealConsults.map((c) => {
            const existing = prev.find((t) => t.petId === c.petId);
            return {
              id: `t-${c.id}`,
              petId: c.petId,
              last: existing?.last || c.reason || "Consulta médica",
              lastTime: existing?.lastTime || c.time || "Hoy",
              unread: existing?.unread || 0,
              online: c.status === "Activa",
              msgs: existing?.msgs || [],
            };
          });
          return mappedThreads;
        });
      }
    }
  }, [mappedRealConsults, forceEmpty]);

  const apply = useCallback(async (next: Avail) => {
    setAvail(next);
    notify(`Tu estado ahora es: ${next}`);
    try {
      await api.patch('/api/users/profile', { isOnline: next === "Disponible" });
    } catch {
      // Presence sync
    }
  }, [notify]);

  const requestAvail = useCallback((next: Avail) => {
    if (next === avail) return;
    if (next === "No disponible" && queue.length > 0) setPending(next);
    else apply(next);
  }, [avail, queue.length, apply]);

  const accept = useCallback(async (id: string) => {
    const q = queue.find((item) => item.id === id);
    try {
      await api.patch(`/api/consultations/${id}/assign`);
      queryClient.invalidateQueries({ queryKey: ['consultations'] });
      setAvail("En consulta");
      notify(`Aceptaste la consulta de ${q ? getPatient(q.petId).name : "paciente"}`);
      go(`/call/${id}`);
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || "No se pudo asignar la consulta.";
      notify(msg);
    }
  }, [queue, notify, queryClient]);

  const finish = useCallback(async (id: string, notes?: string) => {
    const payload = { diagnosisNotes: notes || "Consulta telemática finalizada con éxito." };
    try {
      await api.patch(`/api/consultations/${id}/complete`, payload);
      void queryClient.invalidateQueries({ queryKey: ['consultations'] });
      setAvail("Disponible");
      notify("Consulta finalizada con éxito");
    } catch (err: unknown) {
      const hasResponse = Boolean((err as { response?: unknown })?.response);
      if (!hasResponse) {
        const { enqueueOfflineMutation } = await import("../lib/offlineQueue");
        enqueueOfflineMutation({ method: "PATCH", url: `/api/consultations/${id}/complete`, data: payload });
        notify("Sin conexión: el cierre de la consulta quedó en cola para sincronizar.");
        return;
      }
      notify("No se pudo completar la consulta.");
    }
  }, [notify, queryClient]);

  const send = useCallback((petId: string, msg: Omit<Msg, "id" | "mine" | "time">) => {
    const full: Msg = { ...msg, id: `m${Date.now()}`, mine: true, time: "Ahora" };
    setThreads((list) => list.some((t) => t.petId === petId)
      ? list.map((t) => t.petId === petId ? { ...t, msgs: [...t.msgs, full], last: msg.text ?? "Archivo", lastTime: "Ahora" } : t)
      : [{ id: `t-${petId}`, petId, last: msg.text ?? "Archivo", lastTime: "Ahora", unread: 0, online: false, msgs: [full] }, ...list]);
  }, []);
  const markRead = useCallback((petId: string) => setThreads((list) => list.some((t) => t.petId === petId && t.unread) ? list.map((t) => t.petId === petId ? { ...t, unread: 0 } : t) : list), []);
  const unread = threads.reduce((n, t) => n + t.unread, 0);

  const patientsList = useMemo(() => {
    const activePetIds = new Set<string>([
      ...queue.map((q) => q.petId),
      ...consults
        .filter((c) => c.status === "Activa" || c.status === "Próxima")
        .map((c) => c.petId),
    ]);
    const followUpPetIds = new Set<string>(
      followUps.filter((f) => f.status !== "Realizado").map((f) => f.petId)
    );
    return getAllPatients().map((patient) => ({
      ...patient,
      state: (activePetIds.has(patient.id)
        ? "Activo"
        : followUpPetIds.has(patient.id)
        ? "En seguimiento"
        : "Sin consultas recientes") as Patient["state"],
    }));
  }, [vetConsultsQuery.data, queue, consults, followUps]);

  const refetchConsults = useCallback(() => {
    void vetConsultsQuery.refetch();
  }, [vetConsultsQuery]);
  const consultsError = !forceEmpty && vetConsultsQuery.isError;

  const value = useMemo(() => ({ avail, requestAvail, notify, queue, accept, consults, consultsLoading: vetConsultsQuery.isLoading, finish, consultsError, refetchConsults, threads, send, markRead, unread, events, setEvents, rx, rxLoading: vetPrescriptionsQuery.isLoading, rxError: vetPrescriptionsQuery.isError, refetchRx: () => { void vetPrescriptionsQuery.refetch(); }, setRx, followUps, setFollowUps, patientsList, forceEmpty }),
    [avail, requestAvail, notify, queue, accept, consults, vetConsultsQuery.isLoading, finish, consultsError, refetchConsults, threads, send, markRead, unread, events, rx, vetPrescriptionsQuery.isLoading, vetPrescriptionsQuery.isError, vetPrescriptionsQuery.refetch, followUps, patientsList, forceEmpty]);

  return <VetContext.Provider value={value}>
    {children}
    {toast && <Toast message={toast.msg} key={toast.id}/>}
    {pending && <Modal title="Pasar a No disponible" text={`Tenés ${queue.length} ${queue.length === 1 ? "paciente" : "pacientes"} en espera. Si cambiás tu estado, dejás de recibir nuevas solicitudes.`} cancel="Seguir disponible" confirm="Cambiar estado" onClose={() => setPending(null)} onConfirm={() => { apply(pending); setPending(null); }}/>}
  </VetContext.Provider>;
}

const slug = (t: Triage) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function TriageBadge({ level, compact = false }: { level: Triage; compact?: boolean }) {
  const meta = triageMeta[level];
  return <span className={`triage triage--${slug(level)} ${compact ? "triage--compact" : ""}`}>
    <Icon name={meta.icon} size={compact ? 14 : 16}/>
    <b>{level}</b>
    <span className="triage__pips" aria-hidden="true">{[1, 2, 3, 4].map((n) => <i key={n} className={n <= meta.level ? "is-on" : ""}/>)}</span>
    <span className="sr-only">Nivel {meta.level} de 4</span>
  </span>;
}

export function WaitTimer({ base, createdAt }: { base: number; createdAt?: string }) {
  const fallbackStartMsRef = useRef<number>(Date.now() - Math.max(0, base) * 1000);
  const computeElapsed = useCallback(() => {
    const parsed = createdAt ? new Date(createdAt).getTime() : NaN;
    const startMs = Number.isFinite(parsed) ? parsed : fallbackStartMsRef.current;
    return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  }, [createdAt]);

  const [s, setS] = useState<number>(() => computeElapsed());
  useEffect(() => {
    setS(computeElapsed());
    const t = window.setInterval(() => setS(computeElapsed()), 1000);
    return () => window.clearInterval(t);
  }, [computeElapsed]);

  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <time className="v-timer" aria-label={`${Math.floor(s / 60)} minutos de espera`}>{mm}:{ss}</time>;
}

export function PetPhoto({ pet, size = 44 }: { pet: Patient; size?: number }) {
  const [failed, setFailed] = useState(false);
  const resolvedSrc = useAuthenticatedMediaUrl(pet.photo);
  useEffect(() => {
    setFailed(false);
  }, [pet.photo, resolvedSrc]);
  if (!pet.photo || !resolvedSrc || failed) {
    return (
      <span
        className="v-pet-photo v-pet-photo--fallback"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          display: "inline-grid",
          placeItems: "center",
          borderRadius: "50%",
          background: "#d9e8e4",
          color: "#183c3a",
          fontWeight: 800,
          fontSize: Math.max(11, Math.round(size * 0.34)),
          flexShrink: 0,
        }}
      >
        {getInitials(pet.name, "M")}
      </span>
    );
  }
  return (
    <img
      className="v-pet-photo"
      src={resolvedSrc}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
    />
  );
}

const statusTone: Record<string, "teal" | "amber" | "gray" | "red"> = {
  Próxima: "amber", Activa: "teal", Finalizada: "gray", Cancelada: "red", Confirmada: "teal", Pendiente: "amber", Completada: "gray",
  Programado: "teal", Atrasado: "red", Realizado: "gray", Emitida: "teal", Borrador: "amber",
};

export function ConsultStatus({ status }: { status: string }) {
  return <Status tone={statusTone[status] ?? "gray"}>{status}</Status>;
}

export type LightboxItem = { src: string; caption: string; pos?: string; date?: string };

function LightboxThumb({ item, active, onSelect }: { item: LightboxItem; active: boolean; onSelect: () => void }) {
  const thumbSrc = useAuthenticatedMediaUrl(item.src);
  return (
    <button
      className={active ? "is-selected" : ""}
      onClick={onSelect}
      aria-label={`Ver ${item.caption}`}
      aria-current={active}
    >
      {thumbSrc ? <img src={thumbSrc} alt="" style={{ objectPosition: item.pos }} /> : <span className="v-mini-empty">...</span>}
    </button>
  );
}

export function Lightbox({ items, index, onIndex, onClose, pet, consult }: { items: LightboxItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; pet: string; consult: string }) {
  const [zoom, setZoom] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const move = useCallback((d: number) => { setZoom(false); onIndex((index + d + items.length) % items.length); }, [index, items.length, onIndex]);
  useFocusTrap(true, frameRef, { onEscape: onClose, initialFocusRef: closeRef });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "ArrowLeft") move(-1); if (e.key === "ArrowRight") move(1); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);
  const item = items[index];
  const resolvedSrc = useAuthenticatedMediaUrl(item?.src);
  const lightboxNode = <div className="modal-layer v-lightbox" role="dialog" aria-modal="true" aria-label={`Fotografía clínica ${index + 1} de ${items.length}`}>
    <button className="modal-scrim" onClick={onClose} aria-label="Cerrar visor"/>
    <div ref={frameRef} className="v-lightbox__frame">
      <header>
        <div><b>{pet}</b><span>{item.caption}</span></div>
        <div className="v-lightbox__ctx">{item.date && <span>{item.date}</span>}<span>{consult}</span><span>{index + 1} / {items.length}</span></div>
        <Button variant="icon" icon="expand" ariaLabel={zoom ? "Reducir imagen" : "Ampliar imagen"} onClick={() => setZoom(!zoom)}/>
        <button ref={closeRef} className="button button--icon" onClick={onClose} aria-label="Cerrar visor"><Icon name="close" size={18}/></button>
      </header>
      <div className="v-lightbox__stage">
        {items.length > 1 && <button className="v-lightbox__nav v-lightbox__nav--prev" onClick={() => move(-1)} aria-label="Fotografía anterior"><Icon name="left" size={22}/></button>}
        {resolvedSrc ? (
          <img src={resolvedSrc} alt={`${item.caption} de ${pet}`} className={zoom ? "is-zoomed" : ""} style={{ objectPosition: item.pos }} onClick={() => setZoom(!zoom)}/>
        ) : (
          <div style={{ color: "#FAF8F5", fontSize: 13 }}>Cargando imagen clínica...</div>
        )}
        {items.length > 1 && <button className="v-lightbox__nav v-lightbox__nav--next" onClick={() => move(1)} aria-label="Fotografía siguiente"><Icon name="chevron" size={22}/></button>}
      </div>
      {items.length > 1 && <div className="v-lightbox__thumbs">{items.map((it, i) => <LightboxThumb key={i} item={it} active={i === index} onSelect={() => { setZoom(false); onIndex(i); }} />)}</div>}
    </div>
  </div>;
  return typeof document !== "undefined" ? createPortal(lightboxNode, document.body) : lightboxNode;
}

export function Sheet({ eyebrow, title, onClose, children, footer }: { eyebrow?: string; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const isMobile = useIsMobileViewport();
  const ref = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useFocusTrap(!isMobile, dialog, { onEscape: onClose, initialFocusRef: ref });

  if (isMobile) {
    return (
      <Drawer.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
        <Drawer.Portal>
          <Drawer.Overlay className="modal-scrim" style={{ position: "fixed", inset: 0, zIndex: 99 }} />
          <Drawer.Content
            className="v-sheet"
            style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 100 }}
            aria-describedby={undefined}
          >
            <Drawer.Title className="sr-only">{title}</Drawer.Title>
            <span className="v-sheet__grip" aria-hidden="true" />
            <header>
              <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>
              <button className="button button--icon" onClick={onClose} aria-label="Cerrar"><Icon name="close" size={18} /></button>
            </header>
            <div className="v-sheet__body">{children}</div>
            {footer && <footer className="v-sheet__footer">{footer}</footer>}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  const sheetNode = <div className="v-sheet-layer" role="presentation">
    <button className="modal-scrim" onClick={onClose} aria-label="Cerrar panel"/>
    <aside ref={dialog} className="v-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <span className="v-sheet__grip" aria-hidden="true"/>
      <header><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><button ref={ref} className="button button--icon" onClick={onClose} aria-label="Cerrar"><Icon name="close" size={18}/></button></header>
      <div className="v-sheet__body">{children}</div>
      {footer && <footer className="v-sheet__footer">{footer}</footer>}
    </aside>
  </div>;
  return typeof document !== "undefined" ? createPortal(sheetNode, document.body) : sheetNode;
}

interface VetChatRawMessage {
  id?: string;
  clientMsgId?: string;
  consultationId?: string;
  content?: string;
  attachmentUrl?: string | null;
  senderId?: string;
  sender?: { firstName?: string; lastName?: string };
  createdAt?: string | null;
  timeStr?: string;
  kind?: string;
  src?: string;
  name?: string;
  pos?: string;
  mine?: boolean;
  localDoc?: ClinicalChatDoc;
}

const VET_CHAT_IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i;

function buildVetDocFromMessage(m: VetChatRawMessage): ClinicalChatDoc | undefined {
  if (m.localDoc) return m.localDoc;
  const resolved = normalizeMediaUrl(m.attachmentUrl);
  if (!resolved) return undefined;
  const contentText = (m.content || "").trim();
  const title = contentText.replace(/^📎\s*Adjunto:\s*/i, "") || "Archivo clínico adjunto";
  const isImage = VET_CHAT_IMAGE_RE.test(resolved) || VET_CHAT_IMAGE_RE.test(title);
  return {
    title,
    sub: isImage ? "Imagen clínica adjunta" : "Documento clínico adjunto",
    bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
    bannerTitle: "HuelliCam · Expediente Clínico",
    fileUrl: resolved,
    isImage,
  };
}

export function ChatPanel({
  petId,
  consultationId,
  header = true,
  actions,
  onBack,
  consultLabel = "Conversación",
  useInitialsAvatar = false,
}: {
  petId: string;
  consultationId?: string;
  header?: boolean;
  actions?: ReactNode;
  onBack?: () => void;
  consultLabel?: string;
  useInitialsAvatar?: boolean;
}) {
  const { user } = useAuth();
  const { socket, isConnected, joinConsultation, leaveConsultation, emitEvent } = useSocket();
  const blobUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => {
        try {
          URL.revokeObjectURL?.(url);
        } catch {}
      });
      blobUrlsRef.current.clear();
    };
  }, [consultationId, petId]);
  const roomActionsRef = useRef({ joinConsultation, leaveConsultation });
  roomActionsRef.current = { joinConsultation, leaveConsultation };
  const { threads, send, markRead, notify, consults } = useVet();
  const pet = getPatient(petId);
  const thread = threads.find((t) => t.petId === petId);

  // Resolve consultationId from props or consults
  const activeConsultationId = consultationId || consults.find((c) => c.petId === petId || c.id === petId)?.id;

  const [messages, setMessages] = useState<VetChatRawMessage[]>([]);
  const [text, setText] = useState("");
  const [box, setBox] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const activeConsultationIdRef = useRef(activeConsultationId);
  const consultationEpochRef = useRef(0);
  if (activeConsultationIdRef.current !== activeConsultationId) {
    activeConsultationIdRef.current = activeConsultationId;
    consultationEpochRef.current += 1;
  }
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Mark read
  useEffect(() => {
    markRead(petId);
  }, [petId, markRead, messages.length]);

  // Local demo thread fallback when there is no active consultation ID
  useEffect(() => {
    if (activeConsultationId) return;
    if (!thread?.msgs) {
      setMessages([]);
      return;
    }
    setMessages(
      thread.msgs.map((m) => ({
        id: m.id,
        content: m.text || m.name || "",
        senderId: m.mine ? user?.id : "other",
        createdAt: null,
        timeStr: m.time,
        kind: m.kind,
        src: m.src,
        name: m.name,
        pos: m.pos,
      }))
    );
  }, [activeConsultationId, thread?.msgs, user?.id]);

  // Join room & fetch message history once per activeConsultationId
  useEffect(() => {
    if (!activeConsultationId) return;
    let cancelled = false;
    setMessages([]);
    roomActionsRef.current.joinConsultation(activeConsultationId);

    api
      .get<ApiResponse<VetChatRawMessage[]>>(`/api/consultations/${activeConsultationId}/messages`)
      .then((res) => {
        if (!cancelled && res.data.success && res.data.data) {
          setMessages(res.data.data);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      roomActionsRef.current.leaveConsultation(activeConsultationId);
    };
  }, [activeConsultationId]);

  // Listen to incoming real-time messages on the shared singleton socket
  useEffect(() => {
    if (!socket || !activeConsultationId) return;

    const handleMessageNew = (msg: VetChatRawMessage) => {
      if (msg.consultationId && msg.consultationId !== activeConsultationId) return;
      setMessages((prev) => {
        if (prev.some((m) => (m.id && m.id === msg.id) || (m.clientMsgId && m.clientMsgId === msg.clientMsgId))) {
          return prev;
        }
        return [...prev, msg];
      });
    };

    const handleChatDeleted = (payload?: { consultationId?: string }) => {
      if (payload?.consultationId && payload.consultationId !== activeConsultationId) return;
      setMessages([]);
    };

    socket.on?.("message:new", handleMessageNew);
    socket.on?.("chat:deleted", handleChatDeleted);

    return () => {
      socket.off?.("message:new", handleMessageNew);
      socket.off?.("chat:deleted", handleChatDeleted);
    };
  }, [socket, activeConsultationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, petId]);

  const submit = async () => {
    if (!text.trim()) return;
    const content = text.trim();
    const targetCid = activeConsultationId;
    const targetEpoch = consultationEpochRef.current;
    const isStaleTarget = () =>
      !isMountedRef.current ||
      activeConsultationIdRef.current !== targetCid ||
      consultationEpochRef.current !== targetEpoch;
    setText("");

    if (targetCid) {
      const clientMsgId = `vet-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (socket && isConnected) {
        emitEvent<ApiResponse<VetChatRawMessage>>(
          "message:send",
          { consultationId: targetCid, content, clientMsgId },
          (res) => {
            if (isStaleTarget()) return;
            if (res?.success && res?.data) {
              const createdMsg = res.data;
              setMessages((prev) => {
                if (
                  prev.some(
                    (m) =>
                      (createdMsg.id && m.id === createdMsg.id) ||
                      (m.clientMsgId && m.clientMsgId === clientMsgId)
                  )
                ) {
                  return prev;
                }
                return [...prev, createdMsg];
              });
            }
          }
        );
      } else {
        try {
          const res = await api.post<ApiResponse<VetChatRawMessage>>(`/api/consultations/${targetCid}/messages`, {
            content,
            clientMsgId,
          });
          if (isStaleTarget()) return;
          if (res.data.success && res.data.data) {
            const createdMsg = res.data.data;
            setMessages((prev) => {
              if (
                prev.some(
                  (m) =>
                    (createdMsg.id && m.id === createdMsg.id) ||
                    (m.clientMsgId && m.clientMsgId === clientMsgId)
                )
              ) {
                return prev;
              }
              return [...prev, createdMsg];
            });
          }
        } catch {
          if (isStaleTarget()) return;
          notify("No se pudo enviar el mensaje.");
        }
      }
    } else {
      send(petId, { text: content });
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, content, senderId: user?.id, createdAt: new Date().toISOString() },
      ]);
    }
  };

  const handleAttachFile = async (file: File, isImage: boolean) => {
    const targetCid = activeConsultationId;
    const targetEpoch = consultationEpochRef.current;
    const isStaleTarget = () =>
      !isMountedRef.current ||
      activeConsultationIdRef.current !== targetCid ||
      consultationEpochRef.current !== targetEpoch;
    if (!targetCid) {
      const localUrl = URL.createObjectURL(file);
      blobUrlsRef.current.add(localUrl);
      send(petId, { text: isImage ? `📷 ${file.name}` : `📄 ${file.name}` });
      setMessages((prev) => [
        ...prev,
        {
          id: `local-file-${Date.now()}`,
          content: file.name,
          senderId: user?.id,
          createdAt: new Date().toISOString(),
          localDoc: {
            title: file.name,
            sub: `${isImage ? "Imagen" : "Documento"} clínico · ${(file.size / 1024).toFixed(1)} KB`,
            bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
            fileUrl: localUrl,
            isImage,
          },
        },
      ]);
      return;
    }

    let attachmentUrl: string | undefined;
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("consultationId", targetCid);
      const up = await api.post<ApiResponse<{ id?: string; url?: string }>>("/api/media", formData);
      if (isStaleTarget()) return;
      if (up.data?.data?.url) attachmentUrl = up.data.data.url;
      else if (up.data?.data?.id) attachmentUrl = `/api/media/${up.data.data.id}`;
    } catch {
      if (isStaleTarget()) return;
      notify("No se pudo subir el archivo adjunto. Intentá nuevamente.");
      return;
    }

    if (!attachmentUrl || isStaleTarget()) {
      if (!isStaleTarget()) {
        notify("No se pudo adjuntar el archivo.");
      }
      return;
    }

    const clientMsgId = `vet-file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const content = `📎 Adjunto: ${file.name}`;
    try {
      const res = await api.post<ApiResponse<VetChatRawMessage>>(`/api/consultations/${targetCid}/messages`, {
        content,
        clientMsgId,
        attachmentUrl,
      });
      if (isStaleTarget()) return;
      if (res.data.success && res.data.data) {
        const createdMsg = res.data.data;
        const localDoc = {
          title: file.name,
          sub: `${isImage ? "Imagen" : "Documento"} clínico · ${(file.size / 1024).toFixed(1)} KB`,
          bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
          fileUrl: attachmentUrl,
          isImage,
        };
        setMessages((prev) => {
          const existingIdx = prev.findIndex(
            (m) =>
              (createdMsg.id && m.id === createdMsg.id) ||
              (m.clientMsgId && m.clientMsgId === clientMsgId)
          );
          if (existingIdx >= 0) {
            const updated = [...prev];
            updated[existingIdx] = { ...prev[existingIdx], ...createdMsg, localDoc };
            return updated;
          }
          return [...prev, { ...createdMsg, localDoc }];
        });
      }
    } catch {
      if (isStaleTarget()) return;
      notify("No se pudo adjuntar el archivo.");
    }
  };

  const images = (thread?.msgs ?? []).filter((m) => m.kind === "image");
  const mappedMessages: ClinicalChatMessage[] = messages.map((m) => {
    const mine = Boolean((m.senderId && m.senderId === user?.id) || m.mine);
    const time = m.createdAt
      ? new Date(m.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
      : m.timeStr || "Ahora";

    if (m.kind === "image" && m.src) {
      const idx = images.findIndex((i) => i.id === m.id);
      return {
        id: String(m.id),
        mine,
        time,
        imageThumb: {
          src: m.src,
          caption: m.name || "Imagen clínica",
          pos: m.pos,
          onZoom: () => setBox(idx >= 0 ? idx : 0),
        },
      };
    }

    const doc = buildVetDocFromMessage(m);
    const displayText =
      doc && m.content?.startsWith("📎 Adjunto:") ? undefined : m.content;

    return {
      id: String(m.id || m.clientMsgId || `${time}-${Math.random()}`),
      mine,
      senderName: mine ? undefined : m.sender?.firstName || pet.tutor,
      text: displayText,
      time,
      doc,
    };
  });

  const activeConsult = consults.find((c) => c.id === activeConsultationId);
  const isActiveConsult = activeConsult?.status === "Activa";

  return (
    <>
      <ClinicalChatThread
        className="v-chat"
        ariaLabel={`Conversación con ${pet.tutor}`}
        showHeader={header}
        contactName={`${pet.tutor} · ${pet.name}`}
        contactInitials={getInitials(pet.tutor || pet.name, "TU")}
        avatarNode={useInitialsAvatar ? undefined : <PetPhoto pet={pet} size={40} />}
        statusText={
          isActiveConsult
            ? `En consulta activa · ${pet.kind}, ${pet.breed}`
            : activeConsult
            ? `Estado: ${activeConsult.status} · ${pet.kind}, ${pet.breed}`
            : `${pet.kind}, ${pet.breed}`
        }
        isOnline={isActiveConsult}
        onBack={onBack}
        headerActions={actions}
        messages={mappedMessages}
        value={text}
        onChange={setText}
        onSend={submit}
        placeholder={`Escribir a ${pet.tutor}…`}
        quickReplies={quickReplies}
        onAttachFile={handleAttachFile}
        endRef={endRef}
      />

      {box !== null && images[box] && (
        <Lightbox
          items={images.map((i) => ({ src: i.src!, caption: i.name!, pos: i.pos }))}
          index={box}
          onIndex={setBox}
          onClose={() => setBox(null)}
          pet={pet.name}
          consult={consultLabel}
        />
      )}
    </>
  );
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return <label className="v-select"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select></label>;
}
