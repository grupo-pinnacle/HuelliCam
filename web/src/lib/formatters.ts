const HONORIFICS = new Set(['dr', 'dra', 'prof', 'lic', 'sr', 'sra', 'ing']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

type GraphemeSegmenterCtor = new (
  locale?: string,
  options?: { granularity: 'grapheme' }
) => { segment(input: string): Iterable<{ segment: string }> };

function firstGrapheme(word: string): string {
  const trimmed = word.trim();
  if (!trimmed) return '';
  const Segmenter =
    typeof Intl !== 'undefined'
      ? (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterCtor }).Segmenter
      : undefined;
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter('es', { granularity: 'grapheme' });
    const first = segmenter.segment(trimmed)[Symbol.iterator]().next();
    if (!first.done && first.value?.segment) {
      return first.value.segment;
    }
  }
  return Array.from(trimmed)[0] ?? '';
}

function stripPunctuation(token: string): string {
  return token.replace(/^[.,\-_()]+|[.,\-_()]+$/g, '');
}

/**
 * Computes up to 2 grapheme-safe initials while ignoring honorifics (Dr., Dra.) and suffixes (Jr., III).
 */
export function getInitials(raw?: string | null, fallback = 'U'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return fallback;

  const rawTokens = cleaned.split(' ').filter(Boolean);
  let tokens = rawTokens.filter((t) => !HONORIFICS.has(stripPunctuation(t).toLowerCase()));
  while (tokens.length > 1 && SUFFIXES.has(stripPunctuation(tokens[tokens.length - 1]).toLowerCase())) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) tokens = rawTokens;

  const first = firstGrapheme(tokens[0]);
  const last = tokens.length > 1 ? firstGrapheme(tokens[tokens.length - 1]) : '';
  const combined = `${first}${last}`.trim();
  return (combined || fallback).toUpperCase();
}

export function formatBadgeCount(count: number | null | undefined, max = 99): string {
  if (count == null || !Number.isFinite(count) || count <= 0) return '0';
  const whole = Math.floor(count);
  return whole > max ? `${max}+` : String(whole);
}

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

const DEFAULT_DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

export function formatDateAR(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions | boolean = DEFAULT_DATE_OPTIONS,
  fallback = '—'
): string {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  const resolvedOptions =
    options === true
      ? DEFAULT_DATETIME_OPTIONS
      : options === false
      ? DEFAULT_DATE_OPTIONS
      : options;
  try {
    return new Intl.DateTimeFormat('es-AR', resolvedOptions).format(date);
  } catch {
    return fallback;
  }
}

export function formatTimeAR(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
  fallback = '—'
): string {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat('es-AR', options).format(date);
  } catch {
    return fallback;
  }
}

export function formatCurrencyAR(
  value: number | null | undefined,
  currency = 'ARS',
  fallback = '—'
): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  const safeCurrency = /^[A-Z]{3}$/.test(currency.trim().toUpperCase())
    ? currency.trim().toUpperCase()
    : 'ARS';
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: safeCurrency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${safeCurrency} ${Math.round(value).toLocaleString('es-AR')}`;
  }
}

export function formatPluralAR(count: number, singular: string, plural: string): string {
  const safe = Number.isFinite(count) ? Math.floor(count) : 0;
  try {
    const rule = new Intl.PluralRules('es-AR').select(Math.abs(safe));
    return `${safe} ${rule === 'one' ? singular : plural}`;
  } catch {
    return `${safe} ${safe === 1 ? singular : plural}`;
  }
}
