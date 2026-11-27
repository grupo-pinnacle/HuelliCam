# Legal Components

## Overview
Huellicam layout wrapper for public legal and compliance pages, providing consistent header navigation back to the home route, a structured document container, and a corporate legal footer.

## Interface
- `LegalLayout` `[LegalLayout.tsx:LegalLayout]`: Page shell accepting `LegalLayoutProps` (`icon`, `title`, `subtitle`, `children`) and linking via React Router `<Link>` to `/`, `/terms`, `/privacy`, `/cookies`, and `/refunds`.

## Invariants
- `[LegalLayout.tsx:LegalLayout]`: Always renders a `min-h-screen` flex column with a sticky header link to `/`, a `<main id="main-content">` card rendering `icon`, `title`, `subtitle`, and `children`, and a footer copyright line displaying `new Date().getFullYear()` alongside links to `/terms`, `/privacy`, `/cookies`, and `/refunds`.

## Side Effects
- None

## Verification
- Run: `npm test -w web`
