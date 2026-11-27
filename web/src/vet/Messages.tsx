import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, Icon, Modal, PageHeader, go } from "../shared";
import { useAuth } from "../context/AuthContext";
import api from "../services/api";
import { addDeletedChatId, clearChatLocalCache, readDeletedChatIds, saveDeletedChatIds } from "../lib/archivedChats";
import { formatBadgeCount, getInitials } from "../lib/formatters";
import { getPatient, type Consult } from "./data";
import { ChatPanel, useVet } from "./vetkit";

interface VetConversationItem {
  id: string;
  consultId?: string;
  petId: string;
  tutorName: string;
  petLabel: string;
  reason: string;
  time: string;
  status: Consult["status"];
  isActive: boolean;
  unread: number;
  avatarText: string;
}

const AVATAR_COLORS = [
  { bg: "#edf6f4", color: "#183c3a" },
  { bg: "#fdf3d7", color: "#9a621c" },
  { bg: "#f2eddd", color: "#315f5d" },
  { bg: "#d9e8e4", color: "#183c3a" },
  { bg: "#fcece9", color: "#ae4d45" },
];

export function MessagesPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { threads, consults, notify } = useVet();
  const [activeChip, setActiveChip] = useState<string>("Todos");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [showNotificationBanner, setShowNotificationBanner] = useState(true);
  const [deletedIds, setDeletedIds] = useState<string[]>(() => readDeletedChatIds(user?.id));
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<VetConversationItem | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);

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

  const conversations: VetConversationItem[] = useMemo(() => {
    if (consults.length > 0) {
      return consults.map((c) => {
        const p = getPatient(c.petId);
        const thread = threads.find((t) => t.petId === c.petId);
        const tutorName = p.tutor || "Tutor";
        return {
          id: c.id,
          consultId: c.id,
          petId: c.petId,
          tutorName,
          petLabel: `${p.name} · ${p.kind}`,
          reason: thread?.last || c.reason || "Consulta clínica",
          time: thread?.lastTime || c.time || "Hoy",
          status: c.status,
          isActive: c.status === "Activa",
          unread: thread?.unread || 0,
          avatarText: getInitials(tutorName, "TU"),
        };
      });
    }

    return threads.map((t) => {
      const p = getPatient(t.petId);
      const tutorName = p.tutor || "Tutor";
      return {
        id: t.id,
        consultId: undefined,
        petId: t.petId,
        tutorName,
        petLabel: `${p.name} · ${p.kind}`,
        reason: t.last || "Conversación clínica",
        time: t.lastTime || "Hoy",
        status: t.online ? "Activa" : "Finalizada",
        isActive: Boolean(t.online),
        unread: t.unread || 0,
        avatarText: getInitials(tutorName, "TU"),
      };
    });
  }, [consults, threads]);

  const deletedSet = useMemo(() => new Set(deletedIds), [deletedIds]);
  const availableConversations = useMemo(
    () => conversations.filter((c) => !deletedSet.has(c.id)),
    [conversations, deletedSet]
  );

  useEffect(() => {
    if (selectedId || availableConversations.length === 0) return;
    const targetPet = new URLSearchParams(window.location.search).get("pet");
    if (targetPet) {
      const match = availableConversations.find((c) => c.petId === targetPet);
      if (match) {
        setSelectedId(match.id);
        setMobileThreadOpen(true);
      }
    }
  }, [availableConversations, selectedId]);

  const handleConfirmDeleteChat = async () => {
    if (!confirmDeleteChat) return;
    const target = confirmDeleteChat;
    setDeletingChat(true);
    try {
      if (target.consultId) {
        await api.delete(`/api/consultations/${target.consultId}/messages`);
      }
      clearChatLocalCache(target.id);
      if (target.consultId) clearChatLocalCache(target.consultId);
      const next = addDeletedChatId(deletedIds, target.id);
      setDeletedIds(next);
      saveDeletedChatIds(user?.id, next);
      if (selectedId === target.id) {
        setSelectedId("");
        setMobileThreadOpen(false);
      }
      void queryClient.invalidateQueries({ queryKey: ["consultations"] });
      notify(`Chat de ${target.tutorName} eliminado permanentemente.`);
      setConfirmDeleteChat(null);
    } catch {
      notify("No se pudo eliminar el chat. Intentá nuevamente.");
    } finally {
      setDeletingChat(false);
    }
  };

  const filteredChats = useMemo(() => {
    return availableConversations.filter((chat) => {
      if (activeChip === "En curso" && chat.status !== "Activa" && chat.status !== "Próxima") {
        return false;
      }
      if (activeChip === "Finalizadas" && chat.status !== "Finalizada" && chat.status !== "Cancelada") {
        return false;
      }
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        chat.tutorName.toLowerCase().includes(q) ||
        chat.petLabel.toLowerCase().includes(q) ||
        chat.reason.toLowerCase().includes(q)
      );
    });
  }, [availableConversations, activeChip, searchQuery]);

  const activeChat =
    filteredChats.find((c) => c.id === selectedId) ||
    availableConversations.find((c) => c.id === selectedId) ||
    filteredChats[0] ||
    availableConversations[0] ||
    null;

  if (availableConversations.length === 0) {
    return (
      <>
        <PageHeader
          eyebrow="Comunicación clínica"
          title="Mensajes"
          description="Conversaciones vinculadas a tus pacientes y consultas."
        />
        <div className="panel" style={{ marginTop: 14 }}>
          <EmptyState
            icon="message"
            title="No tenés conversaciones clínicas activas"
            text="Cuando atiendas o recibas consultas de tutores, vas a poder comunicarte directamente desde acá."
            action="Ir a la cola"
            onAction={() => go("/vet/queue")}
          />
        </div>
      </>
    );
  }

  const chips = ["Todos", "En curso", "Finalizadas"];

  return (
    <div className="hc-messages-page-wrapper">
      <div className="hc-chat-layout" data-testid="vet-messages-chat-container">
        <aside className={`hc-chat-list-column ${mobileThreadOpen ? "is-hidden-mobile" : ""}`}>
          <div className="hc-chat-hero">
            <div className="hc-chat-hero__text">
              <span className="hc-chat-hero__eyebrow">COMUNICACIÓN CON TUTORES</span>
              <h1 className="hc-chat-hero__title">Mensajes</h1>
              <p className="hc-chat-hero__subtitle">
                Seguimiento directo con los tutores de tus pacientes.
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

          <div className="hc-search-bar">
            <Icon name="search" size={17} />
            <input
              type="text"
              aria-label="Buscar conversación"
              placeholder="Buscar un tutor, paciente o consulta..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
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
                title="Ver cola de atención"
                onClick={() => go("/vet/queue")}
                aria-label="Ver cola de atención"
              >
                <Icon name="users" size={17} />
              </button>
            )}
          </div>

          {showNotificationBanner && (
            <div className="hc-notification-card">
              <div className="hc-notification-card__bell">
                <Icon name="bell" size={20} />
              </div>
              <div className="hc-notification-card__content">
                <span>Las alertas de mensajes y guardia están activas. </span>
                <button
                  type="button"
                  className="hc-notification-card__link"
                  onClick={() => go("/vet/settings")}
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

          <div className="wa-chips-bar" style={{ padding: "0 0 4px" }}>
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                className={`wa-chip ${activeChip === chip ? "is-active" : ""}`}
                onClick={() => setActiveChip(chip)}
                data-testid={`vet-chat-chip-${chip.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {chip}
              </button>
            ))}
          </div>

          <div className="hc-doctor-cards-list">
            {filteredChats.length === 0 ? (
              <div
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  color: "var(--ink-soft, #4a635f)",
                  fontSize: 13,
                  background: "#ffffff",
                  borderRadius: 16,
                  border: "1px dashed var(--line, #e8e4da)",
                }}
              >
                No se encontraron conversaciones con ese filtro.
              </div>
            ) : (
              filteredChats.map((chat, idx) => {
                const isSelected = activeChat ? chat.id === activeChat.id : false;
                const hasUnread = chat.unread > 0;
                const themeColor = AVATAR_COLORS[idx % AVATAR_COLORS.length];
                const isMenuOpen = openMenuId === chat.id;

                return (
                  <div
                    key={chat.id}
                    className={`doctor-chat-card-wrap ${isSelected ? "is-active" : ""}`}
                  >
                    <button
                      type="button"
                      className={`doctor-chat-card ${isSelected ? "is-active" : ""} ${hasUnread ? "has-unread" : ""}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        setSelectedId(chat.id);
                        setMobileThreadOpen(true);
                      }}
                    >
                      <div
                        className="doctor-chat-card__avatar"
                        style={{ background: themeColor.bg, color: themeColor.color }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 800 }}>{chat.avatarText}</span>
                        {chat.isActive && <span className="wa-online-badge" />}
                      </div>

                      <div className="doctor-chat-card__content">
                        <div className="doctor-chat-card__header">
                          <span className="doctor-chat-card__name">{chat.tutorName}</span>
                          <span className="doctor-chat-card__time">{chat.time}</span>
                        </div>
                        <div className="doctor-chat-card__footer">
                          <span className="doctor-chat-card__preview">
                            {chat.petLabel} · {chat.reason}
                          </span>
                          {hasUnread && (
                            <span className="doctor-chat-card__badge">{formatBadgeCount(chat.unread)}</span>
                          )}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      className="doctor-chat-card__more"
                      aria-label={`Opciones de conversación con ${chat.tutorName}`}
                      aria-expanded={isMenuOpen}
                      aria-haspopup="menu"
                      data-testid={`vet-chat-more-${chat.id}`}
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

        <section className={`hc-chat-thread-column ${!mobileThreadOpen ? "is-hidden-mobile" : ""}`}>
          {!activeChat ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                padding: 32,
                textAlign: "center",
                color: "var(--ink-soft, #454e4e)",
                background: "var(--cream, #fffbef)",
              }}
            >
              <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink, #183c3a)", marginBottom: 8 }}>
                Mensajería Clínica Huellicam
              </h2>
              <p style={{ maxWidth: 420, fontSize: 14, lineHeight: 1.5 }}>
                Seleccioná una conversación de la lista para ver el historial y comunicarte con el tutor.
              </p>
            </div>
          ) : (
            <ChatPanel
              key={activeChat.id}
              petId={activeChat.petId}
              consultationId={activeChat.consultId}
              header
              useInitialsAvatar
              onBack={() => setMobileThreadOpen(false)}
              consultLabel={activeChat.reason}
              actions={
                <>
                  <Button variant="soft" icon="file" onClick={() => go(`/vet/patients/${activeChat.petId}`)}>
                    Ficha
                  </Button>
                  {activeChat.consultId && (
                    <Button
                      variant="secondary"
                      icon="video"
                      onClick={() => go(`/vet/consultations/${activeChat.consultId}`)}
                    >
                      Consulta
                    </Button>
                  )}
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
                </>
              }
            />
          )}
        </section>
      </div>

      {confirmDeleteChat && (
        <Modal
          title="Eliminar chat"
          text={`¿Querés eliminar la conversación con ${confirmDeleteChat.tutorName}? Se borrarán permanentemente todos los mensajes y archivos enviados en este chat.`}
          cancel="Cancelar"
          confirm={deletingChat ? "Eliminando..." : "Eliminar chat"}
          destructive
          onClose={() => !deletingChat && setConfirmDeleteChat(null)}
          onConfirm={() => { void handleConfirmDeleteChat(); }}
        />
      )}
    </div>
  );
}
