# Dashboard Components

## Overview
Huellicam clinical dashboard components for teleconsultation symptom intake (`ClinicalIntakeForm`), printable official pet medical dossiers (`PetDossierModal`), and real-time veterinary patient profile inspection (`VetPatientProfile`).

## Interface
- `ClinicalIntakeForm` `[ClinicalIntakeForm.tsx:ClinicalIntakeForm]`: Teleconsultation triage intake form accepting `ClinicalIntakeFormProps` (`pets`, `selectedPetId`, `onSelectPet`, `onSubmit`, `isSubmitting`, `className`, `data-testid`).
- `PetDossierModal` `[PetDossierModal.tsx:PetDossierModal]` (default export `[PetDossierModal.tsx:default]`): Printable Ley 25.326 pet clinical dossier modal accepting `PetDossierModalProps` (`pet`, `isOpen`, `onClose`).
- `VetPatientProfile` `[VetPatientProfile.tsx:VetPatientProfile]` (default export `[VetPatientProfile.tsx:default]`): Veterinary slide-over drawer displaying pet alerts and tutor emergency contact via `VetPatientProfileProps` (`petId`, `isOpen`, `onClose`).

## Invariants
- `[ClinicalIntakeForm.tsx:handleSubmit]`: Rejects submission and sets an accessible inline alert (`formError`) when `selectedPetId` is empty, when both `notes.trim()` and `selectedSymptoms` are empty, or when `'other'` is selected in `selectedSymptoms` without non-whitespace `notes`.
- `[ClinicalIntakeForm.tsx:isRoutineSelected]`: Omits the duration selector (`intake-duration-section`) and submits `duration: 'LESS_THAN_2_HOURS'` whenever `selectedSymptoms` is non-empty and every entry is `'routine_checkup'`.
- `[ClinicalIntakeForm.tsx:hasCriticalSymptom]`: Renders the emergency alert banner (`intake-emergency-banner`) whenever any selected symptom has `isCritical: true` in `AVAILABLE_SYMPTOMS` (`respiratory_distress`, `seizures`, `severe_trauma`, `massive_bleeding`).
- `[PetDossierModal.tsx:PetDossierModal]`: Returns `null` when `!isOpen || !pet`.
- `[PetDossierModal.tsx:handleCopyChip]`: Early-returns if `pet.microchip` is falsy; the copy control is rendered only when `pet.microchip` is truthy.
- `[VetPatientProfile.tsx:VetPatientProfile]`: Returns `null` when `!isOpen`; clears `pet` and `error` whenever `!isOpen || !petId`, and guards asynchronous fetch state updates with an `isMounted` flag cleaned up on unmount/effect re-run.

## Side Effects
- `[ClinicalIntakeForm.tsx:useEffect]`: Imperatively calls `errorRef.current.focus()` when `formError` becomes truthy.
- `[ClinicalIntakeForm.tsx:handleSubmit]`: Awaits the caller-supplied `onSubmit` callback with `{ petId, notes, symptoms, duration }`.
- `[PetDossierModal.tsx:handleCopyChip]`: Writes `pet.microchip` to `navigator.clipboard` and schedules a 2500ms `setTimeout` to reset `copied` to `false`.
- `[PetDossierModal.tsx:handlePrint]`: Calls `requestMobilePrintOrFallback` with document title, `window.location.href`, and `printableRef.current`.
- `[VetPatientProfile.tsx:useEffect]`: Performs an HTTP GET request via `api.get('/api/pets/' + petId)` when `isOpen && petId` are truthy.

## Verification
- Run: `npm test -w web`
