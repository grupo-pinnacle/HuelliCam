import type { User } from '../types';

export interface MobileBridgeSessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: User['role'];
}

export type MobileBridgeOutgoingMessage =
  | { type: 'page:ready' }
  | { type: 'auth:session'; token: string; user: MobileBridgeSessionUser }
  | { type: 'auth:logout' }
  | { type: 'wakelock:acquire' }
  | { type: 'wakelock:release' }
  | { type: 'call:ended' }
  | { type: 'print:request'; title: string; url: string; html?: string }
  | { type: 'external:open'; url: string };

interface ReactNativeWebViewBridge {
  postMessage: (data: string) => void;
}

declare global {
  interface Window {
    ReactNativeWebView?: ReactNativeWebViewBridge;
  }
}

export function isReactNativeWebView(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.ReactNativeWebView?.postMessage === 'function'
  );
}

export function postMobileBridgeMessage(message: MobileBridgeOutgoingMessage): boolean {
  if (!isReactNativeWebView()) return false;
  try {
    window.ReactNativeWebView!.postMessage(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export function notifyMobileAuthSession(
  token: string,
  user: MobileBridgeSessionUser
): void {
  if (!token || !user?.id) return;
  postMobileBridgeMessage({
    type: 'auth:session',
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
  });
}

export function notifyMobileAuthLogout(): void {
  postMobileBridgeMessage({ type: 'auth:logout' });
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Packages a DOM element into a standalone HTML document for native `expo-print`
 * PDF generation / system Print dialog inside Android/iOS WebView.
 */
export function buildPrintableHtmlSnapshot(
  element: HTMLElement | null,
  title: string
): string | undefined {
  if (!element || typeof document === 'undefined') return undefined;

  const headNodes = Array.from(
    document.querySelectorAll('style, link[rel="stylesheet"]')
  )
    .map((node) => node.outerHTML)
    .join('\n');

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const baseTag = origin ? `<base href="${escapeHtmlAttr(origin)}/" />` : '';

  return [
    '<!DOCTYPE html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    baseTag,
    `<title>${escapeHtmlAttr(title)}</title>`,
    headNodes,
    `<style>
      @page { size: auto; margin: 14mm; }
      body { margin: 0; padding: 16px; background: #ffffff; color: #183c3a; font-family: "Manrope", system-ui, -apple-system, sans-serif; }
      .no-print, .print\\:hidden { display: none !important; }
      img { max-width: 100%; height: auto; }
    </style>`,
    '</head>',
    '<body>',
    element.outerHTML,
    '</body>',
    '</html>',
  ].join('\n');
}

export function requestMobilePrintOrFallback(options?: {
  title?: string;
  url?: string;
  element?: HTMLElement | null;
}): void {
  const title = options?.title || 'Documento HuelliCam';
  const url =
    options?.url ||
    (typeof window !== 'undefined' ? window.location.href : '');

  if (isReactNativeWebView()) {
    const html = buildPrintableHtmlSnapshot(options?.element ?? null, title);
    postMobileBridgeMessage({
      type: 'print:request',
      title,
      url,
      html,
    });
    return;
  }

  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print();
  }
}

export function requestMobileExternalOpen(url: string): boolean {
  if (!isReactNativeWebView()) return false;
  return postMobileBridgeMessage({ type: 'external:open', url });
}
