---
title: Cursor headless/protobuf image support evidence
date: 2026-06-15
topic: cursor-headless-protobuf-image-support
sources:
  - https://cursor.com/docs/sdk/typescript
  - https://cursor.com/docs/cli/reference/parameters
  - https://forum.cursor.com/t/image-support-in-headless-cli/135007
  - https://forum.cursor.com/t/cursor-agent-returns-no-response-otlpexportererror/134382
  - https://forum.cursor.com/t/image-attached-to-user-prompt-is-not-picked-up-by-hooks/161895
  - https://github.com/fitchmultz/pi-cursor-sdk/blob/8cf43e84e5515724068bd2c2823b2d19a92d0463/docs/cursor-model-ux-spec.md
---

# Cursor headless/protobuf image support evidence (refreshed 2026-06-15)

## High-confidence official docs

- Cursor TypeScript SDK docs document image input for `agent.send({ text, images })`, and define `SDKUserMessage.images?: SDKImage[]` where `SDKImage` may be `{ url }` or `{ data, mimeType }` with optional dimensions. This is documented for the SDK, not for the protobuf/headless CLI transport.
- Cursor CLI parameter docs list CLI flags such as `--api-key`, `--header`, `--print`, `--output-format`, `--model`, `--force`, `--resume`, and `--prompt`; no image/attachment parameter was found in the fetched page.

## Cursor forum / behavior reports

- `Image Support in Headless CLI` (Cursor forum, 2025-09-26): Cursor staff/user-visible response says headless image attachments are not currently supported; thread moved to feature requests. Confidence: medium-high for documented product stance; not a protocol proof.
- `Cursor-agent returns no response, OTLPExporterError` (Cursor forum, 2025-09-21): user debug log for `cursor-agent` shows an internal JSON/protobuf-shaped request metadata object with `userMessage.selectedContext.selectedImages: []`. This is direct evidence that the headless agent has a `selectedContext.selectedImages` field in logging, but only empty in the observed log.
- `Image attached to user prompt is not picked up by hooks` (Cursor forum, 2026): indicates IDE image attachments may not surface in hooks; reports a later file write to assets. Confidence: medium; about hooks/IDE behavior, not headless protocol.

## Reverse-engineered / third-party findings

- Search results surfaced a now-inaccessible/private GitHub commit (`router-for-me/CLIProxyAPIPlus@c95620f90e9f0990b501ce25003055f705533d31`) whose snippet claims `encodeRunRequestWithCheckpoint` attaches `p.Images` into `UserMessage` and mentions `selectedContext`. Repository fetch/clone failed with `Repository not found`; treat as low-confidence unless independently recovered.
- Public reverse-engineered proto repos checked locally (`Jordan-Jarvis/cursor-grpc@3dfbf9f35637280f8909b1f4e0a018ebf36687bf`, `wisdgod/cursor-tab@16611b53f2fd7d6928237921a81564359af4a295`, `eisbaw/cursor_api_demo@97f6856c7427607907f7a9eb821cb85a1cc01972`) did not contain exact `SelectedContext`, `SelectedImage`, `selectedImages`, or `selected_images` definitions in `.proto`, `.go`, or `.py` files searched.
- `fitchmultz/pi-cursor-sdk@8cf43e84e5515724068bd2c2823b2d19a92d0463` documents/implements Cursor SDK image forwarding from latest user message only; this is SDK-level support, not proof that the undocumented headless protobuf path accepts `SelectedImage.data`.

## Bottom line

Current evidence supports: (1) official Cursor SDK accepts image data/URLs, (2) official Cursor CLI docs do not expose a headless image parameter, (3) Cursor forum stated headless image attachments were unsupported, and (4) at least one cursor-agent debug log exposes `selectedContext.selectedImages: []`. Evidence does **not** validate remote behavior for non-empty `selectedImages` or a `SelectedImage.data` protobuf field. Any implementation that sends image bytes through undocumented protobuf fields should be gated/experimental and expected to break.
