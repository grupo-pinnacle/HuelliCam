import React, { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useFocusTrap } from './DialogOverlay';
import {
  downloadAuthenticatedMedia,
  fetchAuthenticatedMediaBlobUrl,
  isProtectedMediaUrl,
  normalizeMediaUrl,
} from '../../lib/authenticatedMedia';

export interface ClinicalMediaViewerProps {
  open: boolean;
  url: string | null | undefined;
  title: string;
  mimeType?: string;
  subtitle?: string;
  onClose: () => void;
}

function isPdfMedia(url?: string, mimeType?: string): boolean {
  if (mimeType && mimeType.toLowerCase().includes('pdf')) return true;
  if (url && /\.pdf(\?|#|$)/i.test(url)) return true;
  return false;
}

export const ClinicalMediaViewer: React.FC<ClinicalMediaViewerProps> = ({
  open,
  url,
  title,
  mimeType,
  subtitle,
  onClose,
}) => {
  const normalized = normalizeMediaUrl(url);
  const protectedTarget = isProtectedMediaUrl(normalized);
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(Boolean(open && normalized), frameRef, {
    onEscape: onClose,
    initialFocusRef: closeRef,
  });

  useEffect(() => {
    setZoomed(false);
    if (!open || !normalized) {
      setResolvedUrl(undefined);
      setError(null);
      return;
    }

    if (!protectedTarget) {
      setResolvedUrl(normalized);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let createdBlob: string | null = null;
    setLoading(true);
    setError(null);
    setResolvedUrl(undefined);

    fetchAuthenticatedMediaBlobUrl(normalized, controller.signal)
      .then((blobUrl) => {
        if (controller.signal.aborted) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {}
          return;
        }
        createdBlob = blobUrl;
        setResolvedUrl(blobUrl);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('No pudimos cargar el archivo clínico. Verificá tu conexión e intentá nuevamente.');
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
      if (createdBlob) {
        try {
          URL.revokeObjectURL(createdBlob);
        } catch {}
      }
    };
  }, [open, normalized, protectedTarget]);

  if (!open || !normalized) return null;

  const isPdf = isPdfMedia(normalized, mimeType);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadAuthenticatedMedia(normalized, title || 'archivo-clinico');
    } catch {
      setError('No pudimos descargar el archivo.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[#06241D]/75 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={`Visor de archivo clínico: ${title}`}
      data-testid="clinical-media-viewer"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar visor"
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={frameRef}
        className="relative z-10 flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[#E8E2D5] bg-[#FAF8F5] shadow-2xl"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E8E2D5] bg-white px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-extrabold text-[#06241D]">{title}</h2>
            {subtitle && <p className="truncate text-xs text-[#4a6866]">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {!isPdf && resolvedUrl && !error && (
              <button
                type="button"
                onClick={() => setZoomed((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[#E8E2D5] bg-white px-3 py-1.5 text-xs font-bold text-[#06241D] hover:bg-[#FAF8F5]"
                aria-label={zoomed ? 'Reducir imagen' : 'Ampliar imagen'}
              >
                {zoomed ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
                <span>{zoomed ? 'Ajustar' : 'Ampliar'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B4F4A] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#093d39] disabled:opacity-60"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{downloading ? 'Descargando...' : 'Descargar'}</span>
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Cerrar visor"
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-[#E8E2D5] bg-white text-[#06241D] hover:bg-[#FAF8F5]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex min-h-[320px] flex-1 items-center justify-center overflow-auto bg-[#F2EDDD] p-4">
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-xs font-semibold text-[#4a6866]" aria-busy="true">
              <FileText className="h-8 w-8 animate-pulse text-[#0B4F4A]" />
              <span>Cargando archivo clínico...</span>
            </div>
          ) : error ? (
            <div className="max-w-md rounded-2xl border border-[#E8E2D5] bg-white p-6 text-center shadow-xs" role="alert">
              <p className="text-sm font-bold text-[#06241D]">{error}</p>
              <button
                type="button"
                onClick={handleDownload}
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-[#0B4F4A] px-3 py-1.5 text-xs font-bold text-[#0B4F4A]"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Intentar descarga directa
              </button>
            </div>
          ) : isPdf && resolvedUrl ? (
            <iframe
              title={title}
              src={resolvedUrl}
              className="h-[72vh] w-full rounded-xl border border-[#E8E2D5] bg-white"
            />
          ) : resolvedUrl ? (
            <img
              src={resolvedUrl}
              alt={title}
              onClick={() => setZoomed((v) => !v)}
              className={`max-h-[75vh] rounded-xl object-contain transition-transform duration-150 ${
                zoomed ? 'scale-150 cursor-zoom-out' : 'cursor-zoom-in'
              }`}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default ClinicalMediaViewer;
