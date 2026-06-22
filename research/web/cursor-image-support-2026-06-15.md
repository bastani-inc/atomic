# Cursor image / vision support research cache (refreshed 2026-06-15)

Sources refreshed for Atomic issue https://github.com/bastani-inc/atomic/issues/1384. Compatibility constraint: `breaking_changes_allowed=false`.

## Official Cursor docs

- Cursor CLI overview: https://cursor.com/docs/cli/overview
  - Documents Cursor Agent in a terminal and mentions interactive and print/non-interactive workflows. No image attachment flag/parameter found in refreshed content.
- Using Agent in CLI: https://cursor.com/docs/cli/using
  - Documents `agent -p`/`--print`, output formats, MCP, ACP, rules, context selection, slash commands, review, worktrees, history, and approvals. No documented image input syntax, `--file`, or image parameter found in refreshed content.
- Parameters: https://cursor.com/docs/cli/reference/parameters
  - Lists CLI options (`--api-key`, `--header`, `-p/--print`, `--output-format`, `--model`, `--force`, `--resume`, `--prompt`, etc.). No attachment/image option found in refreshed content.
- Prompting agents: https://cursor.com/docs/agent/prompting
  - Editor/agent docs say users can attach “context, images, and voice,” and the image section describes drag/drop or paste attachment in the chat input. This applies to Cursor Agent UI/editor docs, not a documented headless CLI API.

## Cursor forum / upstream behavior reports

- Image Support in Headless CLI: https://forum.cursor.com/t/image-support-in-headless-cli/135007
  - Cursor staff reply (2025-09-26): “Unfortunately, we don’t currently support image attachments in headless mode.” The thread was moved to feature requests.
  - User reports in the same thread say the Cursor CLI could not interpret an image in headless mode and that image reading works in the IDE but not `cursor-agent` headless CLI.
- Image pasting support on Linux in Cursor CLI: https://forum.cursor.com/t/image-pasting-support-on-linux-in-cursor-cli/148471/1
  - Cursor staff reply (2026-01-10): “pasting images in the CLI on Linux isn’t supported right now... on the roadmap.”
  - Later user comments describe workaround attempts: on macOS, dragging a screenshot thumbnail into Cursor input can paste a file path; another user requests headless attachments and reports a local-file-path workaround works only intermittently.

## Related Pi/Cursor providers

- Strus/pi-cursor-cli-provider: https://github.com/Strus/pi-cursor-cli-provider
  - README claims “Cursor CLI supports images when you provide a file path to them”; pasted/base64 Pi images are saved to temp files and paths are passed to Cursor CLI.
  - Source at commit `b822991830b4ed927e8c8e68e7d624288d073c31` maps image MIME types, writes base64 image blocks to temp files, serializes image blocks as file paths, and advertises `input: ["text", "image"]`.
- ndraiman/pi-cursor-provider: https://github.com/ndraiman/pi-cursor-provider
  - Reverse-engineered Cursor gRPC/OpenAI-compatible proxy. Source at commit `82fc4e73f9ae820d87b34ac36713b18989910a36` advertises only `input: ["text"]`; no image extraction/forwarding was found in its request parser path.
- offbynan/pi-cursor-provider: https://github.com/offbynan/pi-cursor-provider
  - Fork README explicitly claims “Image support — base64 `image_url` content parts forwarded to Cursor end-to-end; the upstream silently drops them.”
  - Source at commit `53e1d5e7de63c87e9ae88943429397ff06b8cc4a` parses OpenAI `image_url` data URLs into binary image records, threads them through parsed turns, and advertises `input: ["text", "image"]`.

## Atomic local source snapshot

- Local Atomic commit while researching: `1d36e36a4a0fe5c5622789cf7833c848c074e5f0`.
- `packages/cursor/README.md` now documents Cursor provider as text-only for images/screenshots.
- `packages/cursor/src/stream.ts` rejects user/tool-result image content before constructing a Cursor request.
- Because `breaking_changes_allowed=false`, preserving text-only model capability metadata plus explicit runtime rejection is the safest compatibility stance until Cursor provides a documented headless image API.
