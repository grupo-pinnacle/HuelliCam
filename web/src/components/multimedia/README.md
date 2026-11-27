# Multimedia Shared Primitives

## Overview
Huellicam shared UI building blocks, inline SVG icon registry, sample pet image catalog, and history-based navigation helpers used by multimedia views.

## Interface
- `IconName` `[shared.tsx:IconName]`: String literal union of supported SVG icon names.
- `Icon` `[shared.tsx:Icon]`: Renders an inline 24x24 SVG icon from `iconPaths[name]` at the given `size` (default `20`).
- `photos` `[shared.tsx:photos]`: Record of sample pet photo URLs (`milo`, `luna`, `nube`, `kiwi`, `toby`).
- `go` `[shared.tsx:go]`: Imperative navigation helper updating browser history and scrolling to top.
- `Button` `[shared.tsx:Button]`: Button primitive supporting `variant` (`'primary' | 'secondary' | 'soft' | 'danger' | 'icon'`), optional `icon`, `disabled`, and `ariaLabel`.
- `Status` `[shared.tsx:Status]`: Status badge with dot indicator supporting `tone` (`'teal' | 'amber' | 'gray' | 'red'`).
- `Logo` `[shared.tsx:Logo]`: Clickable Huellicam brand button navigating to `to` (default `'/client/dashboard'`).
- `PageHeader` `[shared.tsx:PageHeader]`: Header container with `title` and optional `eyebrow`, `description`, and `action`.
- `Tabs` `[shared.tsx:Tabs]`: Tab strip with `role="tablist"` and `role="tab"` buttons notifying `onChange`.
- `MessageState` `[shared.tsx:MessageState]`: Delivery state union (`'sending' | 'sent' | 'read' | 'error'`).
- `MessageBubble` `[shared.tsx:MessageBubble]`: Chat message bubble with localized status label and optional retry button.
- `NoticeTone` `[shared.tsx:NoticeTone]`: Tone union (`'info' | 'success' | 'warning' | 'error' | 'clinical'`) for alerts and toasts.
- `Alert` `[shared.tsx:Alert]`: Notice banner with tone-mapped icon, `title`, optional `children`, and optional `action`.
- `Toast` `[shared.tsx:Toast]`: Toast notification with tone-mapped icon and `leaving` animation state.
- `Field` `[shared.tsx:Field]`: Labeled `<input>` controlled by `value` and `editing`.
- `EmptyState` `[shared.tsx:EmptyState]`: Empty-state block with icon, title, text, and optional action button.
- `Modal` `[shared.tsx:Modal]`: Accessible confirmation dialog with focus trapping and optional destructive styling.

## Invariants
- `[shared.tsx:Icon]`: Renders a 24x24 `viewBox` `<svg>` with `aria-hidden="true"` mapped from `iconPaths[name]`.
- `[shared.tsx:MessageBubble]`: Defaults `state` to `'read'` when `mine` is `true` (and `undefined` otherwise), and renders the retry control only when `state === 'error' && onRetry`.
- `[shared.tsx:Alert]`, `[shared.tsx:Toast]`: Uses `role="alert"` (plus `aria-live="assertive"` on `Toast`) when `tone === 'error'`, and `role="status"` (plus `aria-live="polite"` on `Toast`) for all other tones.
- `[shared.tsx:Field]`: Keeps the underlying `<input>` `readOnly={!editing}`.
- `[shared.tsx:EmptyState]`: Navigates via `go('/client/dashboard')` on action button click only when `action === 'Volver al inicio'`.
- `[shared.tsx:Modal]`: Traps `Tab`/`Shift+Tab` focus across enabled focusable elements inside `dialog.current`, closes on `Escape` or scrim/close-button click, and invokes `onConfirm ?? onClose` on the confirm button.

## Side Effects
- `[shared.tsx:go]`: Calls `window.history.pushState({}, '', path)`, dispatches `new PopStateEvent('popstate')` on `window`, and calls `window.scrollTo({ top: 0, behavior: 'smooth' })`.
- `[shared.tsx:Logo]`, `[shared.tsx:EmptyState]`: Invoke `go(...)` on click, mutating `window.history` and scroll position.
- `[shared.tsx:Modal]`: Records `document.activeElement`, focuses `close.current`, attaches a `keydown` listener to `document` on mount, and removes the listener while restoring focus to the prior element on unmount.

## Verification
- Run: `npm test -w web`
