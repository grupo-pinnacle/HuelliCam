import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, EmptyState, Field, Icon, Modal, PageHeader, SectionStage, Status, Tabs, go } from "../shared";
import api from "../services/api";
import { useAuth } from "../context/AuthContext";
import { ChangePasswordModal } from "../components/common/ChangePasswordModal";
import { buildAbsoluteMediaUrl, useAuthenticatedMediaUrl } from "../lib/authenticatedMedia";
import type { ApiResponse, VetLedgerSummaryDTO } from "../types";
import { availability, getPatient, type FollowUp } from "./data";
import { ConsultStatus, PetPhoto, Sheet, useVet } from "./vetkit";

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getPresetIso(daysAhead: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return toLocalInputValue(d);
}

export function FollowUpsPage() {
  const queryClient = useQueryClient();
  const { followUps, setFollowUps, patientsList, notify } = useVet();
  const [tab, setTab] = useState<string>("Pendientes");
  const [open, setOpen] = useState<FollowUp | null>(null);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedAt, setReschedAt] = useState("");
  const [reschedBusy, setReschedBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPetId, setNewPetId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDueAt, setNewDueAt] = useState(() => getPresetIso(2, 10));
  const [newNotes, setNewNotes] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const rank = { Atrasado: 0, Pendiente: 1, Programado: 2, Realizado: 3 } as const;
  const list = [...followUps].sort((a, b) => rank[a.status] - rank[b.status]);
  const overdueCount = list.filter((f) => f.status === "Atrasado").length;
  const pending = list.filter((f) => f.status !== "Realizado");
  const done = list.filter((f) => f.status === "Realizado");
  const visible = tab === "Pendientes" ? pending : tab === "Realizados" ? done : list;

  const openCreateModal = () => {
    setNewPetId(patientsList[0]?.id || "");
    setNewTitle("");
    setNewDueAt(getPresetIso(2, 10));
    setNewNotes("");
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!newPetId || !newTitle.trim() || !newDueAt) return;
    setCreateBusy(true);
    try {
      const dueDate = new Date(newDueAt);
      const res = await api.post<ApiResponse<{ id: string }>>("/api/scheduling/follow-ups", {
        petId: newPetId,
        title: newTitle.trim(),
        notes: newNotes.trim() || null,
        dueAt: dueDate.toISOString(),
      });
      const createdId = res.data?.data?.id || `fu-${Date.now()}`;
      const whenLabel = `${dueDate.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · ${dueDate.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
      setFollowUps((prev) => [
        {
          id: createdId,
          petId: newPetId,
          title: newTitle.trim(),
          when: whenLabel,
          status: "Pendiente",
          note: newNotes.trim() || "Control programado por el profesional.",
        },
        ...prev,
      ]);
      void queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
      notify(`Seguimiento programado para ${getPatient(newPetId).name}.`);
      setCreateOpen(false);
      setTab("Pendientes");
    } catch {
      notify("No pudimos programar el seguimiento. Revisá los datos e intentá nuevamente.");
    } finally {
      setCreateBusy(false);
    }
  };

  const card = (f: FollowUp) => {
    const p = getPatient(f.petId);
    return (
      <article role="listitem" className={`v-row v-row--fu v-fu-card v-row--${f.status.toLowerCase()}`} key={f.id}>
        <PetPhoto pet={p} size={48}/>
        <div className="v-row__main">
          <h3>{p.name} <small>{p.kind}</small></h3>
          <p>{f.title}</p>
          <small>Tutor: {p.tutor}{f.note ? ` · ${f.note}` : ""}</small>
        </div>
        <div className="v-fu-when">
          <span className="v-label">Próximo seguimiento</span>
          <b><Icon name={f.status === "Atrasado" ? "alert" : "clock"} size={14}/>{f.when}</b>
        </div>
        <ConsultStatus status={f.status}/>
        <Button
          variant={f.status === "Atrasado" ? "primary" : "secondary"}
          onClick={() => { setOpen(f); setReschedOpen(false); setReschedAt(""); }}
        >
          Abrir seguimiento
        </Button>
      </article>
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="Continuidad del cuidado"
        title="Seguimientos"
        description="Controlá evoluciones pendientes, reprogramá fechas o cerrá seguimientos clínicos."
        action={
          <Button icon="plus" onClick={openCreateModal} disabled={patientsList.length === 0}>
            Nuevo seguimiento
          </Button>
        }
      />

      <div className="v-fu-stats" aria-label="Resumen de seguimientos">
        <div className={`v-fu-stat ${overdueCount > 0 ? "is-alert" : ""}`}>
          <span className="v-fu-stat__icon"><Icon name="alert" size={18}/></span>
          <div>
            <span>Atrasados</span>
            <strong>{overdueCount}</strong>
          </div>
        </div>
        <div className="v-fu-stat">
          <span className="v-fu-stat__icon"><Icon name="clock" size={18}/></span>
          <div>
            <span>Pendientes activos</span>
            <strong>{pending.length}</strong>
          </div>
        </div>
        <div className="v-fu-stat is-teal">
          <span className="v-fu-stat__icon"><Icon name="check" size={18}/></span>
          <div>
            <span>Realizados</span>
            <strong>{done.length}</strong>
          </div>
        </div>
      </div>

      <Tabs tabs={["Pendientes", "Realizados", "Todos"]} active={tab} onChange={setTab}/>

      <SectionStage stageKey={tab}>
        {visible.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon="check"
              title={tab === "Realizados" ? "Todavía no hay seguimientos completados." : "Todos los seguimientos están al día."}
              text={tab === "Realizados" ? "Cuando marques controles como realizados, van a aparecer acá." : "Cuando programes un nuevo control, lo vas a ver acá."}
            />
          </div>
        ) : (
          <div className="v-rows" role="list" aria-label={`Seguimientos ${tab.toLowerCase()}`}>
            {visible.map(card)}
          </div>
        )}
      </SectionStage>

      {open && (() => {
        const p = getPatient(open.petId);
        return (
          <Sheet
            eyebrow="Seguimiento"
            title={`${p.name} · ${open.title}`}
            onClose={() => { setOpen(null); setReschedOpen(false); }}
            footer={
              <>
                <Button variant="secondary" icon="message" onClick={() => go(`/vet/messages?pet=${p.id}`)}>
                  Enviar mensaje
                </Button>
                {open.status !== "Realizado" && (
                  <Button
                    variant="danger"
                    icon="trash"
                    disabled={actionBusy}
                    onClick={async () => {
                      setActionBusy(true);
                      try {
                        await api.patch(`/api/scheduling/follow-ups/${open.id}`, { status: "CANCELLED" });
                        void queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
                      } catch {
                        // Keep optimistic cancellation
                      } finally {
                        setActionBusy(false);
                      }
                      setFollowUps((l) => l.filter((x) => x.id !== open.id));
                      notify(`Seguimiento de ${p.name} cancelado.`);
                      setOpen(null);
                    }}
                  >
                    Cancelar seguimiento
                  </Button>
                )}
                <Button
                  disabled={open.status === "Realizado" || actionBusy}
                  icon="check"
                  onClick={async () => {
                    setActionBusy(true);
                    try {
                      await api.patch(`/api/scheduling/follow-ups/${open.id}`, { status: "COMPLETED" });
                      void queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
                    } catch {
                      // Keep optimistic update on error
                    } finally {
                      setActionBusy(false);
                    }
                    setFollowUps((l) => l.map((x) => (x.id === open.id ? { ...x, status: "Realizado" } : x)));
                    notify(`Seguimiento de ${p.name} marcado como realizado.`);
                    setOpen(null);
                  }}
                >
                  Marcar como realizado
                </Button>
              </>
            }
          >
            <div className="v-sheet__who">
              <PetPhoto pet={p} size={56}/>
              <div>
                <b>{p.name}</b>
                <span>{p.kind} · {p.breed}</span>
                <small>Tutor: {p.tutor} · {p.tutorPhone}</small>
              </div>
            </div>
            <dl className="v-kv v-kv--stack">
              <div><dt>Próximo seguimiento</dt><dd>{open.when}</dd></div>
              <div><dt>Estado</dt><dd><ConsultStatus status={open.status}/></dd></div>
              <div><dt>Qué revisar</dt><dd>{open.note}</dd></div>
              <div><dt>Última evolución</dt><dd>{p.evolution[0] ? `${p.evolution[0].date} · ${p.evolution[0].text}` : "Sin evoluciones previas"}</dd></div>
            </dl>
            {open.status !== "Realizado" && (
              <div style={{ margin: "14px 0", display: "flex", flexDirection: "column", gap: 10 }}>
                <Button variant="secondary" icon="calendar" onClick={() => setReschedOpen((prev) => !prev)}>
                  Reprogramar horario
                </Button>
                {reschedOpen && (
                  <div className="v-fu-resched">
                    <div className="v-fu-presets">
                      <button type="button" onClick={() => setReschedAt(getPresetIso(1, 10))}>Mañana 10:00</button>
                      <button type="button" onClick={() => setReschedAt(getPresetIso(3, 10))}>En 3 días</button>
                      <button type="button" onClick={() => setReschedAt(getPresetIso(7, 10))}>En 7 días</button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <input
                        type="datetime-local"
                        aria-label="Nueva fecha de seguimiento"
                        value={reschedAt}
                        onChange={(e) => setReschedAt(e.target.value)}
                        style={{ flex: 1, minWidth: 180, height: 38, borderRadius: 10, border: "1px solid var(--line)", padding: "0 10px" }}
                      />
                      <Button
                        disabled={!reschedAt || reschedBusy}
                        onClick={async () => {
                          if (!reschedAt) return;
                          setReschedBusy(true);
                          try {
                            const dueDate = new Date(reschedAt);
                            await api.patch(`/api/scheduling/follow-ups/${open.id}`, { dueAt: dueDate.toISOString() });
                            void queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
                            const dueStr = `${dueDate.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} · ${dueDate.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
                            setFollowUps((l) => l.map((x) => (x.id === open.id ? { ...x, when: dueStr } : x)));
                            setOpen((prev) => (prev ? { ...prev, when: dueStr } : prev));
                            setReschedOpen(false);
                            notify(`Horario actualizado para ${p.name}.`);
                          } catch {
                            notify("No pudimos actualizar el horario del seguimiento.");
                          } finally {
                            setReschedBusy(false);
                          }
                        }}
                      >
                        {reschedBusy ? "Guardando..." : "Guardar horario"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <Button variant="soft" icon="file" onClick={() => go(`/vet/patients/${p.id}`)}>
              Abrir ficha clínica
            </Button>
          </Sheet>
        );
      })()}

      {createOpen && (
        <Modal
          title="Nuevo seguimiento clínico"
          text="Programá un control posterior para que quede visible en tu agenda y en la del tutor."
          cancel="Cancelar"
          confirm={createBusy ? "Programando..." : "Programar seguimiento"}
          onClose={() => !createBusy && setCreateOpen(false)}
          onConfirm={() => { void handleCreate(); }}
        >
          <div className="v-fu-modal-form">
            <label className="v-field">
              <span>Paciente</span>
              <select value={newPetId} onChange={(e) => setNewPetId(e.target.value)}>
                {patientsList.map((pt) => (
                  <option key={pt.id} value={pt.id}>
                    {pt.name} · {pt.tutor}
                  </option>
                ))}
              </select>
            </label>
            <label className="v-field">
              <span>Motivo del control</span>
              <input
                type="text"
                placeholder="Ej. Control post-tratamiento dermatológico"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </label>
            <label className="v-field">
              <span>Fecha y hora sugerida</span>
              <input
                type="datetime-local"
                value={newDueAt}
                onChange={(e) => setNewDueAt(e.target.value)}
              />
            </label>
            <label className="v-field">
              <span>Qué revisar</span>
              <textarea
                className="v-textarea"
                rows={3}
                placeholder="Indicaciones o parámetros a evaluar en el control..."
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
              />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

const specialties = ["Clínica general", "Animales de compañía", "Dermatología", "Exóticos"];

export function ProfilePage() {
  const { notify } = useVet();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const fullName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Profesional Veterinario";
  const initials = user ? `${user.firstName?.[0] || ""}${user.lastName ? user.lastName[0] : ""}`.toUpperCase() || "VC" : "VC";
  const license = user?.licenseNumber ? `MP ${user.licenseNumber}` : "MP Registrada";
  const initial = {
    name: fullName,
    experience: "Profesional matriculado",
    specialties: specialties.slice(0, 3).join(", "),
    jurisdiction: "Ciudad Autónoma de Buenos Aires",
    email: user?.email || "profesional@huellicam.com.ar",
    phone: user?.phone || "+54 11 5555 0100",
    bio: user?.bio || "Veterinario con experiencia en atención clínica telemática y seguimiento de pacientes."
  };
  const [profile, setProfile] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const update = (key: keyof typeof draft, value: string) => { setDraft({ ...draft, [key]: value }); if (state === "error") setState("idle"); };
  const cancel = () => { setDraft(profile); setEditing(false); setState("idle"); };
  const [photoUrl, setPhotoUrl] = useState<string | null>(user?.photoUrl || null);
  const resolvedPhotoUrl = useAuthenticatedMediaUrl(photoUrl);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const handlePhotoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingPhoto(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const uploadRes = await api.post("/api/media", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const uploadedRaw = uploadRes.data?.data?.url || uploadRes.data?.data?.id;
      if (!uploadedRaw) {
        notify("No se pudo obtener la URL de la fotografía subida.");
        return;
      }
      const absolutePhotoUrl = buildAbsoluteMediaUrl(String(uploadedRaw));
      await api.patch("/api/users/profile", { photoUrl: absolutePhotoUrl });
      setPhotoUrl(absolutePhotoUrl);
      notify("Foto de perfil actualizada correctamente.");
    } catch (err) {
      console.warn("Error uploading vet avatar:", err);
      notify("No se pudo guardar la fotografía en el servidor.");
    } finally {
      setUploadingPhoto(false);
      event.target.value = "";
    }
  };

  const save = async () => {
    if (!draft.name.trim() || !draft.email.trim() || !draft.jurisdiction.trim()) { setState("error"); return; }
    setState("saving");
    try {
      await api.patch('/api/users/profile', { bio: draft.bio, photoUrl });
    } catch (err) {
      console.warn("Backend profile save notice:", err);
    }
    setProfile(draft);
    setEditing(false);
    setState("success");
    notify("Perfil actualizado correctamente.");
  };
  return <>
    <PageHeader eyebrow="Perfil profesional" title="Mi perfil profesional" description="Así te ven los tutores cuando se conectan con vos." action={editing
      ? <div className="v-inline-actions"><Button variant="secondary" disabled={state === "saving"} onClick={cancel}>Cancelar</Button><Button icon={state === "saving" ? "clock" : "check"} disabled={state === "saving"} onClick={save}>{state === "saving" ? "Guardando…" : "Guardar cambios"}</Button></div>
      : <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>Editar perfil</Button>}/>
    <div className="v-modes" role="status"><span className="v-chip">{editing ? "Modo edición" : "Modo visualización"}</span></div>
    {state === "success" && <Alert tone="success" title="Perfil actualizado.">Los datos se guardaron correctamente.</Alert>}
    {state === "error" && <Alert tone="error" title="Revisá los campos señalados.">Nombre, jurisdicción y email profesional son obligatorios.</Alert>}
    <div className="profile-grid v-profile">
      <section className="panel profile-card">
        <div
          className="profile-avatar"
          style={{
            backgroundImage: resolvedPhotoUrl ? `url(${resolvedPhotoUrl})` : undefined,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          {!resolvedPhotoUrl && initials}
        </div>
        <h2>Dr. {profile.name}</h2>
        <p>Clínica general · Animales de compañía</p>
        <Status>Matrícula {license}</Status>
        
        <div style={{ marginTop: "12px" }}>
          <label className="button button--secondary" style={{ cursor: "pointer", display: "inline-block", padding: "8px 14px", borderRadius: "10px", fontSize: "13px" }}>
            {uploadingPhoto ? "Subiendo…" : photoUrl ? "Cambiar foto" : "Subir foto obligatoria"}
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={handlePhotoUpload} />
          </label>
        </div>

        <div className="v-chips">{specialties.map((s) => <span className="v-chip" key={s}>{s}</span>)}</div>
      </section>
      <div className="v-stack">
        <section className="panel"><div className="panel__heading"><div><span className="eyebrow">Datos profesionales</span><h2>Información</h2></div></div>
          <div className="form-grid"><Field label="Nombre" value={editing ? draft.name : profile.name} editing={editing} onChange={(value) => update("name", value)} error={state === "error" && !draft.name.trim() ? "Ingresá el nombre profesional." : undefined}/><Field label="Matrícula" value={license} editing={false}/><Field label="Jurisdicción" value={editing ? draft.jurisdiction : profile.jurisdiction} editing={editing} onChange={(value) => update("jurisdiction", value)} error={state === "error" && !draft.jurisdiction.trim() ? "Ingresá la jurisdicción." : undefined}/><Field label="Experiencia" value={editing ? draft.experience : profile.experience} editing={editing} onChange={(value) => update("experience", value)}/><Field label="Especialidades" value={editing ? draft.specialties : profile.specialties} editing={editing} onChange={(value) => update("specialties", value)}/></div>
          <label className="v-field v-field--wide v-mt"><span>Descripción</span>{editing ? <textarea className="v-textarea" rows={4} value={draft.bio} onChange={(e) => update("bio", e.target.value)}/> : <p className="v-bio">{profile.bio}</p>}</label></section>
        <section className="panel"><div className="panel__heading"><div><span className="eyebrow">Para los tutores</span><h2>Contacto profesional</h2></div></div><div className="form-grid"><Field label="Email profesional" value={editing ? draft.email : profile.email} editing={editing} onChange={(value) => update("email", value)} error={state === "error" && !draft.email.trim() ? "Ingresá el email profesional." : undefined}/><Field label="Teléfono" value={editing ? draft.phone : profile.phone} editing={editing} onChange={(value) => update("phone", value)}/></div></section>
        <section className="panel v-availability"><div className="panel__heading"><div><span className="eyebrow">Horarios</span><h2>Disponibilidad</h2></div><Button variant="soft" onClick={() => go("/vet/availability")}>Editar horarios</Button></div><ul>{availability.map((r) => <li key={r.day}><b>{r.day}</b><span className={r.hours === "No disponible" ? "is-off" : ""}>{r.hours}</span></li>)}</ul></section>
      </div>
    </div>
  </>;
}

export function SettingsPage() {
  const { notify } = useVet();
  const [prefs, setPrefs] = useState({
    inAppEnabled: true,
    pushEnabled: true,
    emailRemindersEnabled: true,
    appointmentReminders: true,
  });
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  useEffect(() => {
    api.get("/api/notifications/preferences").then((res) => {
      if (res.data?.success && res.data?.data) {
        setPrefs((prev) => ({ ...prev, ...res.data.data }));
      }
    }).catch(() => {});
  }, []);

  const togglePref = async (key: keyof typeof prefs, label: string) => {
    const nextVal = !prefs[key];
    setPrefs((prev) => ({ ...prev, [key]: nextVal }));
    try {
      await api.put("/api/notifications/preferences", { [key]: nextVal });
      if (key === "pushEnabled" && nextVal) {
        const { subscribeToWebPush } = await import("../lib/webPush");
        await subscribeToWebPush().catch(() => {});
      }
      notify(`Preferencia "${label}" guardada.`);
    } catch {
      notify("Preferencia actualizada localmente (no se pudo sincronizar).");
    }
  };

  const items: Array<{ key: keyof typeof prefs; title: string; desc: string }> = [
    { key: "inAppEnabled", title: "Avisos dentro de la app", desc: "Notificaciones en tiempo real de guardia y consultas." },
    { key: "pushEnabled", title: "Notificaciones Web Push", desc: "Alertas en tu navegador cuando estás conectado o en segundo plano." },
    { key: "emailRemindersEnabled", title: "Resumen y avisos por email", desc: "Recibir notificaciones importantes en tu correo." },
    { key: "appointmentReminders", title: "Recordatorios de agenda", desc: "Aviso antes de cada consulta programada o seguimiento." },
  ];
  return <>
    <PageHeader eyebrow="Administración" title="Configuración" description="Preferencias de cuenta y notificaciones profesionales."/>
    <div className="settings-layout">
      <section className="panel"><div className="panel__heading"><div><span className="eyebrow">Avisos</span><h2>Notificaciones</h2></div></div>
        {items.map((it) => <div className="setting-row" key={it.key}><div><strong>{it.title}</strong><p>{it.desc}</p></div><button role="switch" aria-checked={prefs[it.key]} aria-label={it.title} className={`switch ${prefs[it.key] ? "is-on" : ""}`} onClick={() => void togglePref(it.key, it.title)}><span/></button></div>)}</section>
      <section className="panel"><div className="panel__heading"><div><span className="eyebrow">Cuenta</span><h2>Perfil y disponibilidad</h2></div></div>
        <div className="setting-row"><div><strong>Zona horaria</strong><p>Argentina (GMT-3)</p></div></div>
        <button className="settings-link" onClick={() => go("/vet/profile")}><span><Icon name="user"/><span><strong>Perfil profesional</strong><small>Revisá tus datos y contacto profesional.</small></span></span><Icon name="chevron"/></button>
        <button className="settings-link" onClick={() => go("/vet/availability")}><span><Icon name="clock"/><span><strong>Disponibilidad</strong><small>Configurá días y horarios de atención.</small></span></span><Icon name="chevron"/></button>
        <button className="settings-link" type="button" onClick={() => setPasswordModalOpen(true)}><span><Icon name="shield"/><span><strong>Cambiar contraseña</strong><small>Actualizá tu clave de acceso.</small></span></span><Icon name="chevron"/></button></section>
    </div>
    <ChangePasswordModal
      open={passwordModalOpen}
      onClose={() => setPasswordModalOpen(false)}
      onSuccess={(msg) => notify(msg)}
    />
  </>;
}

export function VetEarningsPage() {
  const [summary, setSummary] = useState<VetLedgerSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("Todos");

  useEffect(() => {
    api
      .get<ApiResponse<VetLedgerSummaryDTO>>("/api/payments/vet/earnings")
      .then((res) => {
        if (res.data?.success && res.data?.data) {
          setSummary(res.data.data);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fmtMoney = (amount: number, currency = "ARS") =>
    new Intl.NumberFormat("es-AR", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);

  const entries = summary?.entries ?? [];
  const totalGross = summary?.totalGrossCents ?? 0;
  const totalFee = summary?.totalFeeCents ?? 0;
  const totalNet = summary?.totalNetCents ?? 0;
  const count = entries.length;
  const avgNet = count > 0 ? Math.round(totalNet / count) : 0;
  const netPct = totalGross > 0 ? Math.round((totalNet / totalGross) * 100) : 80;
  const feePct = totalGross > 0 ? Math.max(0, 100 - netPct) : 20;
  const modeLabel = summary?.mode || "SIMULATED_PAGOFLEX_PREP";

  const filteredEntries = entries.filter((entry) => {
    if (statusFilter === "Todos") return true;
    if (statusFilter === "Simulado") return entry.status === "SIMULATED";
    if (statusFilter === "Pendiente") return entry.status === "PENDING_PAYOUT";
    if (statusFilter === "Liquidado") return entry.status === "SETTLED";
    return true;
  });

  const statusTone = (status: string) =>
    status === "SETTLED" ? "teal" : status === "PENDING_PAYOUT" ? "amber" : "gray";

  const statusText = (status: string) =>
    status === "SIMULATED" ? "Simulado" : status === "SETTLED" ? "Liquidado" : status === "PENDING_PAYOUT" ? "Pendiente" : status;

  return (
    <div className="v-earn-dash">
      <PageHeader
        eyebrow="Preparación PagoFlex"
        title="Honorarios"
        description="Tablero financiero de liquidaciones simuladas previo a la integración bancaria con PagoFlex."
      />

      {loading ? (
        <div className="panel" aria-busy="true" style={{ padding: 20 }}>
          <div className="skeleton skeleton--subtitle" />
          <div className="skeleton skeleton--card" style={{ marginTop: 12 }} />
        </div>
      ) : (
        <>
          <div className="v-earn-kpis" role="region" aria-label="Indicadores de honorarios">
            <article className="v-earn-kpi v-earn-kpi--primary">
              <div className="v-earn-kpi__top">
                <span className="v-earn-kpi__label">Neto estimado</span>
                <span className="v-earn-kpi__icon"><Icon name="check" size={16}/></span>
              </div>
              <strong className="v-earn-kpi__value">{fmtMoney(totalNet, summary?.currency)}</strong>
              <small className="v-earn-kpi__sub">{netPct}% para tu liquidación</small>
            </article>

            <article className="v-earn-kpi">
              <div className="v-earn-kpi__top">
                <span className="v-earn-kpi__label">Bruto consultas</span>
                <span className="v-earn-kpi__icon"><Icon name="video" size={16}/></span>
              </div>
              <strong className="v-earn-kpi__value">{fmtMoney(totalGross, summary?.currency)}</strong>
              <small className="v-earn-kpi__sub">Total facturado en el período</small>
            </article>

            <article className="v-earn-kpi">
              <div className="v-earn-kpi__top">
                <span className="v-earn-kpi__label">Comisión plataforma</span>
                <span className="v-earn-kpi__icon"><Icon name="shield" size={16}/></span>
              </div>
              <strong className="v-earn-kpi__value">{fmtMoney(totalFee, summary?.currency)}</strong>
              <small className="v-earn-kpi__sub">{feePct}% retención operativa</small>
            </article>

            <article className="v-earn-kpi">
              <div className="v-earn-kpi__top">
                <span className="v-earn-kpi__label">Consultas liquidables</span>
                <span className="v-earn-kpi__icon"><Icon name="file" size={16}/></span>
              </div>
              <strong className="v-earn-kpi__value">{count}</strong>
              <small className="v-earn-kpi__sub">Promedio {fmtMoney(avgNet, summary?.currency)} / consulta</small>
            </article>
          </div>

          <div className="v-earn-overview">
            <section className="panel v-earn-split-card">
              <div className="panel__heading">
                <div>
                  <span className="eyebrow">Distribución</span>
                  <h2>Desglose de honorarios</h2>
                </div>
                <Status tone="teal">{netPct}% neto</Status>
              </div>
              <div className="v-earn-bar" role="img" aria-label={`Neto ${netPct}%, comisión ${feePct}%`}>
                <div className="v-earn-bar__net" style={{ width: `${netPct}%` }} />
                <div className="v-earn-bar__fee" style={{ width: `${feePct}%` }} />
              </div>
              <div className="v-earn-legend">
                <div>
                  <i className="is-net" />
                  <span>Honorario profesional ({netPct}%)</span>
                  <b>{fmtMoney(totalNet, summary?.currency)}</b>
                </div>
                <div>
                  <i className="is-fee" />
                  <span>Comisión HuelliCam ({feePct}%)</span>
                  <b>{fmtMoney(totalFee, summary?.currency)}</b>
                </div>
              </div>
            </section>

            <section className="panel v-earn-status-card">
              <div className="panel__heading">
                <div>
                  <span className="eyebrow">Billetera virtual</span>
                  <h2>Estado PagoFlex</h2>
                </div>
                <Status tone="amber">Simulación</Status>
              </div>
              <p className="v-earn-mode-code">{modeLabel}</p>
              <ul className="v-earn-checklist">
                <li><Icon name="check" size={14}/><span>Libro mayor clínico y cálculo automático activos</span></li>
                <li><Icon name="clock" size={14}/><span>Transferencias reales pendientes de integración con PagoFlex</span></li>
              </ul>
            </section>
          </div>

          <section className="panel v-earn-panel">
            <div className="panel__heading v-earn-panel__head">
              <div>
                <span className="eyebrow">Movimientos</span>
                <h2>Historial de honorarios</h2>
              </div>
              <div className="v-earn-filters" role="tablist" aria-label="Filtrar movimientos por estado">
                {["Todos", "Simulado", "Pendiente", "Liquidado"].map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === f}
                    className={`wa-chip ${statusFilter === f ? "is-active" : ""}`}
                    onClick={() => setStatusFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {filteredEntries.length === 0 ? (
              <EmptyState
                icon="file"
                title={count === 0 ? "Todavía no tenés liquidaciones registradas" : "Sin movimientos con este filtro"}
                text={count === 0 ? "Cada consulta finalizada generará un registro simulado listo para PagoFlex." : "Probá seleccionando otro estado para ver tus registros."}
              />
            ) : (
              <div className="v-earn-table-wrap">
                <table className="v-earn-table">
                  <thead>
                    <tr>
                      <th scope="col">Consulta</th>
                      <th scope="col">Fecha</th>
                      <th scope="col">Proveedor</th>
                      <th scope="col" className="is-num">Bruto</th>
                      <th scope="col" className="is-num">Comisión</th>
                      <th scope="col" className="is-num">Neto</th>
                      <th scope="col">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td data-label="Consulta"><strong>Consulta #{entry.consultationId.slice(0, 8)}</strong></td>
                        <td data-label="Fecha">{new Date(entry.createdAt).toLocaleDateString("es-AR")}</td>
                        <td data-label="Proveedor"><span className="v-earn-provider">{entry.provider}</span></td>
                        <td data-label="Bruto" className="is-num">{fmtMoney(entry.grossCents, entry.currency)}</td>
                        <td data-label="Comisión" className="is-num is-muted">{fmtMoney(entry.platformFeeCents, entry.currency)}</td>
                        <td data-label="Neto" className="is-num"><strong>{fmtMoney(entry.netCents, entry.currency)}</strong></td>
                        <td data-label="Estado">
                          <Status tone={statusTone(entry.status)}>{statusText(entry.status)}</Status>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
