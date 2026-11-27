import React, { useEffect, useState } from 'react';
import api from '../services/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTECTED_MEDIA_PATH_RE = /\/api\/media\/[^/?#]+/i;

/**
 * Checks whether a URL targets the bearer-protected `/api/media/:id` endpoint.
 */
export function isProtectedMediaUrl(url?: string | null): boolean {
  if (!url) return false;
  return PROTECTED_MEDIA_PATH_RE.test(url.trim());
}

/**
 * Normalizes a raw `attachmentUrl` (UUID, relative `/api/media/:id`, or full URL).
 */
export function normalizeMediaUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (UUID_RE.test(trimmed)) return `/api/media/${trimmed}`;
  return trimmed;
}

/**
 * Builds an absolute URL compatible with backend `z.string().url()` validation
 * (e.g. `PATCH /api/users/profile` `photoUrl`).
 */
export function buildAbsoluteMediaUrl(mediaIdOrPath: string): string {
  const normalized = normalizeMediaUrl(mediaIdOrPath) || mediaIdOrPath;
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  const base =
    api.defaults.baseURL ||
    (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? window.location.origin
      : 'http://localhost:3001');
  try {
    return new URL(normalized, base).toString();
  } catch {
    return normalized;
  }
}

/**
 * Fetches a protected `/api/media/:id` binary payload with Authorization Bearer
 * and returns a short-lived Object URL. Caller owns `URL.revokeObjectURL`.
 */
export async function fetchAuthenticatedMediaBlobUrl(
  url: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await api.get<Blob>(url, {
    responseType: 'blob',
    signal,
  });
  const blob =
    res.data instanceof Blob
      ? res.data
      : new Blob([typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')]);
  return URL.createObjectURL(blob);
}

/**
 * Downloads an attachment safely, sending Bearer auth when targeting `/api/media/:id`.
 */
export async function downloadAuthenticatedMedia(
  url: string,
  filename = 'adjunto-clinico'
): Promise<void> {
  if (!url) return;
  if (!isProtectedMediaUrl(url)) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  const blobUrl = await fetchAuthenticatedMediaBlobUrl(url);
  try {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    window.setTimeout(() => {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {}
    }, 1000);
  }
}

/**
 * Resolves a displayable URL for `<img>` or CSS backgrounds, transparently exchanging
 * `/api/media/:id` paths for authenticated Blob Object URLs with cleanup on unmount.
 */
export function useAuthenticatedMediaUrl(url?: string | null): string | undefined {
  const normalized = normalizeMediaUrl(url);
  const protectedTarget = isProtectedMediaUrl(normalized);
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!normalized || !protectedTarget) {
      setBlobUrl(undefined);
      return;
    }

    const controller = new AbortController();
    let activeObjectUrl: string | null = null;

    fetchAuthenticatedMediaBlobUrl(normalized, controller.signal)
      .then((created) => {
        if (controller.signal.aborted) {
          try {
            URL.revokeObjectURL(created);
          } catch {}
          return;
        }
        activeObjectUrl = created;
        setBlobUrl(created);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setBlobUrl(undefined);
        }
      });

    return () => {
      controller.abort();
      if (activeObjectUrl) {
        try {
          URL.revokeObjectURL(activeObjectUrl);
        } catch {}
      }
    };
  }, [normalized, protectedTarget]);

  if (!normalized) return undefined;
  return protectedTarget ? blobUrl : normalized;
}

export interface AuthenticatedMediaImageProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
}

export const AuthenticatedMediaImage: React.FC<AuthenticatedMediaImageProps> = ({
  src,
  alt = '',
  ...rest
}) => {
  const [failed, setFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const resolvedSrc = useAuthenticatedMediaUrlState(src, setFailed);

  useEffect(() => {
    setImgFailed(false);
  }, [src]);

  if (!src) return null;
  if (!resolvedSrc && !failed) {
    return React.createElement('div', {
      'data-testid': 'authenticated-media-loading',
      'aria-busy': 'true',
      className: `rounded-lg bg-[#e4dfd2]/60 animate-pulse ${rest.className || ''}`,
      style: { minHeight: 120, minWidth: 160, ...rest.style },
    });
  }
  if (failed || imgFailed || !resolvedSrc) {
    return React.createElement(
      'div',
      {
        'data-testid': 'authenticated-media-error',
        role: 'img',
        'aria-label': alt || 'Imagen no disponible',
        className: `rounded-lg border border-[#e4dfd2] bg-[#f2eddd] px-3 py-4 text-xs text-[#4a6866] flex items-center justify-center ${rest.className || ''}`,
        style: { minHeight: 96, ...rest.style },
      },
      alt || 'Archivo multimedia no disponible'
    );
  }
  return React.createElement('img', {
    src: resolvedSrc,
    alt,
    ...rest,
    onError: (e: React.SyntheticEvent<HTMLImageElement>) => {
      setImgFailed(true);
      rest.onError?.(e);
    },
  });
};

function useAuthenticatedMediaUrlState(
  rawUrl: string | null | undefined,
  onFailed: (failed: boolean) => void
): string | undefined {
  const normalized = normalizeMediaUrl(rawUrl);
  const protectedTarget = isProtectedMediaUrl(normalized);
  const [blobUrl, setBlobUrl] = useState<string | undefined>(() =>
    protectedTarget ? undefined : normalized
  );

  useEffect(() => {
    if (!normalized) {
      onFailed(false);
      setBlobUrl(undefined);
      return;
    }

    if (!protectedTarget) {
      onFailed(false);
      setBlobUrl(normalized);
      return;
    }

    const controller = new AbortController();
    let activeObjectUrl: string | undefined;
    onFailed(false);
    setBlobUrl(undefined);

    fetchAuthenticatedMediaBlobUrl(normalized, controller.signal)
      .then((created) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(created);
          return;
        }
        activeObjectUrl = created;
        onFailed(false);
        setBlobUrl(created);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          onFailed(true);
          setBlobUrl(undefined);
        }
      });

    return () => {
      controller.abort();
      if (activeObjectUrl) {
        try {
          URL.revokeObjectURL(activeObjectUrl);
        } catch {}
      }
    };
  }, [normalized, protectedTarget, onFailed]);

  if (!normalized) return undefined;
  return protectedTarget ? blobUrl : normalized;
}
