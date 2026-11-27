# Chat Components

## Overview
Provides Huellicam's audited clinical chat thread UI for tutor-veterinarian consultations, supporting text bubbles, zoomable image thumbnails, PDF/image document cards, quick replies, and file upload triggers.

## Interface
- `[ClinicalChatThread.tsx:ClinicalChatDoc]` — Interface describing a clinical PDF or image document attachment card and optional `fileUrl`.
- `[ClinicalChatThread.tsx:ClinicalChatImageThumb]` — Interface describing an image thumbnail bubble with caption, CSS `objectPosition`, and optional `onZoom` handler.
- `[ClinicalChatThread.tsx:ClinicalChatMessage]` — Interface modeling an individual chat message (`id`, `mine`, `senderName`, `text`, `time`, `state`, `doc`, `imageThumb`).
- `[ClinicalChatThread.tsx:ClinicalChatThread]` — Named and default React component rendering the conversation header, message stream, attachment/quick-reply popovers, and input footer.

## Invariants
- `[ClinicalChatThread.tsx:ClinicalChatThread]` Disables the send button when `!value.trim()`, triggers `onSend` on `Enter` key press (`e.preventDefault()`), and displays `WhatsAppCheck` indicators only on outgoing (`msg.mine`) messages.
- `[ClinicalChatThread.tsx:ClinicalChatThread]` Renders hidden `<input type="file">` controls and attachment trigger only when `onAttachFile` is provided, and renders the quick-reply trigger/menu only when `quickReplies` is non-empty.
- `[ClinicalChatThread.tsx:ClinicalChatThread]` Ensures `showAttachMenu` and `showQuick` do not remain open simultaneously when toggled.
- `[ClinicalChatThread.tsx:handleFileChange]` Clears `e.target.value = ""` and closes `showAttachMenu` after forwarding the selected file to `onAttachFile`.

## Side Effects
- `[ClinicalChatThread.tsx:defaultDownload]` When `onDownloadDoc` is not supplied and `doc.fileUrl` is set, creates a temporary `<a>` element with `download`, `target="_blank"`, and `rel="noopener noreferrer"` in `document.body`, calls `.click()`, and removes it.
- `[ClinicalChatThread.tsx:ClinicalChatThread]` Renders an inline `<style>` tag defining `@keyframes waSpin` inside the chat section.

## Verification
- Run: `npm test -w web`
