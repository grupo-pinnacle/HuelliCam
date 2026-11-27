# Species Icons

## Overview
Provides Huellicam veterinary species SVG icon components (`DogIcon`, `CatIcon`, `RabbitIcon`) and a string-matching `SpeciesIcon` dispatcher with a generic paw-print fallback.

## Interface
- `[SpeciesIcons.tsx:DogIcon]` — Named React SVG component rendering a canine outline icon.
- `[SpeciesIcons.tsx:CatIcon]` — Named React SVG component rendering a feline outline icon.
- `[SpeciesIcons.tsx:RabbitIcon]` — Named React SVG component rendering a rabbit outline icon.
- `[SpeciesIcons.tsx:SpeciesIcon]` — Named React component selecting the matching species icon (or `PawPrint` fallback) from a `species` string.

## Invariants
- `[SpeciesIcons.tsx:SpeciesIcon]` Normalizes `species` with `.toLowerCase().trim()`, mapping substrings `'canin'`/`'perr'`/`'dog'` to `DogIcon`, `'felin'`/`'gat'`/`'cat'` to `CatIcon`, `'cone'`/`'rabbit'`/`'exot'` to `RabbitIcon`, and all other inputs to `lucide-react` `PawPrint`.
- `[SpeciesIcons.tsx:DogIcon]` Renders decorative SVGs with `aria-hidden="true"` and default `className = 'w-5 h-5'` (shared with `CatIcon` and `RabbitIcon`).

## Side Effects
- None

## Verification
- Run: `npm test -w web`
