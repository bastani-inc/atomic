## Summary

Atomic should **not claim Cursor-backed/headless models support image input today**. The strongest primary evidence is a Cursor forum staff reply saying headless image attachments are not supported, plus current official CLI parameter docs that list no image/attachment option. Current PR #1387 behavior (clear, early rejection) is consistent with known Cursor headless limitations and closes the UX gap in #1384 without risking silent data loss.

Confidence: **High** for “no documented/official headless attachment API”; **Medium** for “private Cursor protobuf route could support images” because credible reverse-engineered code exists but it is unofficial and fragile.

## Detailed findings

### 1) Atomic issue and PR behavior

**Sources**
- Issue: https://github.com/bastani-inc/atomic/issues/1384
- PR: https://github.com/bastani-inc/atomic/pull/1387
- Local PR HEAD reviewed: `43b1e697f44f3da28b5aefcbde1afbc80e28f43e`

**Issue #1384 asks for one of two outcomes**: serialize image/vision content if Cursor supports it, or provide clearer fallback guidance if not. The issue body reports the previous error: `Cursor provider currently supports text input only; vision/image content is unsupported.`

**Current PR #1387 implements the fallback/rejection path, not image enablement.** Concrete local file findings:

- `packages/cursor/src/stream.ts:36` defines: `Cursor supports text input only; images/screenshots are not supported by Cursor's headless provider API. Remove image content or switch to a vision-capable provider.`
- `packages/cursor/src/stream.ts:116` throws the rejection before Cursor request construction.
- `packages/cursor/src/stream.ts:448-450` detects image content on `user` and `toolResult` messages.
- `packages/cursor/README.md:15` documents the limitation.
- `test/unit/cursor-stream.test.ts:783-829` verifies user and tool-result image content are rejected before transport/resume.

**Severity / review finding**: No blocker found in PR #1387 for the current fallback goal. Severity **info/expected limitation**: Cursor provider remains text-only; users needing screenshots must route elsewhere.

### 2) Official Cursor docs: UI supports images; CLI/headless docs do not document attachment input

**Sources**
- Cursor Agent prompting docs: https://cursor.com/docs/agent/prompting
- Cursor CLI usage docs: https://cursor.com/docs/cli/using
- Cursor CLI parameters: https://cursor.com/docs/cli/reference/parameters

Official editor/Agent docs say: “You can attach context, images, and voice” and under “Image input” list drag/drop and paste from clipboard. This is clearly UI/chat-input behavior.

Official CLI docs document non-interactive `-p`/`--print`, `--output-format`, `--model`, `--resume`, `--workspace`, `agent acp`, etc., but no image path flag, attachment field, image URL field, stdin binary format, or `--file`/`--image` option is listed in the parameter table.

**Conclusion**: Official docs support image input in the Cursor UI, but provide no supported headless/CLI API for Atomic to call with image attachments.

### 3) Cursor forum primary evidence: headless image attachments not supported

**Sources**
- Cursor forum, “Image Support in Headless CLI”: https://forum.cursor.com/t/image-support-in-headless-cli/135007
- Cursor forum, “Image pasting support on Linux in Cursor CLI”: https://forum.cursor.com/t/image-pasting-support-on-linux-in-cursor-cli/148471/1

Most important quote: Cursor staff (`danperks`, 2025-09-26) replied: **“Unfortunately, we don’t currently support image attachments in headless mode.”** The thread was moved to feature requests and passed to the team.

A later Cursor staff reply (`deanrie`, 2026-01-10) says Linux CLI image paste is a “known limitation” and “isn’t supported right now,” on the roadmap.

User-reported workarounds are not reliable API guarantees:
- Some users paste/drag a screenshot in an interactive CLI so a file path appears.
- One user describes an S3/download/path prompt workaround that “works like 60% of the time.”
- Another user added an external LLM REST script to read images and let Cursor call it.

**Conclusion**: Cursor itself distinguishes UI image support from headless attachment support. Workarounds are prompt/file-path based and not reliable enough for Atomic’s provider capability metadata.

### 4) Reverse-engineered / third-party providers

#### Strus/pi-cursor-cli-provider: file-path prompt workaround

Source repo: https://github.com/Strus/pi-cursor-cli-provider
Commit pinned: `b822991830b4ed927e8c8e68e7d624288d073c31`

The README claims Cursor CLI supports images “when you provide a file path.” Code writes base64 Pi image blocks to temp files and inserts paths into the text prompt:
- [`src/index.ts#L116-L158`](https://github.com/Strus/pi-cursor-cli-provider/blob/b822991830b4ed927e8c8e68e7d624288d073c31/src/index.ts#L116-L158): creates temp dir, writes decoded image bytes, returns the image file path as prompt text.
- [`src/models.ts#L1136-L1140`](https://github.com/Strus/pi-cursor-cli-provider/blob/b822991830b4ed927e8c8e68e7d624288d073c31/src/models.ts#L1136-L1140): advertises `input: ["text", "image"]`.

Assessment: useful experiment, but it is a **prompt/path workaround**, not a documented Cursor headless image attachment API. It may fail when Cursor CLI/model does not inspect/read the path as image content.

#### ndraiman/pi-cursor-provider: upstream private API proxy is text-only

Source repo: https://github.com/ndraiman/pi-cursor-provider
Commit pinned: `82fc4e73f9ae820d87b34ac36713b18989910a36`

- [`proxy.ts#L743-L746`](https://github.com/ndraiman/pi-cursor-provider/blob/82fc4e73f9ae820d87b34ac36713b18989910a36/proxy.ts#L743-L746): `textContent()` filters array parts to `type === "text"`, dropping image parts.
- [`proxy.ts#L797-L817`](https://github.com/ndraiman/pi-cursor-provider/blob/82fc4e73f9ae820d87b34ac36713b18989910a36/proxy.ts#L797-L817): parsed user turns use `textContent(msg.content)` only.
- [`index.ts#L342-L342`](https://github.com/ndraiman/pi-cursor-provider/blob/82fc4e73f9ae820d87b34ac36713b18989910a36/index.ts#L342): advertises `input: ["text"]`.

Assessment: supports Atomic PR #1387’s text-only stance for the mainstream reverse-engineered proxy lineage.

#### offbynan/pi-cursor-provider: unofficial protobuf image injection

Source repo: https://github.com/offbynan/pi-cursor-provider
Commit pinned: `53e1d5e7de63c87e9ae88943429397ff06b8cc4a`

This fork claims “Image support — base64 `image_url` content parts forwarded to Cursor end-to-end.” Code evidence:
- [`proxy.ts#L248-L263`](https://github.com/offbynan/pi-cursor-provider/blob/53e1d5e7de63c87e9ae88943429397ff06b8cc4a/proxy.ts#L248-L263): parses OpenAI `image_url` data URLs into `{ mimeType, data }`.
- [`proxy.ts#L1145-L1146`](https://github.com/offbynan/pi-cursor-provider/blob/53e1d5e7de63c87e9ae88943429397ff06b8cc4a/proxy.ts#L1145-L1146): stores parsed images on user turns.
- [`proxy.ts#L1322-L1332`](https://github.com/offbynan/pi-cursor-provider/blob/53e1d5e7de63c87e9ae88943429397ff06b8cc4a/proxy.ts#L1322-L1332): builds Cursor `SelectedImageSchema` entries with `dataOrBlobId: { case: "data", value: img.data }`.
- [`proxy.ts#L1338-L1352`](https://github.com/offbynan/pi-cursor-provider/blob/53e1d5e7de63c87e9ae88943429397ff06b8cc4a/proxy.ts#L1338-L1352): attaches `selectedImages` to `SelectedContextSchema` in a `UserMessage`.

Assessment: this is the best evidence that Cursor’s **private** protocol can carry image blobs, but it is reverse-engineered, not official, and may break with Cursor server/protobuf changes. It also likely requires adopting a private API transport materially different from Atomic’s current clear rejection.

## Concrete options

1. **Keep PR #1387 as-is (recommended near-term).** Severity: low risk. It clearly rejects image input and routes users to a vision-capable provider. This matches official docs/forum evidence.
2. **Capability-aware fallback routing.** If context contains image blocks and selected model/provider is Cursor, preflight route to an already-supported vision provider (or present a selectable fallback) before starting the Cursor stream. This is the best UX improvement without relying on private Cursor APIs.
3. **Experimental file-path prompt mode.** Save images to temp/workspace files and append paths to the prompt, similar to Strus provider. Mark as experimental/off by default because Cursor staff says headless attachments are unsupported and forum users report unreliability.
4. **Experimental private protobuf integration.** Investigate offbynan’s `SelectedImageSchema` approach. This could enable real image blobs, but should be gated behind an explicit feature flag and tested against live Cursor repeatedly. Legal/TOS/stability risk is higher because it is reverse-engineered private API behavior.
5. **External vision tool fallback.** Use a separate vision-capable model/tool to summarize images to text, then feed that text to Cursor. This loses original image fidelity but preserves Cursor-backed coding flow.

## Gaps / residual risks

- No official Cursor API docs were found for sending image attachments in headless mode, ACP, or CLI print mode.
- I did not perform a live Cursor CLI image experiment in this run; findings are based on docs, forum staff statements, issue/PR state, and code references.
- Reverse-engineered protobuf behavior may be version-specific; offbynan’s fork is credible code evidence but not a support contract.
- Cursor may add official CLI image support later; Atomic should periodically re-check Cursor CLI parameter docs and forum/release notes.

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Reviewed Atomic issue #1384, PR #1387, local paths packages/cursor/src/stream.ts, packages/cursor/README.md, test/unit/cursor-stream.test.ts; found no blocker, only expected text-only Cursor limitation. Included severity/info finding and residual risks."
    }
  ],
  "changedFiles": ["parallel-research/cursor-image-external.md"],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "ls research/web; read research/web/cursor-image-support-2026-06-15.md",
      "result": "passed",
      "summary": "Checked existing cached research before external fetching."
    },
    {
      "command": "gh issue view 1384 --repo bastani-inc/atomic --json title,body,state,url,comments; gh pr view 1387 --repo bastani-inc/atomic --comments --json title,body,state,files,commits,url",
      "result": "passed",
      "summary": "Collected issue and PR facts, changed files, and current PR commit."
    },
    {
      "command": "fetch_content Cursor docs/forums and GitHub repos Strus/pi-cursor-cli-provider, ndraiman/pi-cursor-provider, offbynan/pi-cursor-provider",
      "result": "passed",
      "summary": "Fetched official docs, forum primary statements, and cloned/inspected third-party provider code."
    },
    {
      "command": "grep/read local Atomic and cloned provider source files",
      "result": "passed",
      "summary": "Located rejection logic, tests, model capability metadata, text-only parsing, and private protobuf image handling."
    }
  ],
  "validationOutput": [],
  "residualRisks": [
    "No live Cursor CLI/API image send test was performed.",
    "Private protobuf image support is reverse-engineered and may break or violate Cursor expectations.",
    "Cursor may add official headless image support after this research date."
  ],
  "noStagedFiles": true,
  "notes": "Only wrote the requested research markdown; did not edit repo source files."
}
```
