# Data

## Overview
Static Huellicam veterinary domain catalogs covering supported pet species, breeds, physical and ideal weight standards, biometric weight validation, and client-side image compression.

## Interface
- `[petBreeds.ts:SpeciesBreeds]` - Interface pairing a `species` key with its `breeds` list.
- `[petBreeds.ts:WeightRange]` - Interface defining `minPossibleKg`, `maxPossibleKg`, `idealMinKg`, and `idealMaxKg`.
- `[petBreeds.ts:SPECIES_CATALOG]` - `Record<string, string[]>` mapping supported species to breed lists.
- `[petBreeds.ts:SPECIES_LIST]` - Ordered array of species keys derived from `SPECIES_CATALOG`.
- `[petBreeds.ts:SPECIES_WEIGHT_LIMITS]` - `Record<string, WeightRange>` fallback weight thresholds per species.
- `[petBreeds.ts:BREED_WEIGHT_STANDARDS]` - `Record<string, WeightRange>` breed-specific weight thresholds across all cataloged species.
- `[petBreeds.ts:getBreedsForSpecies]` - Case-insensitive species lookup returning the breed list or `SPECIES_CATALOG["Otro"]`.
- `[petBreeds.ts:WeightAssessment]` - Validation result interface (`status`, `isBlocking`, `message`, range bounds, and `breedLabel`).
- `[petBreeds.ts:getWeightAssessment]` - Evaluates pet weight against breed standards or species fallback limits.
- `[petBreeds.ts:compressImageFile]` - Resizes and compresses an uploaded image `File` into a JPEG data URL.

## Invariants
- `[petBreeds.ts:getBreedsForSpecies]` - Trims and lowercases the species argument and always falls back to `SPECIES_CATALOG["Otro"]` when unmatched.
- `[petBreeds.ts:getWeightAssessment]` - Returns `null` when `weightKg` is `undefined`, `null`, `""`, or `NaN`; resolves exact breed bounds in `BREED_WEIGHT_STANDARDS` before falling back to `SPECIES_WEIGHT_LIMITS` (defaulting to `"Otro"`).
- `[petBreeds.ts:getWeightAssessment]` - Marks `isBlocking: true` exclusively for `'too_low'` (`<= 0` or `< minPossibleKg`) and `'too_high'` (`> maxPossibleKg`); weights within `[minPossibleKg, maxPossibleKg]` outside ideal bounds yield `'valid_divergent'` with `isBlocking: false`.
- `[petBreeds.ts:compressImageFile]` - Preserves aspect ratio within `maxDim` (default `500`) and resolves the original `FileReader` result if 2D canvas context creation or image decoding fails.

## Side Effects
- `[petBreeds.ts:compressImageFile]` - Reads a `File` via `FileReader.readAsDataURL`, instantiates DOM `Image` and `<canvas>` elements, and encodes a JPEG data URL.

## Verification
- Run: `npm test -w web`
