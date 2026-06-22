---
title: Cursor headless image support refresh
 date: 2026-06-15
topic: cursor-headless-protobuf-selectedImages-inline-data
sources:
  - https://cursor.com/docs/cli/headless
  - https://cursor.com/docs/cloud-agent/api/v0
  - https://forum.cursor.com/t/image-support-in-headless-cli/135007
  - https://forum.cursor.com/t/image-pasting-support-on-linux-in-cursor-cli/148471
---

# Cursor headless/protobuf image support refresh (2026-06-15)

Question: whether newer/current online evidence documents or supports Cursor headless/protobuf `selectedImages` with inline `SelectedImage.data`.

## New/current official evidence

- Cursor Headless CLI docs now include a "Working with images" section. It documents image/media/binary support by **including file paths in the prompt**, e.g. `agent -p "Analyze this image and describe what you see: ./screenshot.png"`. The docs say the agent receives the prompt with path references, uses tool calling to read files, and that images are handled transparently. This is documented support for file-path-based image access in headless CLI, not documentation of protobuf `selectedImages` nor inline image bytes.
  - Source: https://cursor.com/docs/cli/headless
- Cursor Cloud Agents API v0 (legacy) documents `prompt.images` with inline base64 `data` and dimensions for `POST /v0/agents` and followups. This is a documented HTTP JSON Cloud Agents API surface, not the local headless CLI protobuf transport, and uses `prompt.images`, not `selectedContext.selectedImages` / `SelectedImage.data`.
  - Source: https://cursor.com/docs/cloud-agent/api/v0

## Forum evidence still relevant

- Forum thread "Image Support in Headless CLI" from 2025-09-26 contains Cursor staff reply: "Unfortunately, we don’t currently support image attachments in headless mode." This is now partially superseded by the official headless CLI docs documenting file-path references, but still aligns with no documented inline attachment mechanism.
  - Source: https://forum.cursor.com/t/image-support-in-headless-cli/135007
- Forum thread "Image pasting support on Linux in Cursor CLI" includes Cursor staff reply in Jan 2026 that pasting images in CLI on Linux is not supported and is on the roadmap; later comments ask for headless attachments. This is about clipboard/paste attachments, not file paths/protobuf.
  - Source: https://forum.cursor.com/t/image-pasting-support-on-linux-in-cursor-cli/148471

## Bottom line

Current evidence changed from "headless images unsupported" to: Cursor officially documents **headless CLI image use via filesystem paths/tool calls**. However, I found no current official documentation or authoritative support statement for local headless protobuf `selectedContext.selectedImages`, `SelectedImage`, or inline `SelectedImage.data`. Inline base64 `data` is documented for Cloud Agents API `prompt.images`, but that is a separate HTTP API surface and does not validate the local headless protobuf path.

Confidence: high that file-path headless images are documented; high that inline protobuf `selectedImages.data` remains undocumented; medium that it remains unsupported as a stable integration surface (absence of docs plus older forum statements, but no fresh explicit denial for protobuf internals).
