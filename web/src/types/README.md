# Types

## Overview
Shared TypeScript contracts for Huellicam domain entities, bilingual triage mappings, API response envelopes, and atomic/molecular/organism UI component props.

## Interface
- `[index.ts:Role]` - Union `'CLIENT' | 'VET' | 'ADMIN'`.
- `[index.ts:VetStatus]` - Union `'PENDING' | 'APPROVED' | 'REJECTED'`.
- `[index.ts:ConsultationStatus]` - Union of consultation lifecycle and queue states.
- `[index.ts:CallStatus]` - Union `'INITIATED' | 'ACTIVE' | 'ENDED'`.
- `[index.ts:TriagePriority]` - English triage priority union (`'GREEN' | 'YELLOW' | 'RED'`).
- `[index.ts:TriagePriorityES]` - Spanish triage priority union (`'VERDE' | 'AMARILLO' | 'ROJO'`).
- `[index.ts:TRIAGE_EN_TO_ES]` - Mapping from `TriagePriority` to `TriagePriorityES`.
- `[index.ts:TRIAGE_ES_TO_EN]` - Mapping from `TriagePriorityES` to `TriagePriority`.
- `[index.ts:User]` - User/veterinarian domain interface.
- `[index.ts:Pet]` - Pet domain interface.
- `[index.ts:Consultation]` - Consultation domain interface.
- `[index.ts:Message]` - Chat message domain interface.
- `[index.ts:Prescription]` - Prescription domain interface.
- `[index.ts:Review]` - Consultation review interface.
- `[index.ts:MediaFile]` - Uploaded media metadata interface.
- `[index.ts:Notification]` - User notification interface.
- `[index.ts:ApiResponse]` - Standard `{ success, data?, message?, error? }` API envelope.
- `[index.ts:BaseComponentProps]` - Shared `className` and `'data-testid'` base props.
- `[index.ts:ButtonProps]` - Atomic button props extending `React.ButtonHTMLAttributes<HTMLButtonElement>`.
- `[index.ts:BadgeProps]` - Atomic status/triage badge props.
- `[index.ts:InputProps]` - Atomic labeled input props.
- `[index.ts:AvatarProps]` - Atomic user/pet avatar props.
- `[index.ts:PetCardProps]` - Molecular patient card props.
- `[index.ts:TriageSelectorProps]` - Molecular Spanish triage picker props.
- `[index.ts:ClinicalSymptomKey]` - Union of clinical intake symptom keys.
- `[index.ts:SymptomDuration]` - Union of symptom onset duration buckets.
- `[index.ts:ClinicalIntakeData]` - Clinical intake submission payload interface.
- `[index.ts:ClinicalIntakeFormProps]` - Clinical intake form props.
- `[index.ts:BreadcrumbItem]` - Single breadcrumb navigation item.
- `[index.ts:BreadcrumbsProps]` - Molecular breadcrumbs props.
- `[index.ts:ChatMessageProps]` - Molecular chat bubble props.
- `[index.ts:HangUpButtonProps]` - Organism call-termination overlay button props.
- `[index.ts:PrescriptionDocProps]` - Organism printable prescription document props.
- `[index.ts:PrescriptionModalProps]` - Organism veterinarian prescription form modal props.
- `[index.ts:ReviewModalProps]` - Organism post-call review modal props.
- `[index.ts:ConfirmModalProps]` - Organism destructive-action confirmation modal props.

## Invariants
- `[index.ts:TriageSelectorProps]` - `value` strictly accepts `TriagePriorityES`; upstream containers must normalize `TriagePriority` via `TRIAGE_EN_TO_ES`.
- `[index.ts:User]` - Veterinarian profile descriptions use `bio` exclusively (no `speciality` property).
- `[index.ts:MediaFile]` - Intentionally omits a `url` field; consumers must construct `/api/media/${id}`.
- `[index.ts:BaseComponentProps]` - Preserves optional `'data-testid'` across UI props for Vitest selectors.
- `[index.ts:HangUpButtonProps]` - `HangUpButton` is the only extra overlay control permitted alongside `<VideoConference />` and must invoke `PATCH /api/consultations/:id/complete` before unmounting `<CallRoom />`.
- `[index.ts:PrescriptionModalProps]` - Modal contracts (`PrescriptionModalProps`, `ConfirmModalProps`) target native HTML5 `<dialog>` (`role="dialog"`, `aria-modal="true"`) rather than Radix UI.

## Side Effects
- None

## Verification
- Run: `npm test -w web`
