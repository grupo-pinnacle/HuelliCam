import { Role } from '../types';

/**
 * Maps `huellicam://` URIs and push notification payloads directly to Web SPA routes.
 */
export const APP_SCHEME = 'huellicam';

export type DeepLinkScreen =
  | 'call'
  | 'consultation'
  | 'prescriptions'
  | 'chat'
  | 'review';

interface ScreenContract {
  param: string;
}

const SCREENS: Record<DeepLinkScreen, ScreenContract> = {
  call: { param: 'consultationId' },
  consultation: { param: 'id' },
  prescriptions: { param: 'id' },
  chat: { param: 'consultationId' },
  review: { param: 'consultationId' },
};

export interface DeepLinkTarget {
  screen: DeepLinkScreen;
  param: string;
  id: string;
}

const SCHEME_SEPARATOR = '://';

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function parseDeepLink(url: string | null | undefined): DeepLinkTarget | null {
  if (typeof url !== 'string') return null;

  const trimmed = url.trim();
  const separatorIndex = trimmed.indexOf(SCHEME_SEPARATOR);
  if (separatorIndex === -1) return null;

  if (trimmed.slice(0, separatorIndex).toLowerCase() !== APP_SCHEME) return null;

  const path = trimmed.slice(separatorIndex + SCHEME_SEPARATOR.length).split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter((segment) => segment.length > 0);

  if (segments.length !== 2) return null;

  const [screenSegment, idSegment] = segments;
  const screen = screenSegment as DeepLinkScreen;
  const contract = SCREENS[screen];
  if (!contract) return null;

  const id = decodeSegment(idSegment);
  if (!id) return null;

  return { screen, param: contract.param, id };
}

/**
 * Maps a parsed target to the Web SPA route matching the active user's role.
 */
export function buildDeepLinkHref(
  target: DeepLinkTarget,
  role: Role | null = 'CLIENT'
): string {
  const encodedId = encodeURIComponent(target.id);
  const rolePrefix = role === 'VET' ? '/vet' : '/client';

  switch (target.screen) {
    case 'call':
    case 'review':
      return `/call/${encodedId}`;
    case 'prescriptions':
      return `/prescriptions/${encodedId}`;
    case 'consultation':
      return `${rolePrefix}/consultations/${encodedId}`;
    case 'chat':
      return `${rolePrefix}/messages`;
  }
}

export function resolveDeepLinkHref(
  url: string | null | undefined,
  role: Role | null = 'CLIENT'
): string | null {
  const target = parseDeepLink(url);
  return target ? buildDeepLinkHref(target, role) : null;
}

interface NotificationRule {
  screen: DeepLinkScreen;
  idKeys: string[];
}

const NOTIFICATION_RULES: Record<string, NotificationRule> = {
  CALL_INCOMING: { screen: 'call', idKeys: ['consultationId'] },
  MESSAGE_NEW: { screen: 'consultation', idKeys: ['consultationId'] },
  PRESCRIPTION_NEW: { screen: 'prescriptions', idKeys: ['prescriptionId', 'id'] },
};

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveNotificationHref(
  data: unknown,
  role: Role | null = 'CLIENT'
): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;

  const payload = data as Record<string, unknown>;
  const type = readString(payload, 'type');
  if (!type) return null;

  const rule = NOTIFICATION_RULES[type];
  if (!rule) return null;

  for (const key of rule.idKeys) {
    const id = readString(payload, key);
    if (id) {
      return buildDeepLinkHref(
        {
          screen: rule.screen,
          param: SCREENS[rule.screen].param,
          id,
        },
        role
      );
    }
  }

  return null;
}
