import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { useVisualViewport, type VisualViewportState } from '../lib/useVisualViewport';

function ViewportProbe({ onChange }: { onChange: (state: VisualViewportState) => void }) {
  const state = useVisualViewport();
  onChange(state);
  return null;
}

describe('Phase 0 & Phase 1 — Foundations and Mobile Native', () => {
  const originalVisualViewport = window.visualViewport;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  });

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  it('useVisualViewport detects software keyboard opening and removes listeners on unmount', () => {
    const listeners = new Map<string, Set<EventListener>>();
    const mockVv = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn((type: string, cb: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: EventListener) => {
        listeners.get(type)?.delete(cb);
      }),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: mockVv });

    let latest: VisualViewportState = { viewportHeight: null, keyboardInset: 0, isKeyboardOpen: false };
    const { unmount } = render(<ViewportProbe onChange={(s) => { latest = s; }} />);

    expect(latest.isKeyboardOpen).toBe(false);
    expect(latest.viewportHeight).toBe(844);

    act(() => {
      mockVv.height = 510;
      listeners.get('resize')?.forEach((cb) => cb(new Event('resize')));
    });

    expect(latest.isKeyboardOpen).toBe(true);
    expect(latest.keyboardInset).toBe(334);
    expect(latest.viewportHeight).toBe(510);

    unmount();
    expect(mockVv.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(mockVv.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('index.html, tailwind.config.js, DESIGN.md and dead CSS cleanup match Phase 0-1 spec', () => {
    const webRoot = path.resolve(__dirname, '../..');
    const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf-8');
    const tw = fs.readFileSync(path.join(webRoot, 'tailwind.config.js'), 'utf-8');

    expect(html).toContain('interactive-widget=resizes-content');
    expect(html).toContain('name="theme-color" content="#fffbef"');
    expect(tw).toContain('hoverOnlyWhenSupported: true');
    expect(fs.existsSync(path.join(webRoot, 'DESIGN.md'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'src/styles/portal.css'))).toBe(false);
    expect(fs.existsSync(path.join(webRoot, 'src/styles/vet.css'))).toBe(false);
    expect(fs.existsSync(path.join(webRoot, 'src/styles/call.css'))).toBe(false);
  });
});
