import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState, Icon, PageHeader, SectionStage, Status, Tabs, go } from "../shared";
import { getPatient, type Patient } from "./data";
import { FichaClinica } from "./Consultations";
import { FilterSelect, PetPhoto, useVet } from "./vetkit";
import api from "../services/api";
import type { ApiResponse, PetDossierDTO } from "../types";
import PetDossierModal from "../components/dashboard/PetDossierModal";

const stateTone = (s: Patient["state"]) => (s === "Activo" ? "teal" : s === "En seguimiento" ? "amber" : "gray");
const stateLabel = (s: Patient["state"]) => (s === "Sin consultas recientes" ? "Atención finalizada" : s);
const PATIENTS_PAGE_SIZE = 20;

export function PatientsPage() {
  const { patientsList, consultsLoading, consultsError, refetchConsults, forceEmpty } = useVet();
  const [tab, setTab] = useState<string>("En atención y seguimiento");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("Todas");
  const [tutor, setTutor] = useState("Todos");
  const [last, setLast] = useState("Cualquiera");
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [tab, q, kind, tutor, last]);
  const base = forceEmpty ? [] : patientsList;
  const activeCount = base.filter((p) => p.state === "Activo" || p.state === "En seguimiento").length;
  const historyCount = base.filter((p) => p.state === "Sin consultas recientes").length;
  const matchesFilters = (p: Patient) =>
    (p.name + " " + p.tutor).toLowerCase().includes(q.toLowerCase()) &&
    (kind === "Todas" || p.kind === kind) &&
    (tutor === "Todos" || p.tutor === tutor) &&
    (last === "Cualquiera" ||
      (last === "Últimos 7 días"
        ? p.lastDays <= 7
        : last === "Últimos 30 días"
        ? p.lastDays <= 30
        : p.lastDays > 30));

  const tabBase =
    tab === "En atención y seguimiento"
      ? base.filter((p) => p.state === "Activo" || p.state === "En seguimiento")
      : base.filter((p) => p.state === "Sin consultas recientes");
  const otherTab = tab === "En atención y seguimiento" ? "Historial de atendidos" : "En atención y seguimiento";
  const otherMatchesCount = base
    .filter((p) =>
      otherTab === "En atención y seguimiento"
        ? p.state === "Activo" || p.state === "En seguimiento"
        : p.state === "Sin consultas recientes"
    )
    .filter(matchesFilters).length;

  const shown = tabBase.filter(matchesFilters);
  const totalPages = Math.max(1, Math.ceil(shown.length / PATIENTS_PAGE_SIZE));
  const paged = shown.slice((page - 1) * PATIENTS_PAGE_SIZE, page * PATIENTS_PAGE_SIZE);
  const filtered = q || kind !== "Todas" || tutor !== "Todos" || last !== "Cualquiera";
  return <>
    <PageHeader
      eyebrow="Historias clínicas"
      title="Pacientes"
      description={`${activeCount} en atención o seguimiento · ${historyCount} en historial finalizado.`}
    />
    <Tabs tabs={["En atención y seguimiento", "Historial de atendidos"]} active={tab} onChange={setTab}/>
    <div className="v-filters v-filters--search" role="search">
      <div className="search-field v-search"><Icon name="search" size={18}/><input aria-label="Buscar paciente o tutor" placeholder="Buscar por mascota o tutor" value={q} onChange={(e) => setQ(e.target.value)}/></div>
      <FilterSelect label="Especie" value={kind} onChange={setKind} options={["Todas", ...Array.from(new Set(base.map((p) => p.kind)))]}/>
      <FilterSelect label="Tutor" value={tutor} onChange={setTutor} options={["Todos", ...Array.from(new Set(base.map((p) => p.tutor)))]}/>
      <FilterSelect label="Última consulta" value={last} onChange={setLast} options={["Cualquiera", "Últimos 7 días", "Últimos 30 días", "Más de 30 días"]}/>
      {filtered && <button className="v-link" onClick={() => { setQ(""); setKind("Todas"); setTutor("Todos"); setLast("Cualquiera"); }}>Limpiar</button>}
    </div>
    <SectionStage stageKey={tab}>
      {!forceEmpty && consultsLoading && base.length === 0 ? (
        <div className="panel" aria-busy="true" aria-live="polite" style={{ padding: 20 }}>
          <span className="sr-only">Cargando pacientes</span>
          <div className="skeleton skeleton--subtitle" />
          <div className="skeleton skeleton--card" style={{ marginTop: 12 }} />
        </div>
      ) : !forceEmpty && consultsError && base.length === 0 ? (
        <div className="panel" role="alert">
          <EmptyState icon="alert" title="No pudimos cargar tus pacientes" text="Revisá tu conexión e intentá nuevamente." action="Reintentar" onAction={refetchConsults} />
        </div>
      ) : shown.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="paw"
            title={
              filtered
                ? "No encontramos pacientes con esos filtros."
                : tab === "En atención y seguimiento"
                ? "No tenés pacientes en atención o seguimiento."
                : "Todavía no hay pacientes en el historial finalizado."
            }
            text={
              otherMatchesCount > 0
                ? `Encontramos ${otherMatchesCount} ${otherMatchesCount === 1 ? "paciente" : "pacientes"} en "${otherTab}".`
                : filtered
                ? "Revisá la búsqueda o limpiá los filtros."
                : tab === "En atención y seguimiento"
                ? "Los pacientes con consulta finalizada y sin controles pendientes pasan automáticamente al historial."
                : "Cuando finalices consultas sin seguimientos pendientes, van a aparecer acá."
            }
            action={otherMatchesCount > 0 ? `Ver ${otherTab}` : undefined}
            onAction={otherMatchesCount > 0 ? () => setTab(otherTab) : undefined}
          />
        </div>
      ) : <>
        <div className="v-table-wrap"><table className="v-table">
          <caption className="sr-only">Pacientes asociados</caption>
          <thead><tr><th scope="col">Paciente</th><th scope="col">Especie</th><th scope="col">Tutor</th><th scope="col">Última consulta</th><th scope="col">Estado</th><th scope="col"><span className="sr-only">Acción</span></th></tr></thead>
          <tbody>{paged.map((p) => <tr key={p.id}>
            <td><div className="v-cell"><PetPhoto pet={p} size={40}/><div><b>{p.name}</b><small>{p.age} · {p.weight}</small></div></div></td>
            <td>{p.kind}<small>{p.breed}</small></td><td>{p.tutor}</td><td>{p.last}</td>
            <td><Status tone={stateTone(p.state)}>{stateLabel(p.state)}</Status></td>
            <td><Button variant="secondary" onClick={() => go(`/vet/patients/${p.id}`)}>Abrir ficha</Button></td>
          </tr>)}</tbody>
        </table></div>
        <div className="v-cards" role="list">{paged.map((p) => <article role="listitem" className="v-card" key={p.id}>
          <PetPhoto pet={p} size={56}/><div><h3>{p.name}</h3><p>{p.kind} · {p.breed}</p><small>Tutor: {p.tutor}</small><small>Última consulta: {p.last}</small></div><Status tone={stateTone(p.state)}>{stateLabel(p.state)}</Status>
          <Button variant="secondary" onClick={() => go(`/vet/patients/${p.id}`)}>Abrir ficha</Button>
        </article>)}</div>
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: 12 }}>
            <span style={{ fontSize: 13, color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>
              Página {page} de {totalPages} · {shown.length} pacientes
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

export function PatientDetail({ id }: { id: string }) {
  const basePatient = getPatient(id);
  const [dossierOpen, setDossierOpen] = useState(false);
  const dossierQuery = useQuery({
    queryKey: ['pet-dossier', id],
    enabled: Boolean(id && id !== 'unknown'),
    queryFn: async () => {
      const res = await api.get<ApiResponse<PetDossierDTO>>(`/api/pets/${id}/dossier`);
      return res.data.success && res.data.data ? res.data.data : null;
    },
  });

  const dossier = dossierQuery.data ?? null;
  const p: Patient = dossier
    ? {
        ...basePatient,
        name: dossier.pet.name || basePatient.name,
        kind: dossier.pet.species || basePatient.kind,
        breed: dossier.pet.breed || basePatient.breed,
        weight: dossier.pet.weightKg != null ? `${dossier.pet.weightKg} kg` : basePatient.weight,
        sex: dossier.pet.sex || basePatient.sex,
        chip: dossier.pet.microchip || basePatient.chip,
        photo: dossier.pet.photoUrl || basePatient.photo,
        tutor: dossier.pet.owner
          ? `${dossier.pet.owner.firstName} ${dossier.pet.owner.lastName}`.trim()
          : basePatient.tutor,
        tutorPhone: dossier.pet.owner?.phone || basePatient.tutorPhone,
        tutorEmail: dossier.pet.owner?.email || basePatient.tutorEmail,
        vaccines: dossier.vaccines.map((v) => ({
          name: v.name,
          date: new Date(v.appliedAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }),
          next: v.nextDueAt ? new Date(v.nextDueAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }) : "Sin fecha",
          state: v.status === "VENCIDA" ? "Vencida" : v.status === "PROXIMA" ? "Próxima" : "Al día",
        })),
        docs: dossier.documents.map((d) => ({
          name: d.title,
          kind: d.category,
          date: new Date(d.createdAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }),
          size: `${Math.max(1, Math.round(d.sizeBytes / 1024))} KB`,
        })),
        evolution: dossier.evolutions.map((e) => ({
          date: new Date(e.createdAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }),
          time: new Date(e.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
          author: e.vetName || "Profesional Veterinario",
          text: e.diagnosis ? `${e.diagnosis} — ${e.summary}` : e.summary,
        })),
        past: dossier.consultations.map((c) => ({
          date: new Date(c.startedAt || c.createdAt).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" }),
          title: c.status,
          note: c.notes || "Consulta registrada",
        })),
      }
    : basePatient;

  return <>
    <button className="back-link" onClick={() => go("/vet/patients")}><Icon name="arrow" size={17}/> Volver a pacientes</button>
    <section className="v-case v-case--patient">
      <PetPhoto pet={p} size={72}/>
      <div className="v-case__who"><span className="eyebrow">Ficha clínica</span><h1>{p.name}</h1><p>{p.kind} · {p.breed} · {p.age}</p></div>
      <div className="v-case__cell"><span className="v-label">Tutor</span><b>{p.tutor}</b><small>{p.tutorPhone}</small></div>
      <div className="v-case__cell"><span className="v-label">Última consulta</span><b>{p.last}</b><Status tone={stateTone(p.state)}>{stateLabel(p.state)}</Status></div>
      <div className="v-case__actions">
        <Button variant="secondary" icon="file" onClick={() => setDossierOpen(true)}>Exportar PDF</Button>
        <Button variant="secondary" icon="message" onClick={() => go(`/vet/messages?pet=${p.id}`)}>Mensaje</Button>
        <Button icon="pill" onClick={() => go(`/vet/prescriptions/new?pet=${p.id}`)}>Nueva receta</Button>
      </div>
    </section>
    <section className="panel v-panel-flush"><FichaClinica p={p} showEvolution/></section>
    <PetDossierModal
      pet={dossier?.pet ?? null}
      dossier={dossier}
      isOpen={dossierOpen}
      onClose={() => setDossierOpen(false)}
    />
  </>;
}
