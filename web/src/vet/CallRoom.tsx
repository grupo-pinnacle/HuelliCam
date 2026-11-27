import { memo, useEffect, useState, useRef, useCallback } from "react";
import { Drawer } from "vaul";
import "./vet.css";
import ClientScopedStyle from "../styles/ClientScopedStyle";
import { getWsUrl } from "../lib/ws";
import { WhatsAppCheck } from "../components/call/WhatsAppCheck";
import { Button, Icon, Modal, go } from "../shared";
import { getPatient, initialConsults, initialQueue, quickReplies, registerPatient, type Consult, type QueueItem, type Triage } from "./data";
import { ClinicalChatThread, type ClinicalChatDoc, type ClinicalChatMessage } from "../components/chat/ClinicalChatThread";
import { TriageBadge, VetProvider, useVet } from "./vetkit";
import { EvolutionEditor, FichaClinica } from "./Consultations";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../context/SocketContext";
import { LIVEKIT_ROOM_OPTIONS } from "../lib/livekitConfig";
import api from "../services/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiResponse, Consultation as BackendConsultation } from "../types";
import { mapBackendPetToPatient } from "./mappers";
import { LiveKitRoom, VideoConference, useLocalParticipant } from "@livekit/components-react";
import "@livekit/components-styles";
import { ReviewModal } from "../components/ui/ReviewModal";
import { HamsterMascot } from "../components/ui/HamsterMascot";
import { parseConsultationNotes } from "../lib/consultationNotes";
import { postMobileBridgeMessage } from "../lib/mobileBridge";
import { normalizeMediaUrl } from "../lib/authenticatedMedia";
import { useVisualViewport } from "../lib/useVisualViewport";
import { useIsMobileViewport } from "../lib/useIsMobileViewport";
import { prefersReducedMotion } from "../lib/motion";

const WAITING_TIPS = [
  "Habilitá la cámara y el micrófono en tu navegador para que el veterinario pueda ver y escuchar a tu mascota.",
  "Ponete cerca de una ventana o prendé una luz: con buena luz se ve mejor.",
  "Dejá a tu mascota en un lugar seguro y tené a mano su carnet de vacunas."
];

const TRIAGE_BY_TIER: Record<"ROJO" | "AMARILLO" | "VERDE", Triage> = {
  ROJO: "Crítico",
  AMARILLO: "Moderado",
  VERDE: "General"
};

const WAITING_STATUS_MSGS_CLIENT = [
  "Recibimos la historia clínica",
  "Buscando veterinario de guardia",
  "Abriendo la sala de video",
  "¡Veterinario encontrado!"
];

const WAITING_STATUS_MSGS_VET = [
  "Esperando que se empareje la llamada",
  "Abriendo la sala de video",
  "Conectando con el paciente",
  "¡Consulta lista!"
];

const HUELLICAM_LETTERS = [
  { char: "H", isTeal: false },
  { char: "u", isTeal: false },
  { char: "e", isTeal: false },
  { char: "l", isTeal: false },
  { char: "l", isTeal: false },
  { char: "i", isTeal: false },
  { char: "C", isTeal: true },
  { char: "a", isTeal: true },
  { char: "m", isTeal: true }
];

function WaitingRoomExperience({
  isVet = false,
  isReady = false,
  petName,
  tutorName,
  vetName,
  vetInitials,
  symptom,
  clock,
  waitSecs = 0,
  tierLabel,
  onBack,
  onCancel,
}: {
  isVet?: boolean;
  isReady?: boolean;
  petName?: string;
  tutorName?: string;
  vetName?: string;
  vetInitials?: string;
  symptom?: string;
  clock: string;
  waitSecs?: number;
  tierLabel?: string | null;
  onBack: () => void;
  onCancel?: () => void;
}) {
  const statusMsgs = isVet ? WAITING_STATUS_MSGS_VET : WAITING_STATUS_MSGS_CLIENT;
  const [tipIndex, setTipIndex] = useState(0);
  const [tipOut, setTipOut] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const logoRef = useRef<SVGSVGElement | null>(null);
  const wordRef = useRef<HTMLDivElement | null>(null);
  const ecgBaseRef = useRef<SVGPathElement | null>(null);
  const ecgFillRef = useRef<SVGPathElement | null>(null);
  const ecgHeadRef = useRef<SVGCircleElement | null>(null);
  const ecgHaloRef = useRef<SVGCircleElement | null>(null);

  // Logo entrance animations
  useEffect(() => {
    if (prefersReducedMotion()) {
      setIsLive(true);
      return;
    }
    const g = (id: string) => logoRef.current?.querySelector<SVGElement>(`#${id}`) || null;
    const pop = (el: SVGElement | null, delay: number, rot = 0) => {
      if (!el || typeof el.animate !== "function") return;
      el.style.transformBox = "fill-box";
      el.style.transformOrigin = "50% 50%";
      el.animate(
        [
          { opacity: 0, transform: `scale(0.9) rotate(${rot}deg)` },
          { opacity: 1, transform: `scale(1.08) rotate(${rot ? 4 : 0}deg)`, offset: 0.6 },
          { opacity: 1, transform: "none" }
        ],
        { duration: 300, delay, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" }
      );
    };

    const draw = (ids: string[], delay: number, dur: number) => {
      ids.forEach((id) => {
        const p = g(id);
        if (!p || typeof p.animate !== "function") return;
        p.style.strokeDasharray = "100 100";
        const anim = p.animate(
          [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }],
          { duration: dur, delay, easing: "cubic-bezier(.5,0,.3,1)", fill: "backwards" }
        );
        anim.onfinish = () => {
          p.style.strokeDasharray = "none";
        };
      });
    };

    draw(["tp1", "tp2"], 100, 800);
    pop(g("tipL"), 150);
    pop(g("tipR"), 800);
    pop(g("joint"), 500);
    pop(g("fill"), 250);
    pop(g("arc_top"), 380, -40);
    pop(g("tail"), 450, -40);
    pop(g("arc_right"), 520, -40);
    ["pad_t", "pad_l", "pad_r", "pad_m", "pad_b"].forEach((id, i) => pop(g(id), 620 + i * 70));
    pop(g("cam"), 980);
    draw(["cp1", "cp2"], 560, 800);
    pop(g("chest"), 1300);

    const partIds = ["arc_top", "arc_right", "tail", "pad_t", "pad_l", "pad_r", "pad_m", "pad_b", "cam", "tipL", "tipR", "chest"];
    partIds.forEach((id) => {
      const e = g(id);
      if (e) {
        e.style.transformBox = "fill-box";
        e.style.transformOrigin = "50% 50%";
      }
    });

    const liveTimer = window.setTimeout(() => setIsLive(true), 1900);
    return () => window.clearTimeout(liveTimer);
  }, []);

  // Cycle animation for word and mascot
  const triggerCycle = useCallback(() => {
    const word = wordRef.current;
    if (!word) return;
    const letters = word.querySelectorAll<HTMLElement>(".v-wait__ch");
    const g = (id: string) => logoRef.current?.querySelector<SVGElement>(`#${id}`) || null;
    const partIds = ["arc_top", "arc_right", "tail", "pad_t", "pad_l", "pad_r", "pad_m", "pad_b", "cam", "tipL", "tipR", "chest"];
    const mascotParts = partIds.map(g).filter(Boolean) as SVGElement[];

    const jump = () => {
      if (typeof word.animate === "function") {
        word.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.18)", offset: 0.45 },
            { transform: "scale(1)" }
          ],
          { duration: 650, easing: "cubic-bezier(.3,.7,.3,1)" }
        );
      }
    };

    letters.forEach((e, i) => {
      if (typeof e.animate === "function") {
        e.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.4)", offset: 0.45 }, { transform: "scale(1)" }],
          { duration: 320, delay: i * 85, easing: "ease-out" }
        );
      }
    });

    mascotParts.forEach((e, i) => {
      if (typeof e.animate === "function") {
        e.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.1)", offset: 0.45 }, { transform: "scale(1)" }],
          { duration: 320, delay: i * 60, easing: "ease-out" }
        );
      }
    });

    window.setTimeout(jump, letters.length * 85 + 300);
  }, []);

  // Wordmark letters initial entrance (one-shot, no infinite bounce cycle)
  useEffect(() => {
    const word = wordRef.current;
    if (!word || prefersReducedMotion()) return;
    const letters = word.querySelectorAll<HTMLElement>(".v-wait__ch");

    letters.forEach((e, i) => {
      if (typeof e.animate === "function") {
        e.animate(
          [{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "scale(1.08)", offset: 0.6 }, { opacity: 1, transform: "scale(1)" }],
          { duration: 280, delay: 900 + i * 50, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" }
        );
      }
    });
  }, []);

  // Status transitions
  useEffect(() => {
    if (isReady) {
      setStatusIndex(statusMsgs.length - 1);
      return;
    }
    const t1 = window.setTimeout(() => setStatusIndex(1), 2200);
    const t2 = window.setTimeout(() => setStatusIndex(2), 6500);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [isReady, statusMsgs.length]);

  // ECG progress waveform (animates as loading bar to 100% on ready)
  useEffect(() => {
    const W = 300;
    const N = 4;
    let d = "M0 22";
    for (let i = 0; i < N; i++) {
      const s = ((i + 0.5) * W) / N - 22;
      d += ` H${s} l5 -3 l5 3 h3 l5 -17 l7 34 l7 -17 h3 l5 -3 l5 3`;
    }
    d += ` H${W}`;

    const base = ecgBaseRef.current;
    const fill = ecgFillRef.current;
    const head = ecgHeadRef.current;
    const halo = ecgHaloRef.current;

    if (!base || !fill || !head || !halo) return;

    base.setAttribute("d", d);
    fill.setAttribute("d", d);

    const len = typeof base.getTotalLength === "function" ? base.getTotalLength() : 300;
    let p = 0;
    let creep = 0;
    let animId: number;

    const frame = () => {
      let currentTarget = 0.25;
      if (isReady) {
        currentTarget = 1.0;
      } else if (statusIndex === 1) {
        currentTarget = 0.55;
      } else if (statusIndex >= 2) {
        currentTarget = 0.85;
      }

      const speed = isReady ? 0.08 : 0.035;
      p += (currentTarget + creep - p) * speed;
      if (!isReady) {
        creep = Math.min(creep + 0.0003, 0.08);
      }
      const q = Math.min(Math.max(p, 0), 1);
      fill.setAttribute("stroke-dashoffset", String(1000 * (1 - q)));

      if (typeof base.getPointAtLength === "function") {
        const pt = base.getPointAtLength(len * q);
        head.setAttribute("cx", String(pt.x));
        head.setAttribute("cy", String(pt.y));
        halo.setAttribute("cx", String(pt.x));
        halo.setAttribute("cy", String(pt.y));
      }

      animId = requestAnimationFrame(frame);
    };

    animId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animId);
  }, [isReady, statusIndex]);

  // Tips rotation (only in client mode)
  useEffect(() => {
    if (isVet) return;
    const interval = window.setInterval(() => {
      setTipOut(true);
      window.setTimeout(() => {
        setTipIndex((prev) => (prev + 1) % WAITING_TIPS.length);
        setTipOut(false);
      }, 1500);
    }, 8000);
    return () => window.clearInterval(interval);
  }, [isVet]);

  return (
    <main
      data-testid="waiting-room-experience"
      className="v-wait"
      role="region"
      aria-live="polite"
      aria-label={isVet ? "Sala de guardia veterinaria" : "Sala de espera de guardia"}
    >
      <div className="v-wait__inner">
        <header className="v-wait__header">
          <button type="button" className="v-wait__back" onClick={onBack} aria-label="Volver">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>

          {isVet ? (
            <div className="v-wait__pet" role="group" aria-label={`${vetName || "Veterinario"}, en guardia`}>
              <span className="v-wait__ava">
                <b className="v-wait__ini">{vetInitials || "DR"}</b>
                <i className="v-wait__urg ok"></i>
              </span>
              <span className="v-wait__nm">
                <b>{vetName || "Dr. Veterinario"}</b>
                <span>En guardia</span>
              </span>
            </div>
          ) : (
            <div className="v-wait__pet" role="group" aria-label={`${petName || "Mascota"}, de ${tutorName || "Tutor"}. Prioridad ${tierLabel || "general"}`}>
              <span className="v-wait__ava">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <ellipse cx="12" cy="16" rx="5.5" ry="4.5" />
                  <ellipse cx="5" cy="10.5" rx="2.2" ry="3" />
                  <ellipse cx="9.5" cy="5.5" rx="2.2" ry="3" />
                  <ellipse cx="14.5" cy="5.5" rx="2.2" ry="3" />
                  <ellipse cx="19" cy="10.5" rx="2.2" ry="3" />
                </svg>
                <i className="v-wait__urg"></i>
              </span>
              <span className="v-wait__nm">
                <b>{petName || "Mascota"}</b>
                <span>de {tutorName || "Tutor"}</span>
              </span>
            </div>
          )}

          <div className="v-wait__timer" role="timer" aria-label={isVet ? "Tiempo de guardia" : "Tiempo de espera"}>
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <circle className="v-wait__tr" cx="24" cy="24" r="21" />
              <circle
                className="v-wait__tf"
                cx="24"
                cy="24"
                r="21"
                pathLength={100}
                style={{ animationDelay: `-${(waitSecs ?? 0) % 60}s` }}
              />
            </svg>
            <span className="v-wait__clock">{clock}</span>
          </div>
        </header>

        <p className={`v-wait__reason ${isVet ? "ok" : ""}`}>
          <i></i>
          <span>
            {isVet
              ? `Guardia activa · Conectando con ${tutorName || petName || "el paciente"}`
              : (symptom || "Consulta veterinaria de guardia")}
          </span>
        </p>

        <section className="v-wait__center">
          <button
            type="button"
            className={`v-wait__mark ${isLive ? "live" : ""}`}
            onClick={triggerCycle}
            aria-label="HuelliCam interactivo"
          >
            <svg ref={logoRef} id="logo" viewBox="40 140 965 751" aria-hidden="true">
              <defs>
                <pattern id="ht" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <circle cx="4.5" cy="4.5" r="1.7" fill="#1d4a43" />
                </pattern>
                <linearGradient id="gx" x1="0" x2="1">
                  <stop offset="0" stopColor="#fff" />
                  <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
                </linearGradient>
                <mask id="mcam">
                  <rect x="715" y="335" width="180" height="165" fill="url(#gx)" />
                </mask>
                <radialGradient id="gp" cx="0.15" cy="0.95" r="0.9">
                  <stop offset="0" stopColor="#fff" />
                  <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
                <mask id="mpad">
                  <rect x="480" y="500" width="190" height="165" fill="url(#gp)" />
                </mask>
              </defs>
              <g id="fill">
                <circle cx="583" cy="495" r="255" fill="#fdf1d9" />
                <path d="M365 650L338 748L452 706Z" fill="#fdf1d9" stroke="#fdf1d9" strokeWidth="16" strokeLinejoin="round" />
              </g>
              <g id="tail" fill="none" stroke="#6aa49b" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round">
                <path pathLength={100} d="M327 578C340 610 360 635 378 655L340 745L450 703C520 735 620 735 686 702" />
              </g>
              <g id="arc_top" fill="none" stroke="#6aa49b" strokeWidth="24" strokeLinecap="round">
                <path d="M436 312C500 262 560 250 610 252C680 255 735 285 768 322" />
              </g>
              <g id="arc_right" fill="none" stroke="#6aa49b" strokeWidth="22" strokeLinecap="round">
                <path d="M829 507C835 535 828 560 815 583" />
              </g>
              <g id="pad_t">
                <ellipse cx="577" cy="417" rx="43" ry="60" fill="#528f8a" />
              </g>
              <g id="pad_l">
                <ellipse cx="485" cy="467" rx="42" ry="52" transform="rotate(-22 485 467)" fill="#528f8a" />
              </g>
              <g id="pad_r">
                <ellipse cx="658" cy="490" rx="41" ry="51" transform="rotate(22 658 490)" fill="#528f8a" />
              </g>
              <g id="pad_m">
                <path d="M565 508C595 508 618 535 645 568C667 594 665 626 638 636C612 646 590 628 560 650C530 664 495 652 488 622C483 595 520 535 540 515C548 510 556 508 565 508Z" fill="#528f8a" />
                <path d="M565 508C595 508 618 535 645 568C667 594 665 626 638 636C612 646 590 628 560 650C530 664 495 652 488 622C483 595 520 535 540 515C548 510 556 508 565 508Z" fill="url(#ht)" opacity="0.28" mask="url(#mpad)" />
              </g>
              <g id="pad_b">
                <ellipse cx="443" cy="551" rx="42" ry="37" transform="rotate(-25 443 551)" fill="#528f8a" />
              </g>
              <g id="cam">
                <path d="M722 368Q722 340 750 340H860Q888 340 888 368V398L975 340Q990 332 990 350V485Q990 500 975 493L888 440V464Q888 492 860 492H750Q722 492 722 464Z" fill="#6ba39d" stroke="#4f8c87" strokeWidth="7" strokeLinejoin="round" />
                <path d="M722 368Q722 340 750 340H860Q888 340 888 368V398L975 340Q990 332 990 350V485Q990 500 975 493L888 440V464Q888 492 860 492H750Q722 492 722 464Z" fill="url(#ht)" opacity="0.30" mask="url(#mcam)" />
                <path d="M890 400L975 342Q988 336 988 350V485Q988 498 975 491L890 440Z" fill="url(#ht)" opacity="0.30" />
              </g>
              <g id="tube">
                <path id="tp1" pathLength={100} fill="none" stroke="#245257" strokeWidth="42" strokeLinecap="round" strokeLinejoin="round" d="M138 193C95 205 72 245 74 300C76 360 98 410 118 450C140 515 185 548 232 548C280 548 328 515 348 452C372 410 396 360 398 300C400 245 378 205 340 190" />
                <path id="tp2" pathLength={100} fill="none" stroke="#3f7476" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" d="M138 193C95 205 72 245 74 300C76 360 98 410 118 450C140 515 185 548 232 548C280 548 328 515 348 452C372 410 396 360 398 300C400 245 378 205 340 190" />
              </g>
              <g id="joint">
                <rect x="86" y="418" width="64" height="56" rx="20" transform="rotate(22 118 446)" fill="#2f6a6c" stroke="#245257" strokeWidth="5" />
                <rect x="326" y="418" width="64" height="56" rx="20" transform="rotate(-22 358 446)" fill="#2f6a6c" stroke="#245257" strokeWidth="5" />
                <rect x="203" y="540" width="58" height="84" rx="12" fill="#2f6a6c" stroke="#245257" strokeWidth="5" />
              </g>
              <g id="tipL">
                <circle cx="168" cy="187" r="31" fill="#f6ebd0" stroke="#245257" strokeWidth="8" />
              </g>
              <g id="tipR">
                <circle cx="312" cy="185" r="31" fill="#f6ebd0" stroke="#245257" strokeWidth="8" />
              </g>
              <g id="cord">
                <path id="cp1" pathLength={100} fill="none" stroke="#245257" strokeWidth="34" strokeLinecap="round" d="M232 600V690C232 800 330 858 470 858C610 858 710 800 785 698" />
                <path id="cp2" pathLength={100} fill="none" stroke="#3f7476" strokeWidth="22" strokeLinecap="round" d="M232 600V690C232 800 330 858 470 858C610 858 710 800 785 698" />
              </g>
              <g id="chest">
                <circle cx="797" cy="676" r="80" fill="#fdf1d9" />
                <circle cx="797" cy="676" r="80" fill="none" stroke="#245257" strokeWidth="28" />
                <circle cx="797" cy="676" r="80" fill="none" stroke="#5b9a93" strokeWidth="15" />
                <path d="M748 722L797 674" stroke="#245257" strokeWidth="34" strokeLinecap="round" />
                <path d="M748 722L797 674" stroke="#3f7476" strokeWidth="22" strokeLinecap="round" />
                <circle cx="797" cy="674" r="34" fill="#2f6a6c" stroke="#245257" strokeWidth="5" />
                <circle cx="797" cy="674" r="34" fill="url(#ht)" opacity="0.25" />
              </g>
            </svg>
            <div className="v-wait__pulse">
              <i></i>
              <i></i>
              <i></i>
            </div>
          </button>

          <div ref={wordRef} className="v-wait__word" aria-hidden="true">
            {HUELLICAM_LETTERS.map((item, idx) => (
              <span key={idx} className={`v-wait__ch ${item.isTeal ? "c" : ""}`}>
                {item.char}
              </span>
            ))}
            <svg className="v-wait__spark" viewBox="0 0 26 26" aria-hidden="true">
              <path d="M6 20L2 24" />
              <path d="M12 12L10 4" />
              <path d="M20 14L25 9" />
            </svg>
          </div>

          <div className="v-wait__status">
            <div className="v-wait__line" aria-live="polite">
              <span key={statusIndex}>
                {statusMsgs[statusIndex]}
                {statusIndex < 3 && (
                  <span className="v-wait__dots">
                    <b>.</b>
                    <b>.</b>
                    <b>.</b>
                  </span>
                )}
              </span>
            </div>

            <svg className="v-wait__ecg" viewBox="0 0 300 44" aria-hidden="true">
              <path ref={ecgBaseRef} className="base" />
              <path
                ref={ecgFillRef}
                className="fill"
                pathLength={1000}
                strokeDasharray="1000"
                strokeDashoffset="1000"
              />
              <circle ref={ecgHaloRef} className="halo" r="5" />
              <circle ref={ecgHeadRef} className="head" r="4.5" />
            </svg>

            {isVet ? (
              <ul className="v-wait__checks" id="checks" aria-label="Estado del equipo">
                <li>Cámara lista</li>
                <li>Micrófono listo</li>
                <li>Conexión estable</li>
              </ul>
            ) : (
              <p className={`v-wait__tip ${tipOut ? "out" : ""}`}>
                {WAITING_TIPS[tipIndex]}
              </p>
            )}
          </div>
        </section>

        <footer className="v-wait__foot">
          {isVet ? (
            <button
              type="button"
              className="v-wait__cancel"
              onClick={onBack}
            >
              Salir de guardia
            </button>
          ) : (
            <button
              type="button"
              className="v-wait__cancel"
              onClick={() => {
                setIsCancelling(true);
                onCancel?.();
              }}
            >
              {isCancelling ? "Cancelando..." : "Cancelar solicitud de consulta"}
            </button>
          )}
        </footer>
      </div>
    </main>
  );
}

const LIVEKIT_STAGE_STYLE = {
  width: "100%",
  height: "100%",
  position: "absolute",
  inset: 0,
} as const;

const LiveKitCallCanvas = memo(function LiveKitCallCanvas({
  cam,
  mic,
  token,
  serverUrl,
  onConnected,
  onError,
  onMediaDeviceFailure,
  onDisconnected,
}: {
  cam: boolean;
  mic: boolean;
  token: string;
  serverUrl?: string;
  onConnected: () => void;
  onError: (err: Error) => void;
  onMediaDeviceFailure: (failure?: unknown) => void;
  onDisconnected: (reason?: unknown) => void;
}) {
  return (
    <LiveKitRoom
      video={cam}
      audio={mic}
      token={token}
      serverUrl={serverUrl}
      connect={true}
      options={LIVEKIT_ROOM_OPTIONS}
      data-lk-theme="default"
      style={LIVEKIT_STAGE_STYLE}
      onConnected={onConnected}
      onError={onError}
      onMediaDeviceFailure={onMediaDeviceFailure}
      onDisconnected={onDisconnected}
    >
      <LiveKitTrackSynchronizer mic={mic} cam={cam} />
      <VideoConference />
    </LiveKitRoom>
  );
});

export function LiveKitTrackSynchronizer({ mic, cam }: { mic: boolean; cam: boolean }) {
  const { localParticipant } = useLocalParticipant();

  useEffect(() => {
    if (!localParticipant) return;
    localParticipant.setMicrophoneEnabled(mic).catch((err) => {
      console.warn("LiveKit mic toggle notice:", err);
    });
  }, [mic, localParticipant]);

  useEffect(() => {
    if (!localParticipant) return;
    localParticipant.setCameraEnabled(cam).catch((err) => {
      console.warn("LiveKit cam toggle notice:", err);
    });
  }, [cam, localParticipant]);

  return null;
}

export { getWsUrl, WhatsAppCheck };

interface CallChatRawMessage {
  id?: string;
  clientMsgId?: string;
  consultationId?: string;
  content?: string;
  senderId?: string;
  sender?: { firstName?: string; lastName?: string };
  createdAt?: string;
  attachmentUrl?: string | null;
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  localDoc?: ClinicalChatDoc;
}

const IMAGE_URL_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveAttachmentUrl(rawUrl?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  if (UUID_RE.test(trimmed)) return `/api/media/${trimmed}`;
  return trimmed;
}

function buildDocFromMessage(m: CallChatRawMessage): ClinicalChatDoc | undefined {
  if (m.localDoc) return m.localDoc;
  const resolved = resolveAttachmentUrl(m.attachmentUrl);
  if (!resolved) return undefined;
  const contentText = (m.content || "").trim();
  const title = contentText.replace(/^📎\s*Adjunto:\s*/i, "") || "Archivo clínico adjunto";
  const isImage = IMAGE_URL_RE.test(resolved) || IMAGE_URL_RE.test(title);
  return {
    title,
    sub: isImage ? "Imagen clínica adjunta" : "Documento clínico adjunto",
    bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
    bannerTitle: "HuelliCam · Expediente Clínico",
    fileUrl: resolved,
    isImage,
  };
}

function CallChatPanel({
  consultationId,
  otherName,
  otherInitials,
  otherSubtitle,
  isVet,
  user,
  onNewIncomingMessage,
  onClosePanel,
}: {
  consultationId: string;
  otherName: string;
  otherInitials: string;
  otherSubtitle: string;
  isVet: boolean;
  user: { id?: string; firstName?: string; lastName?: string } | null;
  onNewIncomingMessage?: () => void;
  onClosePanel?: () => void;
}) {
  const { socket, isConnected, joinConsultation, leaveConsultation, emitEvent } = useSocket();
  const roomActionsRef = useRef({ joinConsultation, leaveConsultation });
  roomActionsRef.current = { joinConsultation, leaveConsultation };
  const [messages, setMessages] = useState<CallChatRawMessage[]>([]);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const onNewIncomingRef = useRef(onNewIncomingMessage);
  onNewIncomingRef.current = onNewIncomingMessage;
  const activeConsultationIdRef = useRef(consultationId);
  const consultationEpochRef = useRef(0);
  if (activeConsultationIdRef.current !== consultationId) {
    activeConsultationIdRef.current = consultationId;
    consultationEpochRef.current += 1;
  }
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!consultationId) return;
    let cancelled = false;
    roomActionsRef.current.joinConsultation(consultationId);

    api
      .get<ApiResponse<CallChatRawMessage[]>>(`/api/consultations/${consultationId}/messages`)
      .then((res) => {
        if (!cancelled && res.data.success && res.data.data) {
          setMessages(res.data.data);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      roomActionsRef.current.leaveConsultation(consultationId);
    };
  }, [consultationId]);

  useEffect(() => {
    if (!socket || !consultationId) return;

    const handleMessageNew = (msg: CallChatRawMessage) => {
      if (msg.consultationId && msg.consultationId !== consultationId) return;
      const fromOther = Boolean(msg.senderId && msg.senderId !== user?.id);
      setMessages((prev) => {
        const existingIdx = prev.findIndex(
          (m) => (m.id && m.id === msg.id) || (m.clientMsgId && m.clientMsgId === msg.clientMsgId)
        );
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = { ...prev[existingIdx], ...msg, status: "sent" };
          return updated;
        }
        if (fromOther) {
          onNewIncomingRef.current?.();
        }
        return [...prev, { ...msg, status: "sent" }];
      });
    };

    const handleChatDeleted = (payload?: { consultationId?: string }) => {
      if (payload?.consultationId && payload.consultationId !== consultationId) return;
      setMessages([]);
    };

    socket.on?.("message:new", handleMessageNew);
    socket.on?.("chat:deleted", handleChatDeleted);

    return () => {
      socket.off?.("message:new", handleMessageNew);
      socket.off?.("chat:deleted", handleChatDeleted);
    };
  }, [socket, consultationId, user?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const dispatchMessage = async (
    newContent: string,
    options?: { attachmentUrl?: string; localDoc?: ClinicalChatDoc }
  ) => {
    const targetCid = consultationId;
    const targetEpoch = consultationEpochRef.current;
    const isStaleTarget = () =>
      !isMountedRef.current ||
      activeConsultationIdRef.current !== targetCid ||
      consultationEpochRef.current !== targetEpoch;
    if (isStaleTarget()) return;

    const clientMsgId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimisticMsg: CallChatRawMessage = {
      id: clientMsgId,
      clientMsgId,
      consultationId: targetCid,
      content: newContent,
      senderId: user?.id,
      sender: user ? { firstName: user.firstName, lastName: user.lastName } : undefined,
      createdAt: new Date().toISOString(),
      attachmentUrl: options?.attachmentUrl,
      localDoc: options?.localDoc,
      status: "sending",
    };

    setMessages((prev) => [...prev, optimisticMsg]);

    if (socket && isConnected) {
      emitEvent<{ success?: boolean; data?: CallChatRawMessage }>(
        "message:send",
        {
          consultationId: targetCid,
          content: newContent,
          clientMsgId,
          ...(options?.attachmentUrl ? { attachmentUrl: options.attachmentUrl } : {}),
        },
        (res) => {
          if (isStaleTarget()) return;
          if (res?.success && res?.data) {
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMsgId === clientMsgId
                  ? { ...res.data, localDoc: m.localDoc, status: "sent" }
                  : m
              )
            );
          }
        }
      );
      return;
    }

    try {
      const res = await api.post<ApiResponse<CallChatRawMessage>>(
        `/api/consultations/${targetCid}/messages`,
        {
          content: newContent,
          clientMsgId,
          ...(options?.attachmentUrl ? { attachmentUrl: options.attachmentUrl } : {}),
        }
      );
      if (isStaleTarget()) return;
      if (res.data.success && res.data.data) {
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMsgId === clientMsgId
              ? { ...res.data.data, localDoc: m.localDoc, status: "sent" }
              : m
          )
        );
      }
    } catch (err) {
      if (isStaleTarget()) return;
      console.error("Error sending message via HTTP fallback:", err);
      setMessages((prev) =>
        prev.map((m) =>
          m.clientMsgId === clientMsgId ? { ...m, status: "failed" } : m
        )
      );
    }
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    void dispatchMessage(trimmed);
  };

  const handleAttachFile = async (file: File, isImage: boolean) => {
    const targetCid = consultationId;
    const targetEpoch = consultationEpochRef.current;
    const isStaleTarget = () =>
      !isMountedRef.current ||
      activeConsultationIdRef.current !== targetCid ||
      consultationEpochRef.current !== targetEpoch;
    if (isStaleTarget()) return;

    const sizeKB = (file.size / 1024).toFixed(1);

    let uploadedAttachmentUrl: string | undefined;
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("consultationId", targetCid);
      const uploadRes = await api.post<ApiResponse<{ id?: string; url?: string }>>(
        "/api/media",
        formData
      );
      if (isStaleTarget()) return;
      const uploadedId = uploadRes.data?.data?.id;
      const uploadedUrl = uploadRes.data?.data?.url;
      uploadedAttachmentUrl = uploadedUrl
        ? normalizeMediaUrl(uploadedUrl)
        : uploadedId
          ? `/api/media/${uploadedId}`
          : undefined;
    } catch (err) {
      if (isStaleTarget()) return;
      console.warn("Media upload failed, aborting chat attachment message:", err);
      return;
    }

    if (!uploadedAttachmentUrl || isStaleTarget()) {
      return;
    }

    const localDoc: ClinicalChatDoc = {
      title: file.name,
      sub: isImage ? `Imagen clínica · ${sizeKB} KB` : `Documento clínico · ${sizeKB} KB`,
      bannerTag: isImage ? "FOTO / ARCHIVO CLÍNICO" : "DOCUMENTO ADJUNTO",
      bannerTitle: "HuelliCam · Expediente Clínico",
      fileUrl: uploadedAttachmentUrl,
      isImage,
    };

    await dispatchMessage(`📎 Adjunto: ${file.name}`, {
      attachmentUrl: uploadedAttachmentUrl,
      localDoc,
    });
  };

  const threadMessages: ClinicalChatMessage[] = messages.map((m) => {
    const mine = m.senderId === user?.id;
    const time = m.createdAt
      ? new Date(m.createdAt).toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Ahora";
    const doc = buildDocFromMessage(m);
    const displayText =
      doc && m.content?.startsWith("📎 Adjunto:") ? undefined : m.content || "";
    const senderDisplay =
      [m.sender?.firstName, m.sender?.lastName].filter(Boolean).join(" ") ||
      otherName;

    return {
      id: m.id || m.clientMsgId || `${time}-${Math.random()}`,
      mine,
      senderName: mine ? undefined : senderDisplay,
      text: displayText,
      time,
      state: m.status || "read",
      doc,
    };
  });

  return (
    <ClinicalChatThread
      ariaLabel={`Chat clínico con ${otherName}`}
      showHeader={true}
      contactName={otherName}
      contactInitials={otherInitials}
      statusText={
        isConnected
          ? `En consulta activa · ${otherSubtitle}`
          : `Conectando canal clínico… · ${otherSubtitle}`
      }
      isOnline={isConnected}
      headerActions={
        onClosePanel ? (
          <button
            type="button"
            className="wa-icon-btn"
            onClick={onClosePanel}
            aria-label="Cerrar panel"
          >
            <Icon name="close" size={17} />
          </button>
        ) : undefined
      }
      messages={threadMessages}
      value={text}
      onChange={setText}
      onSend={handleSend}
      placeholder={
        isVet
          ? `Escribir indicación a ${otherName}…`
          : "Escribí un mensaje clínico para el veterinario..."
      }
      quickReplies={isVet ? quickReplies : undefined}
      onAttachFile={handleAttachFile}
      endRef={endRef}
    />
  );
}

export type CallRoomPanel = "" | "Chat" | "Ficha" | "Evolución";

function Room({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth();
  const { socket, reconnectingConsultations = {}, joinConsultation, leaveConsultation, emitEvent } = useSocket();
  const roomActionsRef = useRef({ joinConsultation, leaveConsultation });
  roomActionsRef.current = { joinConsultation, leaveConsultation };
  const queryClient = useQueryClient();
  const { consults, queue, finish } = useVet();
  const [authErrorStatus, setAuthErrorStatus] = useState<number | null>(null);

  const cachedUser = (() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("huellicam_user") : null;
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  const effectiveUser = user || cachedUser;

  // Fetch real consultation data from PostgreSQL (reactive invalidation via SocketContext)
  const { data: consultation, refetch: refetchConsultation } = useQuery<BackendConsultation | null>({
    queryKey: ["consultation", id],
    enabled: Boolean(id && effectiveUser),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      try {
        const res = await api.get<ApiResponse<BackendConsultation>>(`/api/consultations/${id}`);
        setAuthErrorStatus(null);
        return res.data.success && res.data.data ? res.data.data : null;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403) {
          setAuthErrorStatus(status);
        }
        return null;
      }
    },
  });

  // Sync consultation state when returning to browser tab while waiting
  useEffect(() => {
    if (!id || !effectiveUser || authErrorStatus) return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && (!consultationStatusRef.current || consultationStatusRef.current === "WAITING")) {
        void refetchConsultation();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [id, effectiveUser, authErrorStatus, refetchConsultation]);

  // Dynamically register pet into local dictionary if loaded
  useEffect(() => {
    if (consultation?.pet) {
      const mapped = mapBackendPetToPatient(consultation.pet, consultation.client);
      registerPatient(mapped);
    }
  }, [consultation?.pet, consultation?.client]);

  const fallbackConsult = consults.find((c: Consult) => c.id === id) ?? initialConsults.find((c: Consult) => c.id === id);
  const fallbackQueued = queue.find((q: QueueItem) => q.id === id) ?? initialQueue.find((q: QueueItem) => q.id === id);
  const petId = consultation?.petId ?? fallbackConsult?.petId ?? fallbackQueued?.petId ?? "milo";
  const p = getPatient(petId);
  const triage = fallbackQueued?.triage ?? fallbackConsult?.triage;

  const [secs, setSecs] = useState(0);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  // Inicialización limpia: iniciar siempre en "" (cerrado) para dar prioridad
  // total a la cámara/video del paciente y médico, evitando que el drawer
  // fixed de 66vh tape la pantalla al ingresar (BUG-01 test1.md):
  const [panel, setPanel] = useState<CallRoomPanel>("");
  const panelRef = useRef<CallRoomPanel>(panel);
  panelRef.current = panel;
  const [unreadChat, setUnreadChat] = useState(0);
  useEffect(() => {
    if (panel === "Chat") {
      setUnreadChat(0);
    }
  }, [panel]);
  const handleNewIncomingMessage = useCallback(() => {
    if (panelRef.current !== "Chat") {
      setUnreadChat((n) => n + 1);
    }
  }, []);
  const [celebrating, setCelebrating] = useState(false);
  const wasWaitingRef = useRef(false);
  const [ending, setEnding] = useState(false);
  const endingRef = useRef(false);
  const evictedRef = useRef(false);
  endingRef.current = ending;
  const isMountedRef = useRef(true);
  const activeIdRef = useRef(id);
  activeIdRef.current = id;
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const reviewPromptedRef = useRef(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const isVet = effectiveUser?.role === "VET";
  const fromClient = effectiveUser
    ? effectiveUser.role === "CLIENT"
    : typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("from") === "client" ||
        window.location.pathname.startsWith("/client")
      : false;

  // Auto-asignación defensiva e idempotente para rol VET si la consulta sigue en WAITING
  const assignAttemptedRef = useRef(false);

  useEffect(() => {
    const isPendingAssign = consultation?.status === "WAITING";

    if (isPendingAssign && isVet && !assignAttemptedRef.current) {
      assignAttemptedRef.current = true;
      api
        .patch<ApiResponse<BackendConsultation>>(`/api/consultations/${id}/assign`)
        .then((res) => {
          if (res.data?.success && res.data?.data) {
            queryClient.setQueryData(["consultation", id], res.data.data);
            queryClient.invalidateQueries({ queryKey: ["consultation", id] });
            queryClient.invalidateQueries({ queryKey: ["consultations"] });
          }
        })
        .catch((err) => {
          console.warn("Defensive assign in CallRoom notice:", err);
        });
    }
  }, [consultation?.status, isVet, id, queryClient]);

  // Participant naming derived directly from DB
  const petName = consultation?.pet?.name || p.name || "Mascota";
  const petKind = consultation?.pet?.species || p.kind || "Canino";
  const petBreed = consultation?.pet?.breed ? ` · ${consultation.pet.breed}` : "";
  const reason = consultation?.notes || fallbackConsult?.reason || fallbackQueued?.reason || "Videoconsulta telemática";

  const tutorName = consultation?.client
    ? [consultation.client.firstName, consultation.client.lastName].filter(Boolean).join(" ") || "Tutor"
    : (p.tutor || "Tutor");

  const tutorInitials = consultation?.client
    ? `${consultation.client.firstName?.[0] || "T"}${consultation.client.lastName?.[0] || ""}`.toUpperCase()
    : "TU";

  const hasVetAssigned = Boolean(consultation?.vet);
  const vetName = consultation?.vet
    ? (consultation.vet.lastName ? `Dr. ${consultation.vet.firstName} ${consultation.vet.lastName}` : `Dr. ${consultation.vet.firstName}`)
    : (isVet && user
      ? (user.lastName ? `Dr. ${user.firstName} ${user.lastName}` : `Dr. ${user.firstName}`)
      : (consultation?.status === "WAITING" ? "Guardia Veterinaria" : "Veterinario de guardia"));

  const vetInitials = consultation?.vet
    ? `${consultation.vet.firstName?.[0] || "V"}${consultation.vet.lastName?.[0] || ""}`.toUpperCase()
    : (isVet && user ? `${user.firstName?.[0] || "V"}${user.lastName?.[0] || ""}`.toUpperCase() : "VC");

  const remoteName = fromClient ? (hasVetAssigned ? vetName : "Guardia Veterinaria") : `${tutorName} · ${petName}`;
  const remoteInitials = fromClient ? vetInitials : tutorInitials;
  const selfInitials = user ? `${user.firstName?.[0] || "U"}${user.lastName?.[0] || ""}`.toUpperCase() : "VO";
  const chatOtherName = fromClient
    ? (hasVetAssigned ? vetName : "la guardia veterinaria")
    : (tutorName || "el tutor");

  // Derive callState from consultation lifecycle
  const isConsultationActive = consultation?.status === "ACTIVE";
  const canReview = Boolean(
    fromClient && consultation?.status === "COMPLETED" && !consultation?.review
  );
  const isTutorReconnecting = Boolean(!fromClient && id && reconnectingConsultations?.[id]);
  const { viewportHeight: callViewportHeight, keyboardInset: callKeyboardInset } = useVisualViewport();
  const isMobileCallViewport = useIsMobileViewport();

  const [callState, setCallState] = useState<"connecting" | "waiting" | "connected" | "reconnecting" | "ended" | "error">(
    isConsultationActive ? "connected" : fromClient ? "waiting" : "connecting"
  );
  const callEndedRef = useRef(false);
  const consultationStatusRef = useRef<string | undefined>(consultation?.status);
  consultationStatusRef.current = consultation?.status;
  const fromClientRef = useRef(fromClient);
  fromClientRef.current = fromClient;

  useEffect(() => {
    evictedRef.current = false;
    callEndedRef.current = false;
    reviewPromptedRef.current = false;
    assignAttemptedRef.current = false;
    wasWaitingRef.current = false;
    setLivekitToken(null);
    setLivekitWsUrl(undefined);
    setLivekitFailed(false);
    setCallState(fromClientRef.current ? "waiting" : "connecting");
  }, [id]);

  useEffect(() => {
    const active = consultation?.status === "ACTIVE";
    const ended = consultation?.status === "COMPLETED" || consultation?.status === "CANCELLED";
    if (ended) {
      callEndedRef.current = true;
      setCallState("ended");
    } else if (callEndedRef.current) {
      return;
    } else if (active) {
      setCallState("connected");
    } else if (fromClient) {
      setCallState("waiting");
    } else {
      setCallState("connecting");
    }
  }, [consultation?.status, consultation, fromClient]);

  useEffect(() => {
    if (callState === "ended" && canReview && !reviewPromptedRef.current) {
      reviewPromptedRef.current = true;
      setShowReviewModal(true);
    }
  }, [callState, canReview]);

  // WAITING -> ACTIVE: celebrate for 1.4s (fill ECG to 100%) before mounting the call console
  useEffect(() => {
    const isWaitingStatus = consultation?.status === "WAITING";
    if (isWaitingStatus) {
      wasWaitingRef.current = true;
    } else if (isConsultationActive && wasWaitingRef.current) {
      wasWaitingRef.current = false;
      setCelebrating(true);
      const t = window.setTimeout(() => setCelebrating(false), 1400);
      return () => window.clearTimeout(t);
    }
  }, [consultation?.status, isConsultationActive]);

  // LiveKit WebRTC state
  const [livekitToken, setLivekitToken] = useState<string | null>(null);
  const [livekitWsUrl, setLivekitWsUrl] = useState<string | undefined>(undefined);
  const [livekitFailed, setLivekitFailed] = useState(false);
  const [callDegradedReason, setCallDegradedReason] = useState<string | null>(null);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [incidentReported, setIncidentReported] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedCallAt, setReschedCallAt] = useState("");
  const [reschedCallDone, setReschedCallDone] = useState(false);

  const handleRetryVideoToken = useCallback(() => {
    evictedRef.current = false;
    setCallDegradedReason(null);
    setLivekitFailed(false);
    setLivekitToken(null);
    setReschedOpen(false);
  }, []);

  const handleReportCallIncident = useCallback(async (reasonText?: string, code?: string) => {
    setIncidentBusy(true);
    try {
      const reason = reasonText || callDegradedReason || "Fallo de audio/video durante la videoconsulta";
      await api.post(`/api/calls/${id}/incident`, {
        reason,
        errorCode: code || "CALL_CONNECTION_DEGRADED",
      });
      setIncidentReported(true);
      setCallDegradedReason(reason);
    } catch {
      // Non-blocking fallback notice
    } finally {
      setIncidentBusy(false);
    }
  }, [id, callDegradedReason]);

  const handleQuickRescheduleCall = useCallback(async () => {
    if (!reschedCallAt) return;
    try {
      await api.patch(`/api/consultations/${id}/reschedule`, {
        scheduledAt: new Date(reschedCallAt).toISOString(),
        reason: "Reprogramado por falla técnica en videollamada",
      });
      setReschedCallDone(true);
    } catch {
      setReschedCallDone(false);
    }
  }, [id, reschedCallAt]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleSessionTerminated = () => {
      evictedRef.current = true;
      setLivekitToken(null);
    };
    window.addEventListener("huellicam:session_terminated", handleSessionTerminated);
    return () => {
      window.removeEventListener("huellicam:session_terminated", handleSessionTerminated);
    };
  }, []);

  useEffect(() => {
    if (consultation?.status === "ACTIVE" && !livekitToken && !livekitFailed && !evictedRef.current) {
      let cancelled = false;
      let retryTimer: number | undefined;
      let attempts = 0;

      const fetchToken = () => {
        attempts += 1;
        api
          .post<ApiResponse<{ token: string; wsUrl: string }>>(`/api/calls/${id}/token`)
          .then((res) => {
            if (!cancelled && res.data.success && res.data.data?.token) {
              setLivekitToken(res.data.data.token);
              if (res.data.data.wsUrl) setLivekitWsUrl(res.data.data.wsUrl);
            }
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            const axiosErr = err as {
              response?: {
                status?: number;
                data?: {
                  code?: string;
                  message?: string;
                  error?: { code?: string; message?: string };
                };
              };
            };
            const status = axiosErr?.response?.status;
            const errCode = axiosErr?.response?.data?.error?.code || axiosErr?.response?.data?.code;
            const errMsg =
              axiosErr?.response?.data?.error?.message ||
              axiosErr?.response?.data?.message ||
              "Retomaste esta consulta desde otro dispositivo.";
            if (status === 409 && errCode === "DEVICE_SESSION_STALE") {
              evictedRef.current = true;
              setLivekitToken(null);
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("huellicam:session_terminated", {
                    detail: {
                      reason: "SESSION_MIGRATED_NEW_DEVICE",
                      message: errMsg,
                    },
                  })
                );
              }
              return;
            }
            if ((status === 401 || status === 403) && !cancelled) {
              setAuthErrorStatus(status);
              return;
            }
            if (attempts < 2 && !cancelled) {
              retryTimer = window.setTimeout(fetchToken, 900);
              return;
            }
            console.warn("LiveKit token notice:", err);
            setLivekitFailed(true);
          });
      };

      fetchToken();
      return () => {
        cancelled = true;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
  }, [consultation?.status, id, livekitToken, livekitFailed]);

  // Mobile WebView handshake
  useEffect(() => {
    postMobileBridgeMessage({ type: "page:ready" });
  }, []);

  // Screen WakeLock during call/waiting (Web API + React Native WebView bridge)
  useEffect(() => {
    type WakeLockNavigator = Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    let wakeLockSentinel: { release: () => Promise<void> } | null = null;
    const shouldKeepAwake = callState !== "ended" && callState !== "error";

    const requestWakeLock = async () => {
      try {
        const nav = typeof navigator !== "undefined" ? (navigator as WakeLockNavigator) : undefined;
        if (nav?.wakeLock?.request) {
          wakeLockSentinel = await nav.wakeLock.request("screen");
        }
      } catch {}
    };

    if (shouldKeepAwake) {
      void requestWakeLock();
      postMobileBridgeMessage({ type: "wakelock:acquire" });
    }

    const handleVis = () => {
      if (document.visibilityState === "visible" && shouldKeepAwake) {
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVis);
    return () => {
      document.removeEventListener("visibilitychange", handleVis);
      if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
      }
      if (shouldKeepAwake) {
        postMobileBridgeMessage({ type: "wakelock:release" });
      }
    };
  }, [callState]);

  // Local camera preview via getUserMedia (only when LiveKit is not active)
  useEffect(() => {
    if (!cam || livekitToken) {
      if (localVideoRef.current?.srcObject) {
        const stream = localVideoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
        localVideoRef.current.srcObject = null;
      }
      return;
    }
    let activeStream: MediaStream | null = null;
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ video: true, audio: false })
        .then((stream) => {
          activeStream = stream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }
        })
        .catch(() => {});
    }
    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [cam, livekitToken]);

  // Join consultation room via shared ref-counted SocketContext
  useEffect(() => {
    if (!id) return;
    roomActionsRef.current.joinConsultation(id);
    return () => {
      roomActionsRef.current.leaveConsultation(id);
    };
  }, [id]);

  // Listen for reactive consultation & call events on shared singleton socket
  useEffect(() => {
    if (!socket) return;
    let wasConnected = Boolean(socket.connected);

    const handleConnect = () => {
      const isReconnect = wasConnected;
      wasConnected = true;
      const status = consultationStatusRef.current;
      const shouldInitialSync =
        !isReconnect &&
        !callEndedRef.current &&
        status !== "COMPLETED" &&
        status !== "CANCELLED";
      if (isReconnect || shouldInitialSync) {
        void queryClient.invalidateQueries({ queryKey: ["consultation", id] });
        void queryClient.invalidateQueries({ queryKey: ["consultations"] });
      }
    };

    const handleCallEnded = (payload?: { consultationId?: string }) => {
      if (!payload?.consultationId || payload.consultationId !== id) return;
      callEndedRef.current = true;
      setCallState("ended");
      void queryClient.invalidateQueries({ queryKey: ["consultation", id] });
      void queryClient.invalidateQueries({ queryKey: ["consultations"] });
    };

    const handleConsultationSync = (payload?: {
      consultationId?: string;
      metadata?: { consultationId?: string };
      data?: { consultationId?: string };
    }) => {
      const cid =
        payload?.consultationId ?? payload?.metadata?.consultationId ?? payload?.data?.consultationId;
      if (!cid || cid !== id) return;
      void queryClient.invalidateQueries({ queryKey: ["consultation", id] });
      void queryClient.invalidateQueries({ queryKey: ["consultations"] });
    };

    const handleCriticalResume = (payload?: { consultationId?: string }) => {
      if (payload?.consultationId && payload.consultationId !== id) return;
      evictedRef.current = false;
      setLivekitToken(null);
      setLivekitFailed(false);
      void queryClient.invalidateQueries({ queryKey: ["consultation", id] });
      void queryClient.invalidateQueries({ queryKey: ["consultations"] });
    };

    const handleCallDegraded = (payload?: { consultationId?: string; reason?: string; errorCode?: string }) => {
      if (payload?.consultationId && payload.consultationId !== id) return;
      setCallDegradedReason(payload?.reason || payload?.errorCode || "Inestabilidad detectada en la videollamada");
      setLivekitFailed(true);
    };

    socket.on?.("connect", handleConnect);
    socket.on?.("call:ended", handleCallEnded);
    socket.on?.("call:degraded", handleCallDegraded);
    socket.on?.("consultation:assigned", handleConsultationSync);
    socket.on?.("consultation:cancelled", handleConsultationSync);
    socket.on?.("consultation:critical_resume", handleCriticalResume);
    socket.on?.("notification:new", handleConsultationSync);

    return () => {
      socket.off?.("connect", handleConnect);
      socket.off?.("call:ended", handleCallEnded);
      socket.off?.("call:degraded", handleCallDegraded);
      socket.off?.("consultation:assigned", handleConsultationSync);
      socket.off?.("consultation:cancelled", handleConsultationSync);
      socket.off?.("consultation:critical_resume", handleCriticalResume);
      socket.off?.("notification:new", handleConsultationSync);
    };
  }, [socket, id, queryClient, fromClient]);

  // Waiting timer anchored strictly to consultation.createdAt (with mount-time fallback before query resolves)
  const waitMountMsRef = useRef<number>(Date.now());
  useEffect(() => {
    waitMountMsRef.current = Date.now();
  }, [id]);

  const computeWaitSecs = useCallback((): number => {
    const parsedCreated = consultation?.createdAt ? new Date(consultation.createdAt).getTime() : NaN;
    const baseMs = Number.isFinite(parsedCreated) ? parsedCreated : waitMountMsRef.current;
    return Math.max(0, Math.floor((Date.now() - baseMs) / 1000));
  }, [consultation?.createdAt]);

  const [waitSecs, setWaitSecs] = useState<number>(() => computeWaitSecs());

  useEffect(() => {
    setWaitSecs(computeWaitSecs());
    if (consultation?.status === "COMPLETED" || consultation?.status === "CANCELLED") {
      return;
    }
    const t = window.setInterval(() => setWaitSecs(computeWaitSecs()), 1000);
    return () => window.clearInterval(t);
  }, [computeWaitSecs, consultation?.status]);

  const waitClock = `${String(Math.floor(waitSecs / 60)).padStart(2, "0")}:${String(waitSecs % 60).padStart(2, "0")}`;

  // Active call duration timer anchored to consultation.startedAt (0 while waiting, frozen at endedAt)
  useEffect(() => {
    const computeSecs = (): number => {
      if (!consultation?.startedAt) return 0;
      const startMs = new Date(consultation.startedAt).getTime();
      if (!Number.isFinite(startMs)) return 0;
      const endMs = consultation.endedAt ? new Date(consultation.endedAt).getTime() : Date.now();
      const validEndMs = Number.isFinite(endMs) ? endMs : Date.now();
      return Math.max(0, Math.floor((validEndMs - startMs) / 1000));
    };

    setSecs(computeSecs());
    if (!consultation?.startedAt || consultation.endedAt || callState === "ended") {
      return;
    }
    const t = window.setInterval(() => setSecs(computeSecs()), 1000);
    return () => window.clearInterval(t);
  }, [consultation?.startedAt, consultation?.endedAt, callState]);

  const clock = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;

  // Call completion handler (only VET/ADMIN transition consultation to COMPLETED; CLIENT exit stays local)
  const handleFinalize = useCallback(async () => {
    const targetId = activeIdRef.current;
    if (!isMountedRef.current || !targetId) return;
    setEnding(false);

    if (fromClientRef.current) {
      postMobileBridgeMessage({ type: "wakelock:release" });
      go("/client/dashboard");
      return;
    }

    callEndedRef.current = true;
    try {
      await api.patch(`/api/consultations/${targetId}/complete`, {
        diagnosisNotes: "Consulta telemática finalizada con éxito.",
      });
    } catch (err) {
      console.warn("Notice completing consultation:", err);
    }

    if (!isMountedRef.current || activeIdRef.current !== targetId) return;

    void queryClient.invalidateQueries({ queryKey: ["consultation", targetId] });
    void queryClient.invalidateQueries({ queryKey: ["consultations"] });

    // Inform socket room via shared singleton socket
    emitEvent("call:ended", { consultationId: targetId });

    postMobileBridgeMessage({ type: "call:ended" });
    setCallState("ended");
  }, [emitEvent, queryClient]);

  const handleLiveKitConnected = useCallback(() => {
    setCallDegradedReason(null);
    setCallState("connected");
  }, []);

  const handleLiveKitError = useCallback((err: Error) => {
    setCallDegradedReason(err?.message || "Error de conexión en videollamada");
    setLivekitFailed(true);
  }, []);

  const handleLiveKitMediaFailure = useCallback((failure?: unknown) => {
    setCallDegradedReason(failure ? `Fallo de cámara/micrófono (${String(failure)})` : "Fallo de cámara/micrófono");
    setLivekitFailed(true);
  }, []);

  const handleLiveKitDisconnected = useCallback(
    (reason?: unknown) => {
      if (!isMountedRef.current || evictedRef.current) return;
      if (endingRef.current && !fromClientRef.current) {
        void handleFinalize();
        return;
      }
      console.warn("LiveKit transient disconnect notice, keeping consultation active for reconnect", reason);
      setCallState("reconnecting");
    },
    [handleFinalize]
  );

  const [postFollowUpTitle, setPostFollowUpTitle] = useState("Control post consulta");
  const [postFollowUpAt, setPostFollowUpAt] = useState(() => {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    d.setHours(18, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [postFollowUpBusy, setPostFollowUpBusy] = useState(false);
  const [postFollowUpDone, setPostFollowUpDone] = useState(false);
  const [postReschedAt, setPostReschedAt] = useState("");
  const [postReschedBusy, setPostReschedBusy] = useState(false);
  const [postReschedDone, setPostReschedDone] = useState(false);

  const handlePostCallFollowUp = async () => {
    if (!consultation?.petId || !postFollowUpTitle.trim() || !postFollowUpAt) return;
    setPostFollowUpBusy(true);
    try {
      const dueAt = new Date(postFollowUpAt).toISOString();
      await api.post("/api/scheduling/follow-ups", {
        petId: consultation.petId,
        consultationId: id,
        title: postFollowUpTitle.trim(),
        dueAt,
      });
      void queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
      setPostFollowUpDone(true);
    } catch {
      setPostFollowUpDone(false);
    } finally {
      setPostFollowUpBusy(false);
    }
  };

  const handlePostCallReschedule = async () => {
    if (!postReschedAt) return;
    setPostReschedBusy(true);
    try {
      await api.patch(`/api/consultations/${id}/reschedule`, {
        scheduledAt: new Date(postReschedAt).toISOString(),
        reason: "Reprogramado al finalizar la llamada",
      });
      void queryClient.invalidateQueries({ queryKey: ["consultations"] });
      setPostReschedDone(true);
    } catch {
      setPostReschedDone(false);
    } finally {
      setPostReschedBusy(false);
    }
  };

  if (callState === "ended") {
    const isCancelled = consultation?.status === "CANCELLED";
    return (
      <main className="v-call-summary">
        <section className="v-call-summary__card">
          <span className="v-call-summary__icon">
            <Icon name={isCancelled ? "close" : "check"} size={28} />
          </span>
          <span className="eyebrow">Videoconsulta</span>
          <h1>{isCancelled ? "Consulta cancelada" : "Consulta finalizada"}</h1>
          <p>
            {isCancelled
              ? "La consulta fue cancelada antes de completar la atención clínica."
              : "La llamada finalizó exitosamente. Podés revisar los detalles de la atención."}
          </p>
          <dl>
            <div>
              <dt>{fromClient ? "Veterinario" : "Tutor"}</dt>
              <dd>{fromClient ? vetName : tutorName}</dd>
            </div>
            <div>
              <dt>Mascota</dt>
              <dd>{petName} · {petKind}{petBreed}</dd>
            </div>
            <div>
              <dt>Fecha y duración</dt>
              <dd>Hoy · {clock}</dd>
            </div>
            <div>
              <dt>Motivo</dt>
              <dd>{reason}</dd>
            </div>
            <div className="is-wide">
              <dt>Diagnóstico / Evolución</dt>
              <dd>{consultation?.diagnosisNotes || "Atención telemática realizada y registrada en el historial clínico."}</dd>
            </div>
          </dl>
          {!fromClient && !isCancelled && (
            <div style={{ margin: "16px 0", padding: "14px", borderRadius: 12, border: "1px solid var(--line, #e4dfd2)", background: "#faf8f5", textAlign: "left" }}>
              <strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>Continuidad clínica y turno</strong>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input
                  type="text"
                  aria-label="Motivo del seguimiento"
                  value={postFollowUpTitle}
                  onChange={(e) => setPostFollowUpTitle(e.target.value)}
                  style={{ flex: 1, minWidth: 160, height: 36, borderRadius: 8, border: "1px solid var(--line)", padding: "0 10px" }}
                />
                <input
                  type="datetime-local"
                  aria-label="Fecha y hora del seguimiento"
                  value={postFollowUpAt}
                  onChange={(e) => setPostFollowUpAt(e.target.value)}
                  style={{ height: 36, borderRadius: 8, border: "1px solid var(--line)", padding: "0 10px", background: "#fff" }}
                />
                <Button variant="secondary" disabled={!postFollowUpAt || postFollowUpBusy || postFollowUpDone} onClick={handlePostCallFollowUp}>
                  {postFollowUpDone ? "Propuesta enviada" : postFollowUpBusy ? "Enviando..." : "Proponer seguimiento"}
                </Button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <input
                  type="datetime-local"
                  aria-label="Nueva fecha de turno"
                  value={postReschedAt}
                  onChange={(e) => setPostReschedAt(e.target.value)}
                  style={{ height: 36, borderRadius: 8, border: "1px solid var(--line)", padding: "0 10px" }}
                />
                <Button variant="secondary" disabled={!postReschedAt || postReschedBusy || postReschedDone} onClick={handlePostCallReschedule}>
                  {postReschedDone ? "Turno reprogramado" : postReschedBusy ? "Guardando..." : "Reprogramar"}
                </Button>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            {canReview && (
              <Button variant="secondary" onClick={() => setShowReviewModal(true)}>
                ⭐ Calificar atención
              </Button>
            )}
            <Button
              icon="arrow"
              onClick={() => go(fromClient ? "/client/consultations" : `/vet/consultations/${id}`)}
            >
              {fromClient ? "Volver a mis consultas" : "Volver a la consulta"}
            </Button>
          </div>
        </section>

        {canReview && (
          <ReviewModal
            isOpen={showReviewModal}
            consultationId={id}
            onClose={() => setShowReviewModal(false)}
            onSuccess={() => {
              setShowReviewModal(false);
              go("/client/consultations");
            }}
          />
        )}
      </main>
    );
  }

  const stateCopy = {
    connecting: [fromClient ? "Conectando con el veterinario…" : "Conectando con el tutor…", "Estamos preparando la sala de telemedicina."],
    waiting: [
      fromClient ? "Sala de espera de guardia" : "Esperando que el tutor se conecte…",
      fromClient
        ? "Tu solicitud está en la cola de atención médica. Te conectaremos automáticamente apenas un veterinario de guardia tome la consulta."
        : "Podés quedarte en esta pantalla. Te avisamos en cuanto ingrese.",
    ],
    reconnecting: ["Se perdió momentáneamente la conexión.", "Estamos intentando reconectar la llamada."],
    error: ["No pudimos conectar la videollamada.", "Revisá tu conexión e intentá nuevamente."],
    connected: ["", ""],
    ended: ["", ""],
  }[callState];

  const parsedNotes = parseConsultationNotes(reason);
  const cleanReason = parsedNotes.cleanNotes;
  const effectiveTriage = triage ?? (parsedNotes.priority ? TRIAGE_BY_TIER[parsedNotes.priority] : undefined);

  if ((!authLoading && !effectiveUser) || authErrorStatus === 401 || authErrorStatus === 403) {
    const isForbidden = authErrorStatus === 403;
    return (
      <main className="v-call-summary">
        <section className="v-call-summary__card">
          <span className="v-call-summary__icon">
            <Icon name="shield" size={28} />
          </span>
          <span className="eyebrow">Acceso a videoconsulta</span>
          <h1>{isForbidden ? "Sin acceso a esta consulta" : "Sesión requerida"}</h1>
          <p>
            {isForbidden
              ? "Esta consulta pertenece a otra cuenta. Iniciá sesión con el usuario correspondiente para ingresar."
              : "Tu sesión venció o iniciaste sesión con otra cuenta en este navegador. Volvé a iniciar sesión para conectarte."}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <Button onClick={() => go("/login")}>Iniciar sesión</Button>
            {!isForbidden && (
              <Button
                variant="secondary"
                icon="repeat"
                onClick={() => {
                  setAuthErrorStatus(null);
                  void refetchConsultation();
                }}
              >
                Reintentar
              </Button>
            )}
          </div>
        </section>
      </main>
    );
  }

  // FEAT-07 / VET-WAIT: tutor in waiting room until active; vet in pairing room while waiting
  if (fromClient && (!isConsultationActive || celebrating)) {
    const tierLabel = parsedNotes.priority
      ? { ROJO: "CRÍTICO", AMARILLO: "MODERADO", VERDE: "RUTINA" }[parsedNotes.priority]
      : null;
    return (
      <WaitingRoomExperience
        isVet={false}
        isReady={celebrating}
        petName={petName}
        tutorName={tutorName}
        symptom={cleanReason}
        clock={waitClock}
        waitSecs={waitSecs}
        tierLabel={tierLabel}
        onBack={() => go("/client/consultations")}
        onCancel={async () => {
          try {
            await api.patch(`/api/consultations/${id}/cancel`);
          } catch (err) {
            console.warn("Notice cancelling consultation:", err);
          }
          queryClient.invalidateQueries({ queryKey: ["consultation", id] });
          queryClient.invalidateQueries({ queryKey: ["consultations"] });
          go("/client/consultations");
        }}
      />
    );
  }

  if (!fromClient && (!isConsultationActive || celebrating || callState === "connecting" || callState === "waiting")) {
    return (
      <WaitingRoomExperience
        isVet={true}
        isReady={celebrating || (isConsultationActive && callState === "connected")}
        vetName={vetName}
        vetInitials={vetInitials}
        petName={petName}
        tutorName={tutorName}
        clock={waitClock}
        waitSecs={waitSecs}
        onBack={() => go("/vet/dashboard")}
      />
    );
  }

  return (
    <div className={`v-call ${panel ? "has-panel" : ""} h-[100dvh] max-h-[100dvh] overflow-hidden`}>
      <header className="v-call__top">
        <button className="v-call__back" onClick={() => setEnding(true)} aria-label="Salir de la videollamada">
          <Icon name="left" size={20} />
        </button>
        <div className="v-call__avatar" aria-hidden="true">
          <span>{remoteInitials}</span>
          <span className="v-call__avatar-dot" />
        </div>
        <div className="v-call__identity">
          <span className="v-call__eyebrow">Videoconsulta · {petKind}</span>
          <b>{petName} · {fromClient ? vetName : tutorName}</b>
          <span>{cleanReason}</span>
        </div>
        <div className="v-call__status-group">
          {effectiveTriage && <TriageBadge level={effectiveTriage} compact />}
          <span className={`v-call__net ${callState === "reconnecting" || isTutorReconnecting ? "is-warning" : ""}`}>
            <Icon name={callState === "reconnecting" || isTutorReconnecting ? "repeat" : "check"} size={13} />
            <span>
              {callState === "reconnecting"
                ? "Reconectando"
                : isTutorReconnecting
                  ? "Tutor reconectando"
                  : "Conexión estable"}
            </span>
          </span>
          <time className="v-call__time" aria-label={`Duración ${Math.floor(secs / 60)} minutos`}>
            <i className="v-call__rec-dot" aria-hidden="true" />
            <span>{clock}</span>
          </time>
        </div>
      </header>

      <main className="v-call__stage">
        <div className="v-call__remote">
          {/* LiveKit WebRTC active feed if available */}
          {livekitToken && !livekitFailed ? (
            <LiveKitCallCanvas
              cam={cam}
              mic={mic}
              token={livekitToken}
              serverUrl={livekitWsUrl}
              onConnected={handleLiveKitConnected}
              onError={handleLiveKitError}
              onMediaDeviceFailure={handleLiveKitMediaFailure}
              onDisconnected={handleLiveKitDisconnected}
            />
          ) : callState !== "connected" && !livekitFailed ? (
            !fromClient ? (
              <WaitingRoomExperience
                isVet={true}
                vetName={vetName}
                vetInitials={vetInitials}
                petName={petName}
                tutorName={tutorName}
                clock={waitClock}
                waitSecs={waitSecs}
                onBack={() => go("/vet/dashboard")}
              />
            ) : (
              <div className={`v-call__state v-call__state--${callState}`} role="status" aria-live="assertive">
                <span>
                  <Icon name={callState === "error" ? "alert" : "repeat"} size={26} />
                </span>
                <h1>{stateCopy[0]}</h1>
                <p>{stateCopy[1]}</p>
                {callState === "waiting" && (
                  <div className="v-call__state-pill">
                    <i className="is-online" />
                    <span>Sala de espera activa · Notificando a médicos de guardia</span>
                  </div>
                )}
                {callState === "error" && (
                  <Button variant="secondary" icon="repeat" onClick={() => refetchConsultation()}>
                    Reintentar
                  </Button>
                )}
              </div>
            )
          ) : (
            <div className="v-call__professional" role="img" aria-label={`Video de ${remoteName}`}>
              {livekitFailed ? (
                <div className="v-call__recovery">
                  <div className="v-call__pro-rings" aria-hidden="true">
                    <i />
                    <i />
                    <span className="avatar">{remoteInitials}</span>
                  </div>
                  <small>{remoteName}</small>
                  <span className="v-call__pro-sub">
                    {callDegradedReason || "No pudimos conectar el video en vivo. Podés reintentar o continuar por chat."}
                  </span>
                  <div className="v-call__recovery-actions">
                    <button
                      type="button"
                      className="v-call__recovery-btn v-call__recovery-btn--primary"
                      onClick={handleRetryVideoToken}
                    >
                      <Icon name="repeat" size={15} />
                      <span>Reintentar video</span>
                    </button>
                    <button
                      type="button"
                      className="v-call__recovery-btn"
                      onClick={() => setPanel("Chat")}
                    >
                      <Icon name="message" size={15} />
                      <span>Continuar por chat</span>
                    </button>
                  </div>
                  <div className="v-call__recovery-divider" aria-hidden="true" />
                  <div className="v-call__recovery-quiet">
                    <button
                      type="button"
                      className="v-call__recovery-link"
                      disabled={incidentBusy || incidentReported}
                      onClick={() => void handleReportCallIncident()}
                    >
                      <Icon name="alert" size={14} />
                      <span>
                        {incidentReported ? "Fallo reportado" : incidentBusy ? "Reportando..." : "Reportar fallo técnico"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="v-call__recovery-link"
                      aria-expanded={reschedOpen}
                      onClick={() => setReschedOpen((prev) => !prev)}
                    >
                      <Icon name="calendar" size={14} />
                      <span>{reschedCallDone ? "Turno reprogramado" : "Reprogramar turno"}</span>
                    </button>
                  </div>
                  {reschedOpen && (
                    <div className="v-call__recovery-resched hc-reveal">
                      <input
                        type="datetime-local"
                        aria-label="Reprogramar consulta por falla"
                        value={reschedCallAt}
                        onChange={(e) => setReschedCallAt(e.target.value)}
                      />
                      <button
                        type="button"
                        className="v-call__recovery-btn v-call__recovery-btn--primary"
                        disabled={!reschedCallAt || reschedCallDone}
                        onClick={() => void handleQuickRescheduleCall()}
                      >
                        {reschedCallDone ? "Reprogramado" : "Confirmar"}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="v-call__pro-rings" aria-hidden="true">
                    <i />
                    <i />
                    <span className="avatar">{remoteInitials}</span>
                  </div>
                  <small>{remoteName}</small>
                  <span className="v-call__pro-sub">{`Canal telemático HD activo · ${petName}`}</span>
                </>
              )}
            </div>
          )}

          {isTutorReconnecting && (
            <div
              data-testid="tutor-reconnecting-banner"
              role="status"
              aria-live="polite"
              className="v-call__reconnect-banner"
              style={{
                position: "absolute",
                top: "14px",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 15,
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                borderRadius: "999px",
                backgroundColor: "rgba(255, 251, 239, 0.96)",
                border: "1px solid #e98b70",
                color: "#8b2615",
                fontWeight: 700,
                fontSize: "13px",
                boxShadow: "0 4px 14px rgba(24, 60, 58, 0.16)",
              }}
            >
              <Icon name="repeat" size={14} />
              <span>El tutor está reconectando…</span>
            </div>
          )}

          {/* Clinical identification tag (shown only when LiveKit tile chrome is absent) */}
          {(!livekitToken || livekitFailed) && (
            <span className="v-call__tag">
              <b className="v-call__tag-ini" aria-hidden="true">{remoteInitials}</b>
              <span>{callState === "waiting" ? "Sala de espera · Guardia HuelliCam" : remoteName}</span>
            </span>
          )}

          {/* Legal compliance badge */}
          <span className="v-call__tag v-call__hud-pill--secure">
            <Icon name="shield" size={13} />
            <span>Canal Cifrado · SENASA Res. 1442/2021</span>
          </span>
        </div>

        {/* Local user pip with live webcam stream - only when LiveKit room is not active */}
        {!livekitToken && (
          <div className={`v-call__self ${cam ? "" : "is-off"} ${callState === "waiting" ? "v-call__self--waiting" : "v-call__self--active"}`}>
            {cam ? (
              <>
                <span className="v-call__self-avatar" aria-hidden="true">{selfInitials}</span>
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit", zIndex: 1 }}
                />
              </>
            ) : (
              <>
                <span className="v-call__self-avatar" aria-hidden="true">{selfInitials}</span>
                <small>Cámara apagada</small>
              </>
            )}
            <em className="v-call__self-name">Vos ({selfInitials})</em>
            {!mic && (
              <span className="v-call__muted" aria-label="Micrófono silenciado">
                <Icon name="micoff" size={13} />
              </span>
            )}
          </div>
        )}
      </main>

      <nav className="v-call__bar" aria-label="Controles de la llamada">
        <div className="v-call__dock">
          <button
            className={`v-ctl ${mic ? "" : "is-off"}`}
            aria-label={mic ? "Silenciar micrófono" : "Activar micrófono"}
            aria-pressed={!mic}
            onClick={() => setMic(!mic)}
          >
            <Icon name={mic ? "mic" : "micoff"} size={20} />
            <span>{mic ? "Silenciar" : "Activar mic"}</span>
          </button>
          <button
            className={`v-ctl ${cam ? "" : "is-off"}`}
            aria-label={cam ? "Apagar cámara" : "Encender cámara"}
            aria-pressed={!cam}
            onClick={() => setCam(!cam)}
          >
            <Icon name={cam ? "video" : "micoff"} size={20} />
            <span>{cam ? "Apagar cámara" : "Encender"}</span>
          </button>
          <span className="v-call__dock-sep" aria-hidden="true" />
          <button
            className={`v-ctl ${panel === "Chat" ? "is-on" : ""}`}
            aria-pressed={panel === "Chat"}
            onClick={() => setPanel(panel === "Chat" ? "" : "Chat")}
          >
            <Icon name="message" size={20} />
            <span>Chat</span>
            {unreadChat > 0 && panel !== "Chat" && (
              <b className="v-ctl__badge" aria-label={`${unreadChat} mensajes sin leer`}>
                {unreadChat}
              </b>
            )}
          </button>
          <button
            className={`v-ctl ${panel === "Ficha" ? "is-on" : ""}`}
            aria-pressed={panel === "Ficha"}
            onClick={() => setPanel(panel === "Ficha" ? "" : "Ficha")}
          >
            <Icon name="file" size={20} />
            <span>Ficha</span>
          </button>
          {!fromClient && (
            <button
              className={`v-ctl ${panel === "Evolución" ? "is-on" : ""}`}
              aria-pressed={panel === "Evolución"}
              onClick={() => setPanel(panel === "Evolución" ? "" : "Evolución")}
            >
              <Icon name="edit" size={20} />
              <span>Evolución</span>
            </button>
          )}
          <span className="v-call__dock-sep" aria-hidden="true" />
          <button className="v-ctl v-ctl--end" onClick={() => setEnding(true)}>
            <Icon name="phone" size={20} />
            <span>{fromClient ? "Salir" : "Finalizar"}</span>
          </button>
        </div>
      </nav>

      {isMobileCallViewport ? (
        <Drawer.Root open={Boolean(panel)} onOpenChange={(open) => { if (!open) setPanel(""); }}>
          <Drawer.Portal>
            <Drawer.Overlay className="v-avail__scrim" style={{ position: "fixed", inset: 0, zIndex: 99 }} />
            <Drawer.Content
              className="v-call__panel is-open"
              aria-describedby={undefined}
              style={{
                display: "flex",
                zIndex: 100,
                ...(callKeyboardInset > 0
                  ? {
                      bottom: callKeyboardInset,
                      maxHeight: Math.max(240, (callViewportHeight ?? window.innerHeight) - 16),
                    }
                  : undefined),
              }}
            >
              <Drawer.Title className="sr-only">
                {panel === "Chat"
                  ? `Chat con ${chatOtherName}`
                  : panel === "Ficha"
                  ? "Ficha clínica"
                  : "Evolución clínica"}
              </Drawer.Title>
              <span className="v-sheet__grip" aria-hidden="true" style={{ marginTop: 10 }} />
              {panel !== "Chat" && (
                <header className="v-call__panel-header">
                  <div>
                    <span className="v-call__panel-eyebrow">Expediente en vivo</span>
                    <b>{panel === "Ficha" ? "Ficha clínica" : "Evolución clínica"}</b>
                  </div>
                  <button className="wa-icon-btn" onClick={() => setPanel("")} aria-label="Cerrar panel">
                    <Icon name="close" size={17} />
                  </button>
                </header>
              )}
              <div className="v-call__panel-body" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                <div style={{ display: panel === "Chat" ? "flex" : "none", flex: 1, flexDirection: "column", height: "100%", minHeight: 0 }}>
                  <CallChatPanel
                    consultationId={id}
                    otherName={chatOtherName}
                    otherInitials={remoteInitials}
                    otherSubtitle={`${petName} · ${petKind}`}
                    isVet={!fromClient}
                    user={user}
                    onNewIncomingMessage={handleNewIncomingMessage}
                    onClosePanel={() => setPanel("")}
                  />
                </div>
                {panel === "Ficha" && <FichaClinica p={p} />}
                <div style={{ display: panel === "Evolución" ? "block" : "none" }}>
                  <EvolutionEditor p={p} consultationId={id} />
                </div>
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      ) : (
        <aside
          className={`v-call__panel ${panel ? "is-open" : "is-closed"}`}
          style={{
            display: panel ? "flex" : "none",
          }}
          aria-label={
            panel === "Chat"
              ? `Chat con ${chatOtherName}`
              : panel === "Ficha"
              ? "Ficha clínica"
              : "Evolución clínica"
          }
        >
          {panel !== "Chat" && (
            <header className="v-call__panel-header">
              <div>
                <span className="v-call__panel-eyebrow">Expediente en vivo</span>
                <b>{panel === "Ficha" ? "Ficha clínica" : "Evolución clínica"}</b>
              </div>
              <button className="wa-icon-btn" onClick={() => setPanel("")} aria-label="Cerrar panel">
                <Icon name="close" size={17} />
              </button>
            </header>
          )}
          <div className="v-call__panel-body" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: panel === "Chat" ? "flex" : "none", flex: 1, flexDirection: "column", height: "100%", minHeight: 0 }}>
              <CallChatPanel
                consultationId={id}
                otherName={chatOtherName}
                otherInitials={remoteInitials}
                otherSubtitle={`${petName} · ${petKind}`}
                isVet={!fromClient}
                user={user}
                onNewIncomingMessage={handleNewIncomingMessage}
                onClosePanel={() => setPanel("")}
              />
            </div>
            {panel === "Ficha" && <FichaClinica p={p} />}
            <div style={{ display: panel === "Evolución" ? "block" : "none" }}>
              <EvolutionEditor p={p} consultationId={id} />
            </div>
          </div>
        </aside>
      )}

      {ending && (
        <Modal
          title={fromClient ? "Salir de la videollamada" : "Finalizar videollamada"}
          text={
            fromClient
              ? "Vas a salir de la sala. Si necesitás volver, podés retomar la consulta mientras siga activa."
              : "La llamada terminará para todas las personas. Vas a poder revisar el resumen de la consulta."
          }
          cancel="Seguir en la llamada"
          confirm={fromClient ? "Salir de la sala" : "Finalizar llamada"}
          destructive
          onClose={() => setEnding(false)}
          onConfirm={handleFinalize}
        />
      )}
    </div>
  );
}

export default function CallRoom({ id }: { id: string }) {
  const { user } = useAuth();
  return (
    <VetProvider forceEmpty={user?.role !== "VET"}>
      <ClientScopedStyle />
      <Room key={id} id={id} />
    </VetProvider>
  );
}
