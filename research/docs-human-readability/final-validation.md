# Final integration evidence

Candidate: uncommitted documentation changes on `docs/human-readable-guides`, based on `2175058c1e1dfd5850a61914566ab45110a65ef4`. The final signed commit is identified by the integration receipt and Git history. No runtime files or released changelogs changed.

Review-round correction: the preservation review below missed the post-mortem Escape and queue-release instructions. Structural checks passed despite that omission. [The correction record](review-round-correction.md) supersedes the earlier semantic-preservation claim for this section and records the focused failing/passing check, runtime corroboration, and repeated validation. The 92-page accounting and previous broad browser evidence remain in scope.

## Coverage and preservation

Run from the repository root:

```sh
python3 research/docs-human-readability/verify.py > /tmp/readability-coverage.json
cmp /tmp/readability-coverage.json research/docs-human-readability/coverage.json
```

Both commands pass. `coverage.json` reconciles the filesystem with both the initial and audience tables in all three batch ledgers, rejecting duplicates and gaps. It records actual byte-comparison disposition and both concrete review reasons for every page: **92 pages, 74 revised, 18 unchanged**. The initial A ledger called `custom-provider.md` unchanged; its audience amendment revised it. The computed final disposition supersedes that historical count.

The audit compares against the immutable initial commit, not a snapshot of edited content. All original heading lines and explicit IDs survive in order. **889 public fences** remain byte-identical in order; **16 maintainer fences** survive byte-identically at the explicit, zero-based source-index destinations in `relocated-fences.json`. Nested fences are parsed by delimiter character and length. Historical `changelog.mdx` remains byte-identical. **74 repository documentation links** resolve locally, including GitHub maintainer filenames/heading anchors and relative links from the 21 maintainer documents. Public routes, local assets, and Mintlify anchors are additionally checked by the repository checks below.

`verify.py` emits inline-literal differences with exact matching maintainer destinations where available. This is a review aid, not a fixture that accepts arbitrary lost warnings. Literal equality cannot prove prose meaning, and condensed prose need not preserve every implementation spelling. The batch audience decisions and the integration review below supply the semantic context.

## Integration decisions and technical review

Inspected meaningful changes to compaction, security, Intercom recovery, SDK lifetime/queueing, subagent routing/ownership, and the native-task and tool-maintenance destinations. The workers' complete per-page reads and diff reviews remain in `batch-a.md`, `batch-b.md`, and `batch-c.md`; integration did not repeat the full editorial pass.

- Compaction retains transcript disclosure to fallback providers, unchanged session model/effort, protected-message rules, cancellation/queue behavior, destructive fresh-context warning, hard-limit rejection, and sensitive-sidecar handling. Private retry classifications, serialization, parser examples, and branch traversal move to engine notes. The historical disagreement about ordinary tail messages versus serialized boundaries was not resolved into a new API claim.
- Intercom keeps original-invocation retry identity, cancellation/deadline limits, unknown-outcome no-resend guidance, queued-message failure behavior, and operator log/config actions. Its recovery table now agrees with the pre-existing warning rather than instructing an unconditional resend. HMAC, capacity tracking, socket framing, and completion plumbing move to broker notes.
- SDK keeps awaited disposal, cleanup failures, old-capability restrictions, borrowed-resource independence, deadlock warnings, and explicit queue resumption. Raw native supervisor and S1 fake-runner details move to `readability-b/task-supervision.md`; exported host contracts and public fences remain in the SDK references.
- Security keeps trust scope, arbitrary-code authority, no-sandbox boundary, credential export restrictions, and downstream stdout risk. Wrapper implementation and negative-test history move to authentication notes.
- Subagent reference retains the 30-second shared routing deadline, three schema repairs, null versus off, ineligible/stale/auth/cancellation failures, no duplicate launch, suffix precedence, and binding-does-not-create-owner warning. Snapshot recovery fields move to lifecycle notes.
- Line-anchored patch source constants become a maintainer table of names and values; inactive diagnostics remain explicitly inactive. Public syntax, active warnings, examples, and repair guidance remain in tools. This is not a change to parsing behavior.

### Inline-literal differences that are not exact destination matches

The complete machine list is in `coverage.json`. These are intentional condensation or relocation differences, not changes to accepted inputs or APIs:

| Pages | Justification |
| --- | --- |
| compaction.md, compaction/reference.md | Combined expressions such as `details.rung: "fresh"` replace separate spans; field/type names remain in protected examples or linked persistence reference. Numeric examples and private classification spellings are condensed in engine notes. |
| extensions.md, extensions/events.md, extensions/authoring.md, extensions/ui.md | Removed duplicated initializer/transport/restart-message inventories and private projection names. Public event and UI examples remain verbatim; user recovery, input behavior, and lifecycle restrictions remain in prose. |
| intercom/operations.md | The log path plus instruction to read it replaces a literal `cat` command. Pending-delivery method spellings and fallback-prefix diagnostics are condensed into state/failure descriptions and broker ownership notes. |
| keybindings.md, reference/cli.md | Renderer-setting identifiers removed from implementation explanations remain in settings documentation; selection and exit actions remain here. |
| models/model-selection.md, models/pareto-efficiency.md, models/reference.md, providers.md | Historical model-label/header/transport expressions are condensed into benchmark/provider notes. Dated recommendation tables, capability configuration, provider restrictions, and public examples remain; no live catalog claims were refreshed. |
| sdk.md, sdk/reference.md | Invocation-shaped strings such as `await cancelTask(task, cause)` are condensed to named native operations and their obligations in task-supervision notes. Subscription property paths become journal prose. Public SDK examples remain byte-identical. |
| session-format.md | Historical package-layout locations are condensed into source-layout context in lifecycle notes; persisted format examples remain unchanged. |
| settings.md | Quoted runtime attribution is rewritten as prose in resource/UI notes, not removed as a runtime choice. |
| subagents.md | A literal status-label example is condensed into task-status guidance. Task observation and completion actions remain. |
| tools.md | Assignment-shaped constants are split into name/value table cells. Nested-backtick diagnostic spelling gains Markdown escaping. Internal STOP prefix spacing and output-label repetition are not new parser contracts. |
| tui.md, tui/reference.md | Duplicate component method mentions and bridge property paths are condensed; public signatures, component examples, focus obligations, and terminal capture instructions remain. |
| workflows/api-reference.md, workflows/authoring.md | Internal adapter/graph/capture invocations become lifecycle and verification prose. Supported authoring examples, input/output contracts, errors, and public API fences remain. |
| workflows/builtins.md, workflows/operations.md, workflows/reliable-design.md | Stage adapter calls, UI labels, heartbeat arithmetic, runtime search paths, cache scheduling and live-helper event spellings are condensed in the topic-specific C maintainer notes. Public commands, recovery uncertainty, approvals, thresholds and examples remain. |

The task does not claim that every removed literal survives as one identical inline span. The exact list and batch decisions are retained so reviewers can challenge a particular condensation without reopening all 92 pages.

## Commands and outcomes

All commands ran locally on macOS. Default Node was v26.8.2; Mintlify used `/opt/homebrew/opt/node@22/bin/node` with that directory first in PATH. Cached package `mint` version 4.2.731 supplies the Mintlify CLI.

| Command | Outcome / evidence |
| --- | --- |
| `git merge-base --is-ancestor 2175058c1e1dfd5850a61914566ab45110a65ef4 HEAD` | Passed before integration; repeated after commit in final receipt. |
| `npm --workspace=@bastani/atomic run docs:check` | Passed; `logs/docs-check.txt`. |
| `npx --no-install vitest --run --project unit test/unit/docs-information-architecture.test.ts` | 29 tests passed; `logs/information-architecture.txt`. |
| `npm run check` | Passed Biome, root and coding-agent typechecks, shrinkwrap check; `logs/check.txt`. |
| `PATH=/opt/homebrew/opt/node@22/bin:$PATH node ~/.npm/_npx/ba80d1e8ef6a1977/node_modules/mint/index.js validate` | Run in `packages/coding-agent/docs`; build validation passed; `logs/mintlify-validate.txt`. |
| Same runtime/CLI, `broken-links` | No broken links; `logs/mintlify-links.txt`. This command does not validate anchors without its optional flag; IA and preservation checks supply anchor coverage. |
| `~/.local/bin/qlty --version` and `~/.local/bin/qlty check` | 0.642.0, exit 0, no applicable modified files. Existing config has no Markdown plugins. **Not Markdown lint coverage**; config unchanged; `logs/qlty.txt`. |
| `git diff --check` | Passed. |
| Signed conventional `git commit -S` with hooks enabled | Final receipt records commit, hook result, signature and clean status. No hook bypass. |

### Failures repaired during integration

1. IA initially failed because the amendment changed the protected sidebar label from “Compaction internals” to “Compaction reference”. Restored only the sidebar label. The audience-focused body and description remain. All 29 tests pass without weakening the test.
2. The new local maintainer-link check found `docs/ci.md#release-pipeline`, which does not exist. Updated the new maintainer link and user-guide handoff to `#direct-release-trigger-and-recovery`; the audit passes.
3. Browser deep-anchor automation first used an invalid CSS ID selector beginning with a digit, then raced a hydrating element. Replaced it with a DOM `getElementById` check after presence, followed by scrolling and hash navigation. Final capture confirms the exact ID, next heading, and two incoming links. No product change was needed.

These were tracked during work in root `issues.md`; removed after resolution. The generated root `progress.md` was also removed as requested.

## Browser scenarios

Owned preview launched through tmux in the docs directory:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node ~/.npm/_npx/ba80d1e8ef6a1977/node_modules/mint/index.js dev --port 3333
playwright-cli -s=readability open http://localhost:3333/compaction
```

Expected: edited guides render real content, fit the viewport, preserve navigation and anchors, and expose usable maintainer handoffs. Used installed `/opt/homebrew/bin/playwright-cli` and a dedicated browser session. Exact executed browser scripts are included in the captured CLI receipts.

- At **1440×1000** and **390×844**, visited installation, compaction, Intercom operations, models, SDK, subagent reference, workflow operations/API reference, tools, and development. All ten routes at each size rendered a title; document scroll width equaled viewport width. Results and desktop maintainer hrefs are in `browser/desktop.txt` and `browser/mobile.txt`, CLI receipts containing JSON results.
- Opened the mobile Navigation control and captured `browser/mobile-navigation.yaml`. Clicked the article's Installation link and confirmed `/getting-started/installation`, in `browser/navigation.txt`.
- Exercised `/workflows/reliable-design#3-adversarial-verification`; `browser/anchor.txt` confirms the exact ID, following “3. Adversarial verification” heading, and two links. Captured `browser/workflow-anchor-desktop.yaml` and `.png`.
- Captured and inspected `browser/development-desktop.png` and `browser/development-mobile.png`, plus their DOM snapshots. Text and moved-knowledge links wrap within the viewport. Existing template/body duplicate page titles remain; changing original headings would violate preservation scope.
- Maintainer GitHub targets were validated against local files and GitHub-style heading anchors, not fetched from main. New destinations become available remotely **after merge**. A pre-merge network 404 is not a source regression.
- `browser/console.txt` shows zero errors and the preview's Socket.io connection warning. No runtime/browser behavior outside documentation rendering was tested.
- Closed the owned browser and terminated the owned tmux preview session. No shared browser/server was stopped.

## Scope, ownership and remaining risks

The separate `../atomic-remove-evals-ui` workflow owns root `evals/`, root `ui/`, their references, and obsolete recursive-submodule setup. Integration searched all new maintainer destinations and found no obsolete root evals/ui/submodule-only guidance to remove or restore. No directory/infrastructure deletion was duplicated. `models/evals.md` remains model benchmark documentation. All 16 mapped original fences survive without an obsolete-setup exception.

The historical factual contradictions listed in the batch ledgers remain deferred: SDK router availability; credential-export flag wording; thinking-token paragraph placement; complete SDK example disposal; Gemini catalog discrepancy; compaction representation and keep-target wording; DBOS provisioning versus post-readiness failure; and mandatory versus excluded Intercom. Benchmark dates/prices, third-party URLs, Windows ARM64 behavior and uncited research measurements were not revalidated. No new factual/API decision was made to settle them.

Automated preservation is not proof of technical truth or perfect prose equivalence. Browser checks are representative, not a rendered review of all 92 pages; mobile coverage is a viewport resize, not physical-device validation. GitHub main availability awaits merge. Independent reviewer/reducer approval and the later authorized update to existing PR #3120 remain separate steps. No push or PR write occurred here.
