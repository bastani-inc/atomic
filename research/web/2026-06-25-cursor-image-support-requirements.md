---
source_url: https://github.com/bastani-inc/atomic/issues/1512 + https://github.com/bastani-inc/atomic/issues/1504 + https://github.com/bastani-inc/atomic/pull/1510 + https://cursor.com/docs/models/grok-build-0-1 + https://cursor.com/docs/agent/prompting + https://cursor.com/docs/cloud-agent/api/endpoints + https://cursor.com/docs/mcp + https://modelcontextprotocol.io/specification/2025-06-18/server/tools + provider vision docs
fetched_at: 2026-06-25
fetch_method: cache review + fetch_content + gh issue/pr view
breaking_changes_allowed: false
topic: Cursor/Atomic image input support requirements, Grok image capability, payload formats, model switching, text-only rejection, provider blockers, resume-history filtering
---

# Cursor image-support requirements and provider validation expectations

## Atomic issues / PRs

- bastani-inc/atomic#1512: comment by flora131 reports live smoke validation for Cursor MCP image-result path. Model `cursor/gpt-5.5-medium-fast`, synthetic MCP tool returned mixed `McpTextContent` + `McpImageContent` raw PNG bytes with `mimeType: image/png`; Cursor answered `Red`. Same red PNG validated through current-user `SelectedContext.selectedImages[]`; Cursor answered `Red`. Conclusion: current-user images via `SelectedImage` and tool-result images via MCP `McpImageContent` are viable on image-capable Cursor models.
- #1512 implementation scope inferred from issue/cache: enable Cursor models in Atomic to read/reason over images using existing Atomic image handling. Cursor provider should serialize Atomic `ImageContent` only; Atomic owns session history/context/compaction/read resizing/CLI `@image`/clipboard temp files.
- #1512 required paths: current user image blocks -> `SelectedContext.selectedImages[]` / `SelectedImage.dataOrBlobId = data`; tool-result image blocks -> Cursor MCP image content alongside text content.
- #1512 non-goals: no broad prompt-time bare-filepath auto-attachment, no initial `view_image` tool, no Cursor-specific history/compaction policy, no rewrite of existing image handling.
- #1512 validation: CLI `@image`, clipboard temp image path, dragged escaped filepath, manually pasted filepath, multiple images, images across same conversation, model switch non-Cursor image model -> Cursor, text-only Cursor graceful reject/omit.
- bastani-inc/atomic#1504: workflow-created/internal sessions should be marked in metadata and excluded from normal `/resume` session history. They remain available to workflow-specific resume/history/debug paths such as `/workflow resume`.
- bastani-inc/atomic#1510: implementation notes say workflow-stage sessions are marked internal in `SessionHeader.internal` plus optional `workflow` metadata, standard list/resume/continue paths exclude internal sessions by default, and `includeInternal` opt-ins preserve workflow resume/direct access. Review comments confirm default-exclude semantics are correct and legacy workflow sessions without marker remain visible.

## Cursor docs

- Cursor Agent prompting docs (`https://cursor.com/docs/agent/prompting`): “You can attach context, images, and voice, and switch models at any point.” Image input supports drag/drop image file and paste from clipboard; recommended for UI work, visual debugging, design implementation, and visual stack traces. It also says Cursor compresses older conversation parts into summaries near context limit, and model switching applies to the current conversation going forward.
- Cursor Grok Build 0.1 docs (`https://cursor.com/docs/models/grok-build-0-1`): Grok Build 0.1 has 256k context; “Text and image inputs with text-only output”; accepts text and image inputs, returns text only; reasoning is built in; no user-configurable reasoning effort; all Cursor agent tools.
- Cursor Cloud Agent API (`https://cursor.com/docs/cloud-agent/api/endpoints`): `prompt.images[]` for create and follow-up runs accepts either base64 `data` with required `mimeType`, or `url` fetched by Cursor. Limits: max 5 images, 15 MB each. Supported MIME: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. `model.id` must be returned by `GET /v1/models`; model params must be discovered from `GET /v1/models`.
- Cursor MCP docs (`https://cursor.com/docs/mcp`): MCP tools can return images as base64 strings in content items: `{ type: "image", data: RED_CIRCLE_BASE64, mimeType: "image/jpeg" }`. Cursor attaches returned images to chat; if the model supports images, it analyzes them.
- Cursor models endpoint docs expose IDs/params/variants but fetched text did not expose a universal image-capability field. Capability should be configured conservatively, inferred from documented model pages, or discovered from live metadata if available.

## MCP/provider payload formats

- MCP 2025-06-18 tool content (`https://modelcontextprotocol.io/specification/2025-06-18/server/tools`): tool results can contain multiple content items of different types. Image content shape is `{ type: "image", data: "base64-encoded-data", mimeType: "image/png" }`; text content is `{ type: "text", text: ... }`.
- xAI image understanding (`https://docs.x.ai/docs/guides/image-understanding`): vision requests use user `content[]` items such as `{ type: "input_image", image_url: "data:image/jpeg;base64,<...>" }` plus `{ type: "input_text", text: ... }`; `image_url` may be public URL. Limits: max image size 20 MiB; no max number of images; supported types jpg/jpeg/png; any image/text order accepted.
- Anthropic Claude vision (`https://docs.anthropic.com/en/docs/build-with-claude/vision`): image blocks use base64, URL, or `file_id` sources. Multiple images supported; Claude has access to earlier-turn images in multi-turn conversations. Supported formats JPEG/PNG/GIF/WebP; animations unsupported/first frame only. API limits include 100 images/request for 200k context models, 600 for others, 10 MB/image direct API, and 32 MB standard request size limit.
- OpenAI vision (`https://platform.openai.com/docs/guides/images-vision`): image inputs can be fully qualified URL, base64 data URL, or file ID; multiple images in one `content` array. Supported types PNG/JPEG/WEBP/non-animated GIF. Limits include up to 512 MB total payload and up to 1500 image inputs/request, subject to model/token constraints.
- Gemini image understanding (`https://ai.google.dev/gemini-api/docs/image-understanding`): images can be passed via File API URI or inline base64 `data` plus `mime_type`; multiple images supported. Gemini models are multimodal. Supported MIME: PNG/JPEG/WEBP/HEIC/HEIF. Limit: max 3,600 image files/request. Last updated 2026-06-22 UTC.

## Implementation implications for Atomic Cursor provider

- For image-capable Cursor models (including documented Grok Build 0.1), advertise image input capability so existing Atomic image-aware flows do not suppress image blocks.
- Current user `ImageContent` should use Cursor selected-image protocol (`SelectedContext.selectedImages[]`, `SelectedImage.dataOrBlobId = data`).
- Tool-result images should be preserved as mixed content and encoded as Cursor/MCP image items, not flattened to text-only.
- Do not add broad filepath auto-attachment or a new `view_image` tool for #1512. Filepath cases should work through existing Atomic mechanisms (`@image`/clipboard/dragged path attachment) or Cursor calling Atomic `read(path)` and receiving MCP image content.
- Text-only Cursor models should reject or omit images gracefully with a clear error/notice rather than silently corrupting payloads. Grok Build 0.1 is documented as image-capable, so it should not be gated out.
- Provider switching should keep existing conversation image blocks and allow switching from a non-Cursor image model to Cursor, while applying model capability gating from that point forward.
- Upstream/provider blockers: Cursor Cloud Agent API has a hard 5-image/15MB/MIME limit; Cursor MCP image analysis depends on selected model image support; Cursor model list docs do not show a universal image capability flag.
- Resume/history filtering from #1504/#1510 should avoid normal `/resume` pollution from workflow validation sessions; keep `includeInternal`/workflow-specific paths for diagnostics.
