import type { Role } from '../types';

export const REGISTER_DRAFT_KEY = 'huellicam_register_draft';

export interface RegisterDraft {
  role?: Role | string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  licenseNumber?: string;
  bio?: string;
  province?: string;
  specialty?: string;
  experienceYears?: string;
  step?: number | string;
  acceptedTerms?: boolean;
}

export function getRegisterDraft(): RegisterDraft | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(REGISTER_DRAFT_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return null;
}

export function saveRegisterDraft(draft: RegisterDraft): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const safeDraft: RegisterDraft = { ...draft };
      delete (safeDraft as Record<string, unknown>).password;
      window.localStorage.setItem(REGISTER_DRAFT_KEY, JSON.stringify(safeDraft));
    }
  } catch {}
}

export function clearRegisterDraft(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(REGISTER_DRAFT_KEY);
    }
  } catch {}
}
