import { BridgeSessionUser, Role, User, WebViewBridgeMessage } from '../types';

export const WEB_TOKEN_STORAGE_KEY = 'huellicam_token';
export const WEB_USER_STORAGE_KEY = 'huellicam_user';
export const DEFAULT_WEB_ENTRY_PATH = '/login';

const STORAGE_PREFIX = 'window.localStorage';

/**
 * Builds JS to seed web client storage before content scripts execute.
 */
export function buildAuthSeedScript(accessToken: string, user: User): string {
  const token = JSON.stringify(accessToken);
  const userJson = JSON.stringify(user);

  return (
    'try{' +
    `${STORAGE_PREFIX}.setItem(${JSON.stringify(WEB_TOKEN_STORAGE_KEY)},${token});` +
    `${STORAGE_PREFIX}.setItem(${JSON.stringify(WEB_USER_STORAGE_KEY)},${userJson});` +
    '}catch(e){};' +
    'true;'
  );
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
]);

const HOST_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/;
const PATH_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*([^?#]*)/;
const EXTERNAL_PROTOCOLS = ['mailto:', 'tel:', 'sms:', 'whatsapp:', 'intent:', 'market:'];
const ROLES: ReadonlySet<Role> = new Set(['CLIENT', 'VET', 'ADMIN']);

export function parseHost(url: string): string | null {
  const match = HOST_PATTERN.exec(url.trim());
  if (!match) return null;
  return match[1].replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackUrl(url: string): boolean {
  const host = parseHost(url);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

export function normalizeWebBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function resolveWebAppUrl(
  baseUrl: string,
  path: string = DEFAULT_WEB_ENTRY_PATH
): string {
  const base = normalizeWebBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export function resolveWebCallUrl(baseUrl: string, consultationId: string): string {
  return resolveWebAppUrl(baseUrl, `/call/${encodeURIComponent(consultationId)}`);
}

export function resolveWebBaseUrlConfig(
  configuredUrl: string | undefined,
  isDev: boolean
): { url: string; error: null } | { url: null; error: string } {
  const trimmed = configuredUrl?.trim() || '';
  if (!trimmed) {
    if (isDev) {
      return { url: 'http://localhost:5173', error: null };
    }
    return {
      url: null,
      error:
        'EXPO_PUBLIC_WEB_URL no está configurada para este build. Configurá la URL HTTPS de Huellicam antes de compilar.',
    };
  }

  if (!parseHost(trimmed)) {
    return {
      url: null,
      error: `La URL configurada en EXPO_PUBLIC_WEB_URL no es válida: "${trimmed}".`,
    };
  }

  if (!isDev && isLoopbackUrl(trimmed)) {
    return {
      url: null,
      error:
        'EXPO_PUBLIC_WEB_URL apunta a localhost en un build standalone. Reemplazala por una URL accesible o HTTPS.',
    };
  }

  return { url: normalizeWebBaseUrl(trimmed), error: null };
}

export function isCallRouteUrl(url: string): boolean {
  const match = PATH_PATTERN.exec(url.trim());
  const path = match?.[1] || '';
  return path === '/call' || path.startsWith('/call/');
}

export function shouldOpenExternally(targetUrl: string, appBaseUrl: string): boolean {
  const trimmed = targetUrl.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower === 'about:blank' ||
    lower.startsWith('blob:') ||
    lower.startsWith('data:')
  ) {
    return false;
  }

  if (EXTERNAL_PROTOCOLS.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }

  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }

  const targetHost = parseHost(trimmed);
  const baseHost = parseHost(appBaseUrl);
  if (!targetHost || !baseHost) return false;

  return targetHost !== baseHost;
}

export function buildNativeNavigateScript(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return (
    'try{' +
    `window.dispatchEvent(new CustomEvent("huellicam:navigate",{detail:{path:${JSON.stringify(
      normalized
    )}}}));` +
    '}catch(e){};' +
    'true;'
  );
}

function isBridgeSessionUser(candidate: unknown): candidate is BridgeSessionUser {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const obj = candidate as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length > 0 &&
    typeof obj.email === 'string' &&
    typeof obj.role === 'string' &&
    ROLES.has(obj.role as Role) &&
    typeof obj.firstName === 'string' &&
    typeof obj.lastName === 'string'
  );
}

export function parseWebViewBridgeMessage(raw: string): WebViewBridgeMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    switch (obj.type) {
      case 'page:ready':
      case 'auth:logout':
      case 'wakelock:acquire':
      case 'wakelock:release':
      case 'call:ended':
        return { type: obj.type };
      case 'auth:session':
        if (typeof obj.token === 'string' && obj.token.length > 0 && isBridgeSessionUser(obj.user)) {
          return { type: 'auth:session', token: obj.token, user: obj.user };
        }
        return null;
      case 'print:request':
        if (typeof obj.title === 'string' && typeof obj.url === 'string') {
          return {
            type: 'print:request',
            title: obj.title,
            url: obj.url,
            html: typeof obj.html === 'string' ? obj.html : undefined,
          };
        }
        return null;
      case 'external:open':
        if (typeof obj.url === 'string' && obj.url.trim().length > 0) {
          return { type: 'external:open', url: obj.url.trim() };
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Hardened React Native WebView configuration for full SPA + LiveKit WebRTC support.
 */
export const HARDENED_WEBVIEW_CONFIG = {
  domStorageEnabled: true,
  javaScriptEnabled: true,
  sharedCookiesEnabled: true,
  thirdPartyCookiesEnabled: true,
  allowsInlineMediaPlayback: true,
  mediaPlaybackRequiresUserAction: false,
  allowFileAccess: true,
  mediaCapturePermissionGrantType: 'grant' as const,
  originWhitelist: ['http://*', 'https://*'],
  setSupportMultipleWindows: false,
  pullToRefreshEnabled: false,
  bounces: false,
} as const;

export function handleContentProcessTermination(
  event: { nativeEvent?: unknown },
  webview: { reload: () => void } | null
): boolean {
  if (event?.nativeEvent && webview?.reload) {
    webview.reload();
    return true;
  }
  return false;
}
