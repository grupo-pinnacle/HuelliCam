# Huellicam Web Design Contract

Canonical design system for `web/`. Do not introduce new hex literals, ad-hoc breakpoints, or hand-rolled modals/sheets outside these tokens and rules.

## Palette & Tokens (defined in `src/index.css`)
- Brand primary: `--brand: #609f9c`, `--brand-dark: #315f5d`, `--brand-deep: #183c3a`, `--brand-soft: #d9e8e4`, `--teal-pale: #edf6f4`
- Surfaces: `--cream: #fffbef` (page background), `--sand: #f2eddd` (alt surface), `--paper: #ffffff` (cards/modals)
- Ink & lines: `--ink: #183c3a`, `--ink-soft: #4a6866` (WCAG AA >= 4.5:1 on `--cream`, Phase 4 target), `--muted: #607674`, `--line: rgba(24, 60, 58, 0.12)`
- Semantic: `--coral: #e98b70`, `--coral-soft: #f6d6ca`, `--lilac: #c9c1df`, `--amber: #d4933f`, `--amber-pale: #fff3d8`, `--danger: #ae4d45`, `--danger-pale: #f9e8e5`

## Typography
- Font family: `--font-sans: "Manrope", system-ui, -apple-system, sans-serif` (weights 400–800)
- Type scale (`rem`): `0.75rem` (12px micro/eyebrow), `0.875rem` (14px body-sm), `1rem` (16px body/mobile input), `1.125rem` (18px card title), `1.375rem` (22px section h2), `1.75rem` (28px sub-hero), `2.25rem` (36px page h1)

## Shape, Elevation & Motion
- Radii: `--radius-sm: 16px`, `--radius: 24px`, `--radius-pill: 999px`
- Shadows: `--shadow-sm: 0 8px 24px rgba(24, 60, 58, 0.07)`, `--shadow: 0 14px 38px rgba(24, 60, 58, 0.08)`
- Curves: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`
- Motion rules: UI transitions stay between 140ms and 280ms; animate only compositor properties (`transform`, `opacity`) and colors; honor `@media (prefers-reduced-motion: reduce)` and `prefersReducedMotion()`.

## Mobile & Accessibility Rules
- Minimum touch target size on interactive controls: `44px × 44px` on touch/mobile (`<= 820px`).
- Mobile inputs, selects, and textareas (`pointer: coarse` or `<= 820px`): `font-size >= 16px` to prevent iOS Safari zoom.
- Gate every `:hover` rule inside `@media (hover: hover) and (pointer: fine)` and pair with `:active` press feedback.
- Use `100dvh` (paired with `100vh` fallback when needed) and track `window.visualViewport` for fixed chat/sheets over mobile keyboards.
- Always preserve `:focus-visible` outlines (`3px` teal ring) and wrap overlays/sheets with safe-area insets (`env(safe-area-inset-*)`).
