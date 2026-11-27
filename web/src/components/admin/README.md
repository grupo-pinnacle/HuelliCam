# Admin Components

## Overview
Provides Huellicam administrative dashboard widgets for inspecting executive unit-economics KPIs, configuring white-label tenant pricing settings, and toggling runtime production kill-switch feature flags.

## Interface
- `[AdminExecutiveMetrics.tsx:SupportedCurrency]` — Supported billing currency union (`'ARS' | 'USD' | 'BRL' | 'MXN' | 'EUR'`).
- `[AdminExecutiveMetrics.tsx:PricingSettingsDTO]` — Active pricing configuration DTO (`baseConsultationFee`, `platformTakeRate`, `currency`, `updatedAt`, `updatedBy`).
- `[AdminExecutiveMetrics.tsx:UpdatePricingPayload]` — Mutation payload for updating consultation fee, take-rate ratio (`0..1`), currency, and audit reason.
- `[AdminExecutiveMetrics.tsx:ExecutiveMetricsData]` — Executive KPIs DTO (`gmvTotal`, `netCommission`, `noShowLostRevenue`, `triageToPaidConversionRate`, `counts`, optional `pricing`).
- `[AdminExecutiveMetrics.tsx:AdminExecutiveMetricsProps]` — Props for controlled metrics/loading overrides, refresh callback, and pricing update handler.
- `[AdminExecutiveMetrics.tsx:AdminExecutiveMetrics]` — Named and default React component rendering executive KPI cards and an inline pricing settings form.
- `[AdminFeatureFlagsModal.tsx:FeatureFlagDTO]` — Runtime kill-switch DTO for keys `'PAYMENTS_ENABLED' | 'TRIAGE_ACTIVE' | 'VIDEOCALLS_ENABLED' | 'NEW_REGISTRATIONS_ENABLED'`.
- `[AdminFeatureFlagsModal.tsx:AdminFeatureFlagsModalProps]` — Props for modal visibility (`isOpen`), close handler (`onClose`), optional external flags, and async toggle handler.
- `[AdminFeatureFlagsModal.tsx:AdminFeatureFlagsModal]` — Named and default React modal component for inspecting and toggling production feature flags.

## Invariants
- `[AdminExecutiveMetrics.tsx:AdminExecutiveMetrics]` Uses caller-supplied `externalMetrics` and `externalLoading` when defined; only fetches metrics internally when `externalMetrics === undefined`.
- `[AdminExecutiveMetrics.tsx:isMountedRef]` Prevents internal state updates (`setInternalMetrics`, `setInternalLoading`) after unmount via `isMountedRef.current`.
- `[AdminExecutiveMetrics.tsx:AdminExecutiveMetrics]` Synchronizes `feeInput`, `takeRateInput`, and `currencyInput` whenever `metrics?.pricing` updates.
- `[AdminExecutiveMetrics.tsx:handleSavePricing]` Rejects non-positive `baseConsultationFee` values and `platformTakeRate` percentages outside `0..100`, converts percentage input to `ratePercent / 100`, and falls back to a default reason string when blank.
- `[AdminFeatureFlagsModal.tsx:AdminFeatureFlagsModal]` Returns `null` when `isOpen` is `false` and skips internal fetching when `externalFlags !== undefined`.
- `[AdminFeatureFlagsModal.tsx:handleToggle]` Disables the per-flag toggle control while `actionInProgress === flag.key` and defaults blank audit reason text to `'Conmutación operativa desde Admin Suite'`.

## Side Effects
- `[AdminExecutiveMetrics.tsx:fetchMetrics]` Sends `GET /api/admin/executive-metrics` via `api.get` when `externalMetrics === undefined` and logs errors via `console.error`.
- `[AdminExecutiveMetrics.tsx:handleSavePricing]` Sends `PATCH /api/admin/pricing-settings` via `api.patch` (or awaits `onUpdatePricing`), refreshes metrics, and logs errors via `console.error`.
- `[AdminFeatureFlagsModal.tsx:AdminFeatureFlagsModal]` Sends `GET /api/admin/feature-flags` via `api.get` when opened without `externalFlags` and logs errors via `console.error`.
- `[AdminFeatureFlagsModal.tsx:handleToggle]` Sends `PATCH /api/admin/feature-flags` via `api.patch` (or awaits `onToggleFlag`), updates `internalFlags`, and logs errors via `console.error`.

## Verification
- Run: `npm test -w web`
