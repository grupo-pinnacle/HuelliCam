import { useRef, useState, type ReactNode, type Ref } from "react";
import { Icon } from "../../shared";
import { WhatsAppCheck } from "../call/WhatsAppCheck";
import { AuthenticatedMediaImage, downloadAuthenticatedMedia } from "../../lib/authenticatedMedia";

export interface ClinicalChatDoc {
  title: string;
  sub: string;
  bannerTag?: string;
  bannerTitle?: string;
  fileUrl?: string;
  isImage?: boolean;
}

export interface ClinicalChatImageThumb {
  src: string;
  caption: string;
  pos?: string;
  onZoom?: () => void;
}

export interface ClinicalChatMessage {
  id: string;
  mine: boolean;
  senderName?: string;
  text?: string;
  time: string;
  state?: "sending" | "sent" | "delivered" | "read" | "failed";
  doc?: ClinicalChatDoc;
  imageThumb?: ClinicalChatImageThumb;
}

interface ClinicalChatThreadProps {
  className?: string;
  ariaLabel: string;
  showHeader?: boolean;
  contactName: string;
  contactInitials?: string;
  avatarNode?: ReactNode;
  statusText: string;
  isOnline?: boolean;
  onBack?: () => void;
  headerActions?: ReactNode;
  messages: ClinicalChatMessage[];
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  placeholder?: string;
  emptySubtitle?: string;
  quickReplies?: readonly string[];
  onAttachFile?: (file: File, isImage: boolean) => void;
  onDownloadDoc?: (doc: ClinicalChatDoc) => void;
  endRef?: Ref<HTMLDivElement>;
}

function defaultDownload(doc: ClinicalChatDoc) {
  if (!doc.fileUrl) return;
  void downloadAuthenticatedMedia(doc.fileUrl, doc.title || "adjunto-clinico").catch(() => {});
}

export function ClinicalChatThread({
  className = "",
  ariaLabel,
  showHeader = true,
  contactName,
  contactInitials = "HC",
  avatarNode,
  statusText,
  isOnline = false,
  onBack,
  headerActions,
  messages,
  value,
  onChange,
  onSend,
  placeholder,
  emptySubtitle = "Todo mensaje, indicación médica y archivo adjunto queda registrado en el expediente de la consulta.",
  quickReplies,
  onAttachFile,
  onDownloadDoc,
  endRef,
}: ClinicalChatThreadProps) {
  const [showQuick, setShowQuick] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    isImage: boolean
  ) => {
    const file = e.target.files?.[0];
    if (file && onAttachFile) {
      onAttachFile(file, isImage);
    }
    setShowAttachMenu(false);
    e.target.value = "";
  };

  return (
    <section
      className={`wa-chat-pane ${className}`.trim()}
      aria-label={ariaLabel}
    >
      <style>{`
        @keyframes waSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      {showHeader && (
        <header className="wa-chat-pane__header">
          <div className="wa-chat-pane__header-contact">
            {onBack && (
              <button
                type="button"
                className="wa-icon-btn"
                onClick={onBack}
                aria-label="Volver a conversaciones"
              >
                <Icon name="left" size={18} />
              </button>
            )}
            <div className="wa-chat-pane__header-avatar">
              {avatarNode ?? <span>{contactInitials}</span>}
              {isOnline && <span className="wa-online-badge" />}
            </div>
            <div className="wa-chat-pane__header-info">
              <h2>{contactName}</h2>
              <span className={isOnline ? "is-online" : ""}>{statusText}</span>
            </div>
          </div>

          {headerActions && (
            <div className="wa-chat-pane__header-actions">{headerActions}</div>
          )}
        </header>
      )}

      <div className="wa-chat-body">
        <div
          className="clinical-security-pill"
          data-testid="clinical-security-note"
        >
          <Icon name="shield" size={14} />
          <span>
            Canal clínico auditado · Los mensajes forman parte de la historia
            clínica
          </span>
        </div>

        {messages.length === 0 ? (
          <div
            className="clinical-empty-conversation"
            data-testid="empty-conversation-notice"
          >
            <Icon name="message" size={26} />
            <p>
              Iniciá la comunicación con <strong>{contactName}</strong>.
            </p>
            <span>{emptySubtitle}</span>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.imageThumb) {
              return (
                <div
                  key={msg.id}
                  className={`wa-bubble ${msg.mine ? "wa-bubble--sent" : "wa-bubble--received"}`}
                  data-testid="chat-message-bubble"
                  style={{ maxWidth: 280 }}
                >
                  <button
                    type="button"
                    onClick={msg.imageThumb.onZoom}
                    style={{
                      border: 0,
                      padding: 0,
                      background: "none",
                      borderRadius: 8,
                      overflow: "hidden",
                      display: "block",
                      cursor: msg.imageThumb.onZoom ? "pointer" : "default",
                    }}
                    aria-label={`Ampliar fotografía: ${msg.imageThumb.caption}`}
                  >
                    <AuthenticatedMediaImage
                      src={msg.imageThumb.src}
                      alt={msg.imageThumb.caption}
                      style={{
                        width: "100%",
                        height: 160,
                        objectFit: "cover",
                        objectPosition: msg.imageThumb.pos,
                        display: "block",
                      }}
                      loading="lazy"
                    />
                  </button>
                  <div className="wa-bubble__meta">
                    <span>
                      {msg.imageThumb.caption} · {msg.time}
                    </span>
                    {msg.mine && <WhatsAppCheck state={msg.state ?? "read"} />}
                  </div>
                </div>
              );
            }

            if (msg.doc) {
              return (
                <div
                  key={msg.id}
                  className={`wa-bubble wa-doc-bubble ${msg.mine ? "wa-bubble--sent" : "wa-bubble--received"}`}
                  data-testid="chat-message-bubble"
                >
                  {!msg.mine && msg.senderName && (
                    <div className="wa-bubble__sender">{msg.senderName}</div>
                  )}
                  <div className="wa-doc-card">
                    {msg.doc.isImage && msg.doc.fileUrl && (
                      <div
                        className="wa-doc-card__img-preview"
                        style={{
                          borderRadius: 8,
                          overflow: "hidden",
                          marginBottom: 8,
                        }}
                      >
                        <AuthenticatedMediaImage
                          src={msg.doc.fileUrl}
                          alt={msg.doc.title}
                          style={{
                            width: "100%",
                            maxHeight: 220,
                            objectFit: "cover",
                            display: "block",
                          }}
                        />
                      </div>
                    )}
                    <div className="wa-doc-card__banner">
                      <span className="wa-doc-card__banner-tag">
                        {msg.doc.bannerTag || "DOCUMENTO CLÍNICO"}
                      </span>
                      <div className="wa-doc-card__banner-preview">
                        <Icon name={msg.doc.isImage ? "image" : "file"} size={22} />
                        <span>
                          {msg.doc.bannerTitle || "HuelliCam · Expediente Clínico"}
                        </span>
                      </div>
                    </div>

                    <div className="wa-doc-card__body">
                      <div
                        className="wa-pdf-badge"
                        style={{
                          background: msg.doc.isImage
                            ? "var(--teal, #609f9c)"
                            : "var(--danger, #ae4d45)",
                        }}
                      >
                        {msg.doc.isImage ? "IMG" : "PDF"}
                      </div>
                      <div className="wa-doc-card__info">
                        <div className="wa-doc-card__title" title={msg.doc.title}>
                          {msg.doc.title}
                        </div>
                        <div className="wa-doc-card__sub">{msg.doc.sub}</div>
                      </div>
                      {(msg.doc.fileUrl || onDownloadDoc) && (
                        <button
                          type="button"
                          className="wa-doc-card__download"
                          onClick={() =>
                            onDownloadDoc
                              ? onDownloadDoc(msg.doc!)
                              : defaultDownload(msg.doc!)
                          }
                          title="Descargar documento"
                          aria-label="Descargar documento"
                        >
                          <Icon name="download" size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  {msg.text && (
                    <p
                      className="wa-bubble__text"
                      style={{ padding: "4px 8px 0" }}
                    >
                      {msg.text}
                    </p>
                  )}
                  <div className="wa-bubble__meta">
                    <span>{msg.time}</span>
                    {msg.mine && <WhatsAppCheck state={msg.state ?? "read"} />}
                  </div>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`wa-bubble ${msg.mine ? "wa-bubble--sent" : "wa-bubble--received"}`}
                data-testid="chat-message-bubble"
              >
                {!msg.mine && msg.senderName && (
                  <div className="wa-bubble__sender">{msg.senderName}</div>
                )}
                <p className="wa-bubble__text">{msg.text}</p>
                <div className="wa-bubble__meta">
                  <span>{msg.time}</span>
                  {msg.mine && <WhatsAppCheck state={msg.state ?? "read"} />}
                </div>
              </div>
            );
          })
        )}

        <div ref={endRef} />
      </div>

      {onAttachFile && (
        <>
          <input
            type="file"
            ref={pdfInputRef}
            style={{ display: "none" }}
            accept=".pdf,.doc,.docx,application/pdf"
            onChange={(e) => handleFileChange(e, false)}
            data-testid="file-upload-pdf"
          />
          <input
            type="file"
            ref={imgInputRef}
            style={{ display: "none" }}
            accept="image/*,video/*"
            onChange={(e) => handleFileChange(e, true)}
            data-testid="file-upload-image"
          />

          {showAttachMenu && (
            <div className="wa-attach-popup" role="menu" aria-label="Adjuntar archivo clínico">
              <button
                className="wa-attach-item"
                type="button"
                onClick={() => pdfInputRef.current?.click()}
                data-testid="attach-pdf-btn"
              >
                <i style={{ background: "var(--danger, #ae4d45)", width: 32, height: 32, borderRadius: "50%", color: "#fff", display: "grid", placeItems: "center" }}>
                  <Icon name="file" size={16} />
                </i>
                <span>Documento PDF</span>
              </button>
              <button
                className="wa-attach-item"
                type="button"
                onClick={() => imgInputRef.current?.click()}
                data-testid="attach-img-btn"
              >
                <i style={{ background: "var(--teal, #609f9c)", width: 32, height: 32, borderRadius: "50%", color: "#fff", display: "grid", placeItems: "center" }}>
                  <Icon name="image" size={16} />
                </i>
                <span>Fotos y videos</span>
              </button>
              <button
                className="wa-attach-item"
                type="button"
                onClick={() => pdfInputRef.current?.click()}
                data-testid="attach-prescription-btn"
              >
                <i style={{ background: "var(--teal-dark, #315f5d)", width: 32, height: 32, borderRadius: "50%", color: "#fff", display: "grid", placeItems: "center" }}>
                  <Icon name="pill" size={16} />
                </i>
                <span>Receta médica</span>
              </button>
            </div>
          )}
        </>
      )}

      {quickReplies && quickReplies.length > 0 && showQuick && (
        <div className="v-quick" role="menu" aria-label="Respuestas rápidas">
          <span className="eyebrow">Respuestas rápidas</span>
          {quickReplies.map((q) => (
            <button
              type="button"
              role="menuitem"
              key={q}
              onClick={() => {
                onChange(q);
                setShowQuick(false);
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <footer className="wa-chat-footer">
        <div className="wa-chat-footer__actions">
          {onAttachFile && (
            <button
              type="button"
              className="wa-icon-btn"
              title="Adjuntar estudio o receta"
              onClick={() => {
                setShowAttachMenu((v) => !v);
                setShowQuick(false);
              }}
              aria-label="Adjuntar"
              aria-expanded={showAttachMenu}
            >
              <Icon name="paperclip" size={19} />
            </button>
          )}
          {quickReplies && quickReplies.length > 0 && (
            <button
              type="button"
              className={`wa-icon-btn v-quick-toggle ${showQuick ? "is-open" : ""}`}
              onClick={() => {
                setShowQuick((v) => !v);
                setShowAttachMenu(false);
              }}
              aria-label="Respuestas rápidas"
              aria-expanded={showQuick}
              title="Respuestas rápidas"
            >
              <Icon name="zap" size={17} />
            </button>
          )}
        </div>

        <div className="wa-input-pill">
          <input
            type="text"
            aria-label="Escribir mensaje"
            placeholder={placeholder || `Escribir a ${contactName}…`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSend();
              }
            }}
            data-testid="chat-message-input"
          />
        </div>

        <button
          type="button"
          className="wa-send-btn"
          disabled={!value.trim()}
          onClick={onSend}
          aria-label="Enviar mensaje"
          data-testid="chat-send-btn"
        >
          <Icon name="send" size={17} />
        </button>
      </footer>
    </section>
  );
}

export default ClinicalChatThread;
