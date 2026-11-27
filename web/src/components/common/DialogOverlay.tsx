import React, { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
  );
}

export interface UseFocusTrapOptions {
  /** Called when the user presses `Escape` while the trap is active. */
  onEscape?: () => void;
  /** Optional element to focus immediately when the trap activates. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Lock document body scrolling while active. Defaults to `true`. */
  lockScroll?: boolean;
}

/**
 * Traps keyboard Tab navigation inside `containerRef`, handles Escape dismissal,
 * and restores focus to the previously focused trigger on close or unmount.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  options: UseFocusTrapOptions = {}
): void {
  const { onEscape, initialFocusRef, lockScroll = true } = options;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;

    const previouslyFocused =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    let previousOverflow: string | null = null;
    if (lockScroll && typeof document !== 'undefined') {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    const focusInitial = () => {
      const container = containerRef.current;
      if (!container) return;
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      if (container.contains(document.activeElement)) return;
      const autoTarget = container.querySelector<HTMLElement>('[autofocus]');
      if (autoTarget) {
        autoTarget.focus();
        return;
      }
      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        if (!container.hasAttribute('tabindex')) {
          container.setAttribute('tabindex', '-1');
        }
        container.focus();
      }
    };

    const timerId = window.setTimeout(focusInitial, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;

      if (event.key === 'Escape') {
        if (onEscapeRef.current) {
          event.preventDefault();
          onEscapeRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!current || current === first || !container.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (!current || current === last || !container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timerId);
      document.removeEventListener('keydown', handleKeyDown);
      if (previousOverflow !== null && typeof document !== 'undefined') {
        document.body.style.overflow = previousOverflow;
      }
      if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, initialFocusRef, lockScroll]);
}

export interface DialogOverlayProps {
  open: boolean;
  onClose?: () => void;
  role?: 'dialog' | 'alertdialog';
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  backdropClassName?: string;
  backdropStyle?: React.CSSProperties;
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  closeOnBackdropClick?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * Shared accessible modal backdrop + focus-trapped dialog container.
 */
export function DialogOverlay({
  open,
  onClose,
  role = 'dialog',
  ariaLabel,
  labelledBy,
  describedBy,
  backdropClassName = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#183c3a]/55 backdrop-blur-sm hc-dialog-backdrop',
  backdropStyle,
  panelClassName = 'hc-dialog-panel',
  panelStyle,
  closeOnBackdropClick = Boolean(onClose),
  initialFocusRef,
  children,
}: DialogOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef, { onEscape: onClose, initialFocusRef });

  if (!open) return null;

  return (
    <div
      className={backdropClassName}
      style={backdropStyle}
      onMouseDown={(event) => {
        if (closeOnBackdropClick && onClose && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={panelClassName}
        style={panelStyle}
      >
        {children}
      </div>
    </div>
  );
}
