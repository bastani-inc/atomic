# Verification guidance implementation

## Frozen contract and acceptance matrix

The goal is to implement every prompt, workflow-prompt, skill and documentation revision in the 2026-09-05 verification-guidance handoff, without runtime algorithm changes. The full handoff and goal ledger remain authoritative. Evidence below distinguishes prompt construction, manual decision evaluation, executable fixture checks and deferred external approval.

| Handoff clauses | Required outcome | Check |
| --- | --- | --- |
| 4, 11–15 | Separate designated branch after merged resume fix; no repeat repair, publication, historical resume or repository qlty rollout | Git branch/status/history; PR #2864 merged at 27fff253b3; isolated fixture only |
| 6, 33–34 | Exact examples `inline`, `do this directly`, `don't use a workflow`; complex tasks honor opt-out without hidden/nested workflow or reapproval pressure | Constructed default and Goal/Ralph prompt tests and representative decisions |
| 33–34 | Scope preference to requested task; quoted examples and inline-code questions are not mode instructions; absent opt-out retains default | Scoped, quoted, default evaluation cases |
| 33 | Active workflow → safely held/stopped → reconcile completed work/in-flight effects → inline without duplicates; completed work remains completed; safety/authorization persist | Transition evaluation and prompt assertions |
| 14, 18, 32 | All shipped default/authoring/shared/Goal/Ralph worker/reviewer/final PR consumers agree; no generated-copy edits | Consumer inventory, constructed prompts and source diff |
| 35 | Browser playwright-cli real assertions and screenshot/video/network/DOM evidence | Browser decision case and CLI source check |
| 36 | Terminal tmux/psmux/herdr selected by actual host support; real interactive pane/text/video evidence; no invented interchangeability | Official sources and terminal decision case |
| 29, 37 | Desktop/simulator PyAutoGUI or native tooling; dedicated session, permissions, safe fixtures and input cleanup; no arbitrary physical iPhone claim or browser-as-iOS proof | CUA root/Python quickstart/interruption sources and simulator decision case |
| 8, 38 | Prefer installed/cached tools; install online when permitted; known restrictions suffice, otherwise bounded check; no repeated blocked downloads, production credentials or unsafe actions | Offline/restricted/online evaluations |
| 39 | Missing config permits init/manual setup for authorized coding; inspect generated config, preserve existing/read-only and repo checks, low-noise metrics with baseline, no format churn | Isolated fresh config plus existing/read-only evaluations |
| 8, 40 | Missing binary/init/offline: bundled-reference manual TOML, no invented versions/flags; available validation; distinguish preparation from execution; optional qlty not universal blocker | Manual fixture and missing-binary/cached-plugin evaluations |
| 21–27, 41 | GitHub detection; >=2.99.0 repeated native --attach; six commands, body rewrite/append, alt text, supported formats/limits/auth/host; authorized inspected/redacted commit/scenario media, hosted-link confirmation; truthful unsupported fallback | Official announcement/docs/help and GitHub/non-GitHub/unsupported decision cases; no live upload authorized |
| 42–43 | Browser, terminal, desktop/simulator, non-UI, missing/existing config, read-only, GitHub/non-GitHub/unsupported, offline/restricted/missing binary/cached/manual scenarios | Durable constructed-prompt tests and representative evaluation artifacts |
| 44 | User docs in packages/coding-agent/docs synchronized; only applicable Unreleased notes; released sections, versions, lock/toolchain/raw TS unchanged | Diff and docs check |
| 45 | Relevant Vitest and npm run check; signed clean checkout; independent review later | Commands, signed SHA, status; reviewers own approval |
| 45 | Separate PR, exact-head CI/review before merge, release gated on both merges | Later authorized parent action, not this child |

## Interface and state decisions

No runtime APIs, fields, optionality, return identities, ordering or duplicate behavior change. Prompt inputs and evidence paths remain verbatim. Configuration is preserved rather than overwritten. The execution-mode change is instruction guidance, not a new parser or runtime state machine. An active switch requires reconciliation before further execution; a quoted request does not transition state. Existing safety and authorization boundaries apply in every state.

## Evidence

Parent setup: npm ci --ignore-scripts and npm run build passed. Correct branch docs/workflow-verification-guidance at prerequisite merge 27fff253b382819f576f9f7b12f8e21625dc25a0.

Final commands in this checkout:

```sh
npx vitest --run --project unit test/unit/verification-guidance.test.ts test/unit/builtin-workflows-goal*.test.ts test/unit/builtin-workflows-ralph*.test.ts test/unit/execution-routing-guidance.test.ts test/unit/builtin-workflow-steering-propagation.test.ts test/unit/workflow-lifecycle-notifications-*.test.ts
npm run check
npm run build
npm run docs:check --workspace=@bastani/atomic
git diff --check
```

Results: 160 tests passed in 16 files. Existing Vite dynamic-import warning in builtin-workflow-steering-propagation.test.ts remains non-failing. Check passed Biome, root/package typechecks and shrinkwrap verification. Build regenerated ignored shipped assets successfully. Docs link validation passed 45 pages. Diff whitespace check passed. Logs: /tmp/verification-final-tests.log, /tmp/verification-final-check.log and /tmp/verification-final-build.log.

The new test inspects actual dispatched Goal/Ralph worker, reviewer and authorized final PR prompts. It does not add a test-side steering wrapper. Prompt assertions establish wiring and instruction contracts, not stochastic model compliance. Existing tests changed only where their former absolute workflow/credential wording conflicts with this contract, or where a broad `completed` match accidentally matched the new reconciliation text instead of the lifecycle status. Runtime logic is unchanged.

Manual scenario decisions are individually recorded in verification-guidance-evaluations.json, IDs 1–16. Each includes the actual representative input, expected output, observed application of the constructed prompt rules and limitations. These are manual evaluations, not live model trials or proof that a model will always obey.

## Detailed scenario traceability

| Required scenario | Evidence |
| --- | --- |
| Complex implementation `inline` | Evaluation 1; default and dispatched mode-contract assertions |
| `don't use a workflow` | Evaluation 2; exact literal assertion |
| `do this directly` | Evaluation 2; exact literal assertion |
| Active workflow → hold/stop | Evaluation 3; dispatched prompts and actual lifecycle notification test |
| Reconcile completed work before inline | Evaluation 3; ordered transition prose and lifecycle assertion |
| Reconcile in-flight side effects/no duplicate execution | Evaluation 3; explicit dispatched contract |
| Do not claim completed work undone | Evaluation 3; default/lifecycle assertions |
| Task-scoped preference | Evaluation 4 |
| Quoted no-workflow examples | Evaluation 5 |
| Inline-code questions | Evaluation 5 |
| Default workflow without opt-out | Evaluation 6; existing routing tests retained |
| Browser/API-dependent flow | Evaluation 7; executable browser fixture below |
| Windows psmux | Evaluation 8; official psmux README/scripting contract, not Windows execution |
| herdr distinct CLI | Evaluation 8; official CLI read/run/wait-output contract, not native execution |
| tmux interactive pane | Dedicated fixture server launch/capture/interruption below |
| Desktop/simulator native/PyAutoGUI | Evaluation 9; CUA Python setup/interruption source; no live simulator claim |
| Non-UI | Evaluation 10; no fabricated UI/video required |
| Offline/no-network | Evaluations 10, 13, 14 |
| Missing qlty config, permitted online setup | Evaluation 11; isolated init command below |
| Existing qlty config | Evaluation 12; preservation contract |
| Explicit read-only | Evaluation 12; no init/format mutations authorized |
| Restricted installation | Evaluation 13; no prohibited download attempt required |
| Missing qlty binary | Evaluation 13; manual TOML preparation distinct from execution |
| Manually authored config | Evaluation 13; parsed and loaded fixture below |
| Cached plugin | Evaluation 14; decision evaluated, not an actual cached-plugin lint run |
| Uncached plugin fallback | Evaluation 14; decision evaluated, no fake check claim |
| GitHub supported media | Evaluation 15; installed gh 2.100.0 help proves --attach support, no upload performed |
| Non-GitHub provider | Evaluation 16 |
| Unsupported CLI/host/auth/size | Evaluation 16 and publication fallback contract |

## GitHub source contracts, individually checked

Official attachment documentation and the 2026-09-01 announcement were fetched. Installed `gh --version` reports 2.100.0; `gh pr comment --help` describes native attachment upload, body rewrites and image-only alt text. Publication itself is not authorized or tested.

| Clause | Current evidence |
| --- | --- |
| gh >=2.99.0 | Official announcement; installed 2.100.0 |
| gh issue create --attach | Official command list; shared final prompt/docs |
| gh issue edit --attach | Official command list; shared final prompt/docs |
| gh issue comment --attach | Official command list; shared final prompt/docs |
| gh pr create --attach | Official command list; shared final prompt/docs |
| gh pr edit --attach | Official command list; shared final prompt/docs |
| gh pr comment --attach | Official command list and installed help; actual final prompt assertion |
| Repeatable flags, each file once | Official docs; shared prompt |
| Body-local rewrite | Official docs and installed help |
| Unreferenced append in flag order | Official docs; shared prompt |
| Image path#alt text | Official docs and installed help |
| No video alt text | Official docs and installed help |
| Standalone video paragraph/player | Official docs; shared prompt |
| PNG | Announcement supported format; docs |
| JPEG | Announcement supported format; docs |
| GIF | Announcement supported format; docs |
| WebP | Announcement supported format; docs |
| SVG | Announcement supported format; docs |
| MP4 | Announcement supported format; docs |
| MOV | Announcement supported format; docs |
| WebM | Announcement supported format; docs |
| Images/GIF 10 MB | Announcement limit; docs |
| Video Free 10 MB | Announcement limit; docs |
| Video paid 100 MB | Announcement limit; docs |
| OAuth/classic PAT and repo write access | Announcement/auth requirements; docs |
| GHES unsupported | Announcement; truthful fallback docs |
| Provider/target authorization | Evaluation 15/16 and actual final prompt assertion |
| Inspect/redact secrets and unrelated windows | Shared prompt and docs; local screenshot inspected |
| Verified commit/scenario attribution | Shared prompt and docs; no stale media success claim |
| Read back usable hosted link | Actual final prompt assertion; no live upload claim |
| No file:// fake attachment | Shared prompt and fallback docs |
| No unrelated third-party upload | Shared prompt and fallback docs |

Sources: https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli ; https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/ ; https://docs.qlty.sh/llms.txt ; https://docs.qlty.sh/cli/qlty-toml.md ; https://herdr.dev/docs/cli-reference/ ; https://github.com/psmux/psmux/blob/master/docs/scripting.md ; https://github.com/openai/openai-cua-sample-app#first-run ; https://github.com/openai/openai-cua-sample-app/blob/main/python-app/README.md .

## Isolated executable fixtures

qlty 0.642.0 was installed. No `.qlty` was added to this repository. Fresh initialization in /tmp/atomic-qlty-init.A8v5Ki used `git init -q` then `qlty init --no --skip-plugins --skip-default-source --no-upgrade-check`: exit 0, config created with 0 plugins. This proves setup, not lint coverage.

Manual fixture /tmp/atomic-verification-qlty-fixture used the exact minimal TOML in the bundled manual reference, plus sample.ts containing `export function double(value: number): number { return value * 2; }`. After `git init -q`, the reference's Python tomllib command printed `TOML parsed; config_version is string 0`. `qlty metrics --all --no-upgrade-check` loaded the config and analyzed one function/three LOC. `qlty smells --all --no-upgrade-check` reported `No issues`. `qlty check --all --no-upgrade-check` and `qlty fmt --all --no-upgrade-check` exited 0 without output because no plugins were configured: explicitly no lint/format coverage. Syntax parsing plus successful qlty loading is not full plugin schema validation. No downloads were required by these fixture commands; network isolation was not imposed.

Browser fixture /tmp/atomic-verification-browser.html contains a Save fixture button that sets an output element to Saved. `playwright-cli -s=verification-guidance open file:///tmp/atomic-verification-browser.html` reported file protocol blocked. The bounded recovery was a dedicated tmux session running `python3 -m http.server 18764 --bind 127.0.0.1` from /tmp. `playwright-cli -s=verification-guidance goto http://127.0.0.1:18764/atomic-verification-browser.html`, `snapshot`, `click e2`, and `eval "document.querySelector('output').textContent === 'Saved'"` returned true. `screenshot --filename=/tmp/atomic-verification-browser.png` saved inspected real evidence. The only console error was favicon.ico 404; the app returned HTTP 200. Screenshot proves the fixture, not Atomic UI or simulator behavior.

`tmux capture-pane -t verification-guidance:0.0 -p` recorded real server output; `tmux send-keys -t verification-guidance:0.0 C-c` stopped it and the captured output /tmp/atomic-verification-pane.txt shows keyboard interruption and shell return. `playwright-cli -s=verification-guidance close` and `tmux kill-session -t verification-guidance` cleaned up only the owned sessions. No other desktop/panes were controlled, no media uploaded.

## Source inventory and preserved invariants

Default instructions originate in workflow-prompts.ts; lifecycle-notifications.ts contained a second contradictory inline restriction. Shared E2E/quality/steering text reaches Goal/Ralph through their existing builders and steering-context wrapper. Goal and Ralph final PR construction now explicitly includes the shared verification/publication contracts. Ralph's browser-only video builder and output description now use domain routing. Reviewer setup text distinguishes required dependencies from optional tools. User docs link the single verification guide; qlty's bundled manual reference supports missing-binary/offline use.

`git diff --name-only` shows no manifest, lockfile, Cargo, generated artifact or version change. Released changelog suffixes from `## [0.9.18-alpha.6]` were compared character-for-character to HEAD and are unchanged. Only Unreleased entries changed. Runtime algorithms, public field identity/optionality and raw TypeScript distribution are unchanged. Signed commit and final clean status are recorded in the delivery receipt, not self-referentially embedded here.

## Contract amendments received

User/supervisor amendment: separate resumed-frontier runtime follow-up in ../atomic-tool-frontier-consumption must remain outside our enhancements diff, and publication additionally requires its resolution/merge. Eventual guidance PR owner must inspect actual review threads/comments, not equate Greptile SUCCESS with no blockers; report unresolved actionable feedback. No PR action from this child.

This amendment is an external gate, not a runtime change here. No files from that follow-up were incorporated. Independent reviewer approval, actual PR thread inspection, exact-head CI, merges and publication remain later authorized actions.

## Deferred

Existing CONTRIBUTING.md/DEV_SETUP.md release-age and DEV_SETUP.md Bun SQLite documentation drift is unrelated and unchanged.
