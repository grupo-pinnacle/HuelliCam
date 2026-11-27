import { useEffect, useState } from 'react';

const MOBILE_VIEWPORT_QUERY = '(max-width: 820px)';

/**
 * Tracks whether the current viewport matches the mobile breakpoint (`<= 820px`).
 * Defaults safely to `false` in SSR and jsdom environments lacking `matchMedia`.
 */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const updateMatch = () => setIsMobile(mediaQuery.matches);
    updateMatch();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateMatch);
      return () => mediaQuery.removeEventListener('change', updateMatch);
    }
    mediaQuery.addListener(updateMatch);
    return () => mediaQuery.removeListener(updateMatch);
  }, []);

  return isMobile;
}
