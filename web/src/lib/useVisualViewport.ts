import { useEffect, useState } from 'react';

export interface VisualViewportState {
  viewportHeight: number | null;
  keyboardInset: number;
  isKeyboardOpen: boolean;
}

const DEFAULT_STATE: VisualViewportState = {
  viewportHeight: null,
  keyboardInset: 0,
  isKeyboardOpen: false,
};

function readVisualViewport(): VisualViewportState {
  if (typeof window === 'undefined') {
    return DEFAULT_STATE;
  }
  const vv = window.visualViewport;
  if (!vv) {
    return DEFAULT_STATE;
  }
  const viewportHeight = Math.round(vv.height);
  const keyboardInset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  return {
    viewportHeight,
    keyboardInset,
    isKeyboardOpen: keyboardInset > 120,
  };
}

/**
 * Tracks mobile software keyboard opening via `window.visualViewport`
 * so fixed chat panels and mobile navigation bars adapt on both iOS Safari and Android Chrome.
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => readVisualViewport());

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }
    const vv = window.visualViewport;
    const sync = () => {
      const next = readVisualViewport();
      setState((prev) =>
        prev.viewportHeight === next.viewportHeight &&
        prev.keyboardInset === next.keyboardInset &&
        prev.isKeyboardOpen === next.isKeyboardOpen
          ? prev
          : next
      );
    };

    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);

    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  return state;
}
