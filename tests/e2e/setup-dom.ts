import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

export function seedCookieConsent(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(
        'huellicam_cookie_consent',
        JSON.stringify({
          essential: true,
          analytics: false,
          acceptedAt: '2026-11-18T00:00:00.000Z',
        })
      );
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

beforeEach(() => {
  seedCookieConsent();
});

afterEach(() => {
  cleanup();
});

// Polyfill crypto.randomUUID for jsdom@20.0.3
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID },
    configurable: true,
  });
} else if (typeof globalThis.crypto.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: randomUUID,
    configurable: true,
  });
}

if (typeof window !== 'undefined') {
  if (!window.crypto) {
    Object.defineProperty(window, 'crypto', {
      value: globalThis.crypto,
      configurable: true,
    });
  } else if (typeof window.crypto.randomUUID !== 'function') {
    Object.defineProperty(window.crypto, 'randomUUID', {
      value: randomUUID,
      configurable: true,
    });
  }
}

// Polyfill ResizeObserver
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill;
  if (typeof window !== 'undefined') {
    window.ResizeObserver = ResizeObserverPolyfill;
  }
}

// Polyfill IntersectionObserver
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class IntersectionObserverPolyfill {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '0px';
    readonly thresholds: ReadonlyArray<number> = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver =
    IntersectionObserverPolyfill as unknown as typeof IntersectionObserver;
  if (typeof window !== 'undefined') {
    window.IntersectionObserver =
      IntersectionObserverPolyfill as unknown as typeof IntersectionObserver;
  }
}

// Polyfill window.matchMedia
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Polyfill scrollTo / scrollIntoView
if (typeof window !== 'undefined') {
  window.scrollTo = vi.fn();
}
if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = vi.fn();
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = vi.fn();
  }
}
if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

// Polyfill URL.createObjectURL / revokeObjectURL for attachment previews
if (typeof URL !== 'undefined') {
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost:3000/mock-object-url');
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = vi.fn();
  }
}
