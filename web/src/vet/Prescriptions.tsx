import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, Icon, Modal, PageHeader, SectionStage, Tabs, go } from "../shared";
import api from "../services/api";
import { useAuth } from "../context/AuthContext";
import { isReactNativeWebView } from "../lib/mobileBridge";
import type { ApiResponse, ClinicalTemplateDTO, Consultation as BackendConsultation, Prescription as BackendPrescription } from "../types";
import { getPatient, registerPatient, type Rx } from "./data";
import { mapBackendPetToPatient } from "./mappers";
import { ConsultStatus, PetPhoto, useVet } from "./vetkit";
import { formatDateAR } from "../lib/formatters";

type BackendPrescriptionWithConsultation = BackendPrescription & {
  consultation?: BackendConsultation;
};

function mapBackendRxToVetRx(item: BackendPrescriptionWithConsultation): Rx {
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
    date: item.createdAt ? formatDateAR(item.createdAt) : "Hoy",
    qrCodeDataUrl: item.qrCodeDataUrl,
    verifyUrl: item.signedVerifyUrl || item.verifyUrl,
  };
}

const RX_PAGE_SIZE = 20;

export function PrescriptionsPage() {
  const { rx, rxLoading, rxError, refetchRx, forceEmpty } = useVet();
  const { user } = useAuth();
  const vetName = user ? (user.lastName ? `Dr. ${user.firstName} ${user.lastName}` : (user.firstName ? `Dr. ${user.firstName}` : "Profesional")) : "Profesional";
  const [tab, setTab] = useState("Todas");
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [tab]);
  const shown = rx.filter((r) => tab === "Todas" || (tab === "Emitidas" ? r.status === "Emitida" : tab === "Borradores" ? r.status === "Borrador" : r.status === "Finalizada"));
  const totalPages = Math.max(1, Math.ceil(shown.length / RX_PAGE_SIZE));
  const paged = shown.slice((page - 1) * RX_PAGE_SIZE, page * RX_PAGE_SIZE);
  return <>
    <PageHeader eyebrow="Indicaciones médicas" title="Recetas" description="Recetas emitidas y borradores en preparación." action={<Button icon="plus" onClick={() => go("/vet/prescriptions/new")}>Nueva receta</Button>}/>
    <Tabs tabs={["Todas", "Emitidas", "Borradores", "Finalizadas"]} active={tab} onChange={setTab}/>
    <SectionStage stageKey={tab}>
    {!forceEmpty && rxLoading && rx.length === 0 ? (
      <div className="panel" aria-busy="true" aria-live="polite" style={{ padding: 20 }}>
        <span className="sr-only">Cargando recetas</span>
        <div className="skeleton skeleton--subtitle" />
        <div className="skeleton skeleton--card" style={{ marginTop: 12 }} />
      </div>
    ) : !forceEmpty && rxError && rx.length === 0 ? (
      <div className="panel" role="alert">
        <EmptyState icon="alert" title="No pudimos cargar las recetas" text="Revisá tu conexión e intentá nuevamente." action="Reintentar" onAction={refetchRx} />
      </div>
    ) : shown.length === 0 ? <div className="panel"><EmptyState icon="file" title="No hay recetas para mostrar." text="Las recetas que emitas o guardes como borrador aparecerán acá."/></div> : <>
      <div className="v-rows" role="list">{paged.map((r) => { const p = getPatient(r.petId); return <article role="listitem" className="v-row v-row--rx" key={r.id}>
        <div className="v-row__time"><b>{r.id.slice(-4)}</b><span>{r.date}</span></div>
        <PetPhoto pet={p} size={44}/>
        <div className="v-row__main"><h3>{r.med} <small>{p.name}</small></h3><p>{r.dose} · {r.freq} · {r.duration}</p><small>Tutor: {p.tutor} · {vetName} · {r.id}</small></div>
        <span className="v-row__meta"/>
        <ConsultStatus status={r.status}/>
        <Button variant="secondary" onClick={() => go(r.status === "Borrador" ? `/vet/prescriptions/new?draft=${r.id}` : `/vet/prescriptions/${r.id}`)}>{r.status === "Borrador" ? "Continuar borrador" : "Ver receta"}</Button>
      </article>; })}</div>
      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>
            Página {page} de {totalPages} · {shown.length} recetas
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((v) => Math.max(1, v - 1))}>Anterior</Button>
            <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((v) => Math.min(totalPages, v + 1))}>Siguiente</Button>
          </div>
        </div>
      )}
    </>}
    </SectionStage>
  </>;
}

type Form = { pet: string; med: string; dose: string; freq: string; duration: string; notes: string };
const required: (keyof Form)[] = ["pet", "med", "dose", "freq", "duration"];
const labels: Record<keyof Form, string> = { pet: "Paciente", med: "Medicamento", dose: "Dosis", freq: "Frecuencia", duration: "Duración", notes: "Indicaciones" };

export function NewPrescription() {
  const queryClient = useQueryClient();
  const { rx, setRx, notify, consults, patientsList } = useVet();
  const params = new URLSearchParams(window.location.search);
  const draft = rx.find((r) => r.id === params.get("draft"));
  const [f, setF] = useState<Form>(draft ? { pet: draft.petId, med: draft.med, dose: draft.dose, freq: draft.freq, duration: draft.duration, notes: draft.notes } : { pet: params.get("pet") ?? "", med: "", dose: "", freq: "", duration: "", notes: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [confirm, setConfirm] = useState(false);
  const [rxTemplates, setRxTemplates] = useState<ClinicalTemplateDTO[]>([]);
  const [savingTpl, setSavingTpl] = useState(false);
  const availablePatients = patientsList;

  useEffect(() => {
    api.get<ApiResponse<ClinicalTemplateDTO[]>>("/api/templates?kind=PRESCRIPTION")
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.data)) {
          setRxTemplates(res.data.data);
        }
      })
      .catch(() => {});
  }, []);

  const applyRxTemplate = (tpl: ClinicalTemplateDTO) => {
    const c = tpl.content || {};
    setF((prev) => ({
      ...prev,
      med: typeof c.medication === "string" ? c.medication : prev.med,
      dose: typeof c.dosage === "string" ? c.dosage : prev.dose,
      freq: typeof c.frequency === "string" ? c.frequency : prev.freq,
      duration: c.durationDays ? `${c.durationDays} días` : prev.duration,
      notes: typeof c.indications === "string" ? c.indications : prev.notes,
    }));
    setErrors({});
  };

  const handleSaveRxTemplate = async () => {
    if (!f.med.trim()) return;
    setSavingTpl(true);
    try {
      const durationMatch = f.duration.match(/\d+/);
      const durationDays = durationMatch ? parseInt(durationMatch[0], 10) : 7;
      const res = await api.post<ApiResponse<ClinicalTemplateDTO>>("/api/templates", {
        kind: "PRESCRIPTION",
        title: f.med.trim(),
        category: "Receta",
        content: {
          medication: f.med.trim(),
          dosage: f.dose.trim(),
          frequency: f.freq.trim(),
          durationDays,
          indications: f.notes.trim(),
        },
      });
      if (res.data?.success && res.data.data) {
        setRxTemplates((prev) => [res.data.data!, ...prev]);
        notify("Plantilla de receta guardada.");
      }
    } catch {
      notify("No se pudo guardar la plantilla.");
    } finally {
      setSavingTpl(false);
    }
  };
  const set = (k: keyof Form, v: string) => { setF({ ...f, [k]: v }); if (errors[k]) setErrors({ ...errors, [k]: undefined }); };
  const validate = (keys: (keyof Form)[]) => { const e: typeof errors = {}; keys.forEach((k) => { if (!f[k].trim()) e[k] = `Completá ${labels[k].toLowerCase()}.`; }); setErrors(e); return Object.keys(e).length === 0; };

  const save = async (status: Rx["status"]): Promise<string | null> => {
    if (status === "Borrador") {
      const draftId = draft?.id ?? `DRAFT-${Date.now()}`;
      const entry: Rx = { id: draftId, petId: f.pet, med: f.med, dose: f.dose, freq: f.freq, duration: f.duration, notes: f.notes, status: "Borrador", date: "Hoy" };
      setRx((l) => draft ? l.map((r) => r.id === draftId ? entry : r) : [entry, ...l]);
      return draftId;
    }

    const paramConsultationId = params.get("consultationId");
    const isEligibleStatus = (status?: string) => status === "Activa" || status === "Finalizada";
    const paramMatch = paramConsultationId
      ? consults.find((c) => c.id === paramConsultationId)
      : undefined;
    const consultationId = paramConsultationId
      ? paramMatch
        ? isEligibleStatus(paramMatch.status)
          ? paramMatch.id
          : undefined
        : paramConsultationId
      : consults.find((c) => c.petId === f.pet && isEligibleStatus(c.status))?.id;
    if (!consultationId) {
      notify("Para emitir una receta oficial con QR necesitás una consulta activa o finalizada de este paciente.");
      return null;
    }

    const durationMatch = f.duration.match(/\d+/);
    const durationDays = durationMatch ? parseInt(durationMatch[0], 10) : 7;

    try {
      const res = await api.post<ApiResponse<BackendPrescriptionWithConsultation>>(
        `/api/consultations/${consultationId}/prescriptions`,
        {
          medication: f.med,
          dosage: f.dose,
          frequency: f.freq,
          durationDays: durationDays > 0 ? durationDays : 7,
          indications: f.notes.trim() || "Administrar según indicaciones profesionales.",
        }
      );

      if (!res.data.success || !res.data.data) {
        notify("No pudimos emitir la receta en el servidor.");
        return null;
      }

      const createdRx = mapBackendRxToVetRx(res.data.data);
      setRx((list) => {
        const withoutDraft = draft ? list.filter((item) => item.id !== draft.id) : list;
        return [createdRx, ...withoutDraft.filter((item) => item.id !== createdRx.id)];
      });
      queryClient.invalidateQueries({ queryKey: ["prescriptions", "vet"] });
      return createdRx.id;
    } catch (err) {
      console.warn("Backend prescription save warning:", err);
      notify("No pudimos emitir la receta en el servidor. Verificá tu conexión.");
      return null;
    }
  };

  const p = f.pet ? getPatient(f.pet) : null;
  return <>
    <button className="back-link" onClick={() => go("/vet/prescriptions")}><Icon name="arrow" size={17}/> Volver a recetas</button>
    <PageHeader eyebrow="Indicación médica" title="Nueva receta" description="Completá los datos. Vas a poder revisarlos antes de emitir."/>
    <form className="panel v-form" noValidate onSubmit={(e) => { e.preventDefault(); if (validate(required)) setConfirm(true); }}>
      {rxTemplates.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }} aria-label="Plantillas de receta">
          {rxTemplates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="v-chip"
              style={{ cursor: "pointer", border: "1px solid var(--line, #e4dfd2)", background: "#faf8f5" }}
              onClick={() => applyRxTemplate(tpl)}
            >
              + {tpl.title}
            </button>
          ))}
        </div>
      )}
      <div className="v-form__grid">
        <label className={`v-field v-field--wide ${errors.pet ? "has-error" : ""}`}><span>Paciente</span>
          <select value={f.pet} onChange={(e) => set("pet", e.target.value)} aria-invalid={!!errors.pet}><option value="">Elegí un paciente</option>{availablePatients.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.kind} · {x.tutor}</option>)}</select>{errors.pet && <em role="alert">{errors.pet}</em>}</label>
        {p && <div className="v-form__ctx"><Icon name="alert" size={16}/><span><b>Alergias:</b> {p.allergies.join(", ")}</span><span><b>Medicación actual:</b> {p.meds.join(", ")}</span></div>}
        {(["med", "dose", "freq", "duration"] as const).map((k) => <label key={k} className={`v-field ${k === "med" ? "v-field--wide" : ""} ${errors[k] ? "has-error" : ""}`}><span>{labels[k]}</span>
          <input value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errors[k]} placeholder={{ med: "Ej.: Meloxicam 1,5 mg/ml", dose: "Ej.: 0,2 ml", freq: "Ej.: Cada 12 horas", duration: "Ej.: 5 días" }[k]}/>{errors[k] && <em role="alert">{errors[k]}</em>}</label>)}
        <label className="v-field v-field--wide"><span>Indicaciones</span><textarea className="v-textarea" rows={4} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Cómo administrar, precauciones, cuándo consultar nuevamente…"/></label>
      </div>
      <div className="v-form__bar">
        <Button variant="secondary" onClick={() => { if (validate(["pet", "med"])) { void save("Borrador"); notify("Borrador guardado en esta vista."); go("/vet/prescriptions"); } }}>Guardar borrador</Button>
        {f.med.trim() && (
          <Button variant="soft" disabled={savingTpl} onClick={handleSaveRxTemplate}>
            {savingTpl ? "Guardando..." : "Guardar plantilla"}
          </Button>
        )}
        <Button type="submit" icon="check">Emitir receta</Button>
      </div>
    </form>
    {confirm && p && <Modal title="Confirmar receta" text={`Revisá los datos antes de emitir la receta de ${f.med} para ${p.name}.`} cancel="Volver a editar" confirm="Confirmar emisión" onClose={() => setConfirm(false)} onConfirm={async () => { const id = await save("Emitida"); setConfirm(false); if (!id) return; notify("Receta emitida correctamente con QR oficial."); go(`/vet/prescriptions/${id}`); }}/>}
  </>;
}

export function PrescriptionDetail({ id }: { id: string }) {
  const { rx, setRx, notify } = useVet();
  const { user } = useAuth();
  const vetName = user ? (user.lastName ? `Dr. ${user.firstName} ${user.lastName}` : (user.firstName ? `Dr. ${user.firstName}` : "Profesional")) : "Profesional";
  const licenseStr = user?.licenseNumber ? `Clínica general · MP ${user.licenseNumber}` : "Clínica general";
  const now = new Date();
  const realDate = now.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" });
  const localMatch = rx.find((x) => x.id === id);

  const [remoteRx, setRemoteRx] = useState<Rx | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !localMatch || (localMatch.status !== "Borrador" && !localMatch.qrCodeDataUrl));

  useEffect(() => {
    if (localMatch?.status === "Borrador" || (localMatch && localMatch.qrCodeDataUrl)) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    api
      .get<ApiResponse<BackendPrescriptionWithConsultation>>(`/api/prescriptions/${id}`, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.data.success && res.data.data) {
          const mapped = mapBackendRxToVetRx(res.data.data);
          setRemoteRx(mapped);
          setRx((list) => list.some((item) => item.id === mapped.id) ? list.map((item) => item.id === mapped.id ? mapped : item) : [mapped, ...list]);
        }
      })
      .catch(() => {
        // Error handled by fallback state
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [id, localMatch?.status, localMatch?.qrCodeDataUrl, setRx]);

  const r = localMatch ?? remoteRx;
  if (loading && !r) {
    return <><button className="back-link" onClick={() => go("/vet/prescriptions")}><Icon name="arrow" size={17}/> Volver a recetas</button><div className="panel"><EmptyState icon="file" title="Cargando receta…" text="Obteniendo código QR oficial y datos de verificación."/></div></>;
  }
  if (!r) return <><button className="back-link" onClick={() => go("/vet/prescriptions")}><Icon name="arrow" size={17}/> Volver a recetas</button><div className="panel"><EmptyState icon="file" title="No encontramos esta receta." text="Puede haber sido movida o no existir."/></div></>;

  const p = getPatient(r.petId);
  const issued = r.status !== "Borrador";
  const publicVerifyPath = `/prescriptions/${r.id}`;
  const displayVerifyUrl = r.verifyUrl || publicVerifyPath;

  return <>
    <button className="back-link" onClick={() => go("/vet/prescriptions")}><Icon name="arrow" size={17}/> Volver a recetas</button>
    <div className="v-issued-head" role="status"><span><Icon name={issued ? "check" : "edit"} size={24}/></span><div><span className="eyebrow">{issued ? "Receta oficial" : "En preparación"}</span><h1>{issued ? "Receta emitida" : "Receta en borrador"}</h1><p>{issued ? `La receta de ${p.name} cuenta con código QR oficial verificable.` : "Todavía no fue emitida."}</p></div></div>
    <article className="v-rx" aria-label={`Receta ${r.id}`}>
      <header><div><span className="eyebrow">Receta veterinaria</span><h2>{r.id}</h2></div><ConsultStatus status={r.status}/></header>
      <div className="v-rx__grid">
        <div><span className="v-label">Veterinario</span><b>{vetName}</b><small>{licenseStr}</small></div>
        <div><span className="v-label">Fecha de emisión</span><b>{r.date === "Hoy" ? realDate : r.date}</b></div>
        <div><span className="v-label">Paciente</span><b>{p.name}</b><small>{p.kind} · {p.breed} · {p.weight}</small></div>
        <div><span className="v-label">Tutor</span><b>{p.tutor}</b><small>{p.tutorEmail}</small></div>
      </div>
      <div className="v-rx__med"><Icon name="pill" size={22}/><div><span className="v-label">Medicamento</span><h3>{r.med}</h3><p>{r.dose} · {r.freq} · durante {r.duration}</p></div></div>
      <div className="v-rx__notes"><span className="v-label">Indicaciones</span><p>{r.notes || "Sin indicaciones adicionales."}</p></div>
      <footer>
        {issued && r.qrCodeDataUrl ? (
          <>
            <img src={r.qrCodeDataUrl} alt={`Código QR oficial de verificación para receta ${r.id}`} className="v-qr" data-testid="vet-prescription-qr"/>
            <p>
              <b>Validación oficial para farmacia · ID {r.id}</b><br/>
              Escaneá el QR para abrir la receta verificable en <a href={displayVerifyUrl} target="_blank" rel="noreferrer">{displayVerifyUrl}</a>.
            </p>
          </>
        ) : (
          <p>
            <b>{issued ? `Receta ${r.id}` : "Borrador sin emitir"}</b><br/>
            {issued ? "No se pudo cargar la imagen del QR en este momento." : "Al emitir la receta se generará automáticamente el código QR oficial para farmacias."}
          </p>
        )}
      </footer>
    </article>
    <div className="v-inline-actions v-inline-actions--left">
      <Button variant="secondary" onClick={() => go("/vet/prescriptions")}>Volver a recetas</Button>
      {issued && (
        <Button
          variant="soft"
          icon="qr"
          onClick={() =>
            isReactNativeWebView()
              ? window.location.assign(publicVerifyPath)
              : window.open(publicVerifyPath, "_blank", "noopener,noreferrer")
          }
        >
          Abrir vista pública QR
        </Button>
      )}
      <Button variant="soft" icon="paperclip" onClick={() => { void navigator.clipboard?.writeText(issued ? displayVerifyUrl : r.id); notify(issued ? "Enlace QR copiado" : "Identificador copiado"); }}>{issued ? "Copiar enlace QR" : "Copiar identificador"}</Button>
      {!issued && <Button onClick={() => go(`/vet/prescriptions/new?draft=${r.id}`)}>Continuar borrador</Button>}
    </div>
  </>;
}
