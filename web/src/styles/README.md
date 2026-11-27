# Styles

## Overview
Scoped React style-wrapper components that mount isolated CSS bundles for Huellicam client-portal and landing views.

## Interface
- `[ClientScopedStyle.tsx:ClientScopedStyle]` - Named export React component mounting client-scoped CSS (`id="client-style"`).
- `[ClientScopedStyle.tsx:default]` - Default export of `ClientScopedStyle`.
- `[LandingScopedStyle.tsx:LandingScopedStyle]` - Named export React component mounting landing-scoped CSS (`id="landing-style"`).
- `[LandingScopedStyle.tsx:default]` - Default export of `LandingScopedStyle`.

## Invariants
- `[ClientScopedStyle.tsx:ClientScopedStyle]` - Imports `client.css?inline` and delegates rendering to `ScopedStyle` (`../components/common/ScopedStyle`) with fixed `id="client-style"`.
- `[LandingScopedStyle.tsx:LandingScopedStyle]` - Imports `landing.css?inline` and delegates rendering to `ScopedStyle` (`../components/common/ScopedStyle`) with fixed `id="landing-style"`.

## Side Effects
- `[ClientScopedStyle.tsx:ClientScopedStyle]` - Injects client stylesheet rules into the document via `ScopedStyle` when mounted.
- `[LandingScopedStyle.tsx:LandingScopedStyle]` - Injects landing stylesheet rules into the document via `ScopedStyle` when mounted.

## Verification
- Run: `npm test -w web`
