# UI Component Library

## Overview
Huellicam core atomic and composite React UI components covering avatars, status badges, breadcrumbs, buttons, chat messages, form inputs, pet cards, SENASA digital prescriptions, consultation reviews, loading skeletons, clinical triage selection, and the interactive hamster mascot.

## Interface
- `Avatar` `[Avatar.tsx:Avatar]`: Circular user/pet avatar with optional status dot and image-error fallback.
- `Badge` `[Badge.tsx:Badge]`: Pill badge supporting `variant` (`BadgeProps['variant']`), `size` (`'sm' | 'md'`), and optional `icon`.
- `Breadcrumbs` `[Breadcrumbs.tsx:Breadcrumbs]` (default export `[Breadcrumbs.tsx:default]`): Accessible breadcrumb `<nav>` list accepting `BreadcrumbsProps`.
- `ButtonProps` `[Button.tsx:ButtonProps]`, `Button` `[Button.tsx:Button]` (default export `[Button.tsx:default]`): Pill button supporting `variant` (`'primary' | 'secondary' | 'outline' | 'danger' | 'ghost'`), `size` (`'sm' | 'md' | 'lg'`), and `isLoading`.
- `ChatMessage` `[ChatMessage.tsx:ChatMessage]`: Consultation chat bubble displaying sender label, localized time, message text, and optional clickable image attachment.
- `HamsterMascotProps` `[HamsterMascot.tsx:HamsterMascotProps]`, `HamsterMascot` `[HamsterMascot.tsx:HamsterMascot]` (default export `[HamsterMascot.tsx:default]`): Expressive SVG mascot supporting `isCoveringEyes`, `isLookingAtInput`, `size` (`'xs' | 'sm' | 'md' | 'lg'`), and `className`.
- `HangUpButton` `[HangUpButton.tsx:HangUpButton]`: Call hang-up action button accepting `HangUpButtonProps`.
- `Input` `[Input.tsx:Input]`: Labeled `<input>` wrapper supporting `error`, `helperText`, and standard input attributes.
- `PetCard` `[PetCard.tsx:PetCard]`: Pet summary card with avatar, species badge, metrics, microchip pill, and optional consultation CTA.
- `PrescriptionDoc` `[PrescriptionDoc.tsx:PrescriptionDoc]` (default export `[PrescriptionDoc.tsx:default]`): Printable SENASA/Ley 25.326 veterinary digital prescription document with QR validation section.
- `PrescriptionModal` `[PrescriptionModal.tsx:PrescriptionModal]` (default export `[PrescriptionModal.tsx:default]`): Modal form to issue a digital veterinary prescription and render the emitted QR confirmation view.
- `ReviewModal` `[ReviewModal.tsx:ReviewModal]` (default export `[ReviewModal.tsx:default]`): Modal 1–5 star consultation rating and optional comment dialog.
- `SkeletonProps` `[Skeleton.tsx:SkeletonProps]`, `Skeleton` `[Skeleton.tsx:Skeleton]` (default export `[Skeleton.tsx:default]`): Base pulse skeleton primitive.
- `PetCardSkeleton` `[Skeleton.tsx:PetCardSkeleton]`, `ConsultationQueueSkeleton` `[Skeleton.tsx:ConsultationQueueSkeleton]`, `PrescriptionDocSkeleton` `[Skeleton.tsx:PrescriptionDocSkeleton]`: Composite layout skeleton placeholders.
- `TriageSelector` `[TriageSelector.tsx:TriageSelector]`: 3-option clinical priority radiogroup (`VERDE`, `AMARILLO`, `ROJO`).

## Invariants
- `[Avatar.tsx:Avatar]`: Falls back to up to 2 uppercase initials derived from `alt` (or `PawPrint` icon when initials are empty) whenever `src` is omitted or `imageError` is set.
- `[Breadcrumbs.tsx:Breadcrumbs]`: Returns `null` when `!items || items.length === 0`; wraps `useNavigate()` in `try/catch` to support router-less environments; sets `aria-current="page"` on the last item and intercepts clicks with `navigate(item.path)` only for paths starting with `'/'`.
- `[Button.tsx:Button]`, `[HangUpButton.tsx:HangUpButton]`: Disables interaction while `isLoading` is `true` (`disabled={disabled || isLoading}` on `Button`; `disabled={isLoading}` on `HangUpButton`).
- `[Input.tsx:Input]`: Derives `inputId` from `id` or lowercased hyphenated `label`, sets `aria-invalid={!!error}`, and binds `aria-describedby` to `${inputId}-error` when `error` is present or `${inputId}-helper` when `helperText` is present.
- `[PetCard.tsx:PetCard]`: Calls `e.stopPropagation()` on the `request-consultation` button so clicking it does not fire `onSelect`.
- `[HamsterMascot.tsx:HamsterMascot]`: Marks its root `aria-hidden="true"`; activates cursor-tracking only when `(hover: hover) and (pointer: fine) and (min-width: 768px)` matches and `!isCoveringEyes`, clamping pupil travel radius to `4` px (`Math.min(..., 4)`) and setting `{ x: 0, y: 3.5 }` when `isLookingAtInput` is `true` while tracking is inactive.
- `[PrescriptionDoc.tsx:PrescriptionDoc]`: Resolves QR image source via `qrUrl || prescription.qrCodeDataUrl || prescription.verifyUrl` (rendering a placeholder badge if empty), vet display name via `prescription.vet` then `useAuth().user` then `'Médico Veterinario Matriculado'`, and license via `prescription.vet?.licenseNumber || fallbackLicense || user?.licenseNumber || 'MP-Oficial'`.
- `[PrescriptionModal.tsx:PrescriptionModal]`: Returns `null` when `!isOpen`; syncs fields and clears `error` and `issuedPrescription` when `isOpen` or `initialValues` change; enforces `indications.trim().length >= 5` (`isIndicationsValid`) before submission and parses `durationDays` base-10 with fallback `7`.
- `[ReviewModal.tsx:ReviewModal]`: Returns `null` when `!isOpen`; resets `rating`, `hoverRating`, `comment`, and `error` on open; rejects submit when `rating === 0`; bounds keyboard radiogroup selection (`ArrowRight`/`ArrowUp`, `ArrowLeft`/`ArrowDown`, `'1'`–`'5'`) to `1..5`; trims `comment` to `undefined` when blank.
- `[TriageSelector.tsx:TriageSelector]`: Exposes `VERDE`, `AMARILLO`, and `ROJO` radio buttons with `aria-checked` state and honors `disabled`.

## Side Effects
- `[Breadcrumbs.tsx:Breadcrumbs]`: Calls React Router `navigate(item.path)` when an internal (`/`-prefixed) non-last link is clicked inside a router context.
- `[HamsterMascot.tsx:useEffect]`: Subscribes to `window.matchMedia` `change` events and `window` `mousemove` events, removing both listeners on cleanup.
- `[PrescriptionDoc.tsx:handlePrint]`: Calls caller-supplied `onPrint()` or `requestMobilePrintOrFallback` with title, `window.location.href`, and `docRef.current`.
- `[PrescriptionModal.tsx:useEffect]`, `[ReviewModal.tsx:useEffect]`: Register and clean up `window` `keydown` listeners closing the modal on `Escape` while `isOpen` is `true`.
- `[PrescriptionModal.tsx:handleSubmit]`: Awaits `onSubmit(formData)` when provided or calls `api.post('/api/consultations/' + consultationId + '/prescriptions', formData)`, then invokes `onSuccess(result)`.
- `[ReviewModal.tsx:handleSubmit]`: Awaits `onSubmit(payload)` when provided or calls `api.post('/api/consultations/' + consultationId + '/review', payload)`, then invokes `onSuccess()` (if defined) and `onClose()`.
- `[ChatMessage.tsx:ChatMessage]`, `[PetCard.tsx:PetCard]`, `[TriageSelector.tsx:TriageSelector]`: Invoke caller callbacks (`onImageClick`, `onSelect`/`onRequestConsultation`, `onChange`) on user click.

## Verification
- Run: `npm test -w web`
