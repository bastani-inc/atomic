# Verification and evidence

Use executable verification appropriate to the changed behavior. Workflow authors should put the same evidence contract in worker, reviewer and final handoff prompts. Goal and Ralph share this guidance. Reviewers inspect actual artifacts and results, not claims or filenames.

## Execution mode

An explicit request to work `inline`, `do this directly`, `don't use a workflow`, or equivalent overrides workflow-first defaults for that task, including complex implementation and review loops. Do not create or launch a hidden or nested replacement workflow, or ask the user to reapprove the choice. Keep appropriate testing, review and evidence inline. Safety and authorization requirements do not change.

Apply the preference only to its stated task. Quoted examples and questions about inline code are not execution-mode instructions. Without an opt-out, normal workflow fit defaults apply.

If the user switches during an active workflow, safely hold or stop the affected run using its available lifecycle controls. Reconcile completed work and in-flight side effects before continuing inline so commands and external writes are not duplicated. Stages notify the controlling session rather than launching a replacement. Already-completed work remains completed; do not claim it was undone.

## Select the verification environment

Inspect installed tools, cached runtimes, existing sessions and safe test configuration first. Install missing tools/plugins when online access and permissions permit. Known offline or restricted installation is enough reason not to attempt a prohibited download. Otherwise make a reasonable capability check or one bounded setup attempt, not an endless installation retry loop.

When a mechanism cannot run, continue available authoritative repository checks, retain useful local evidence, and record the constraint, attempted commands and observed output, narrower validation and missing coverage. Do not require production credentials or take unsafe actions to satisfy a generic verification suggestion. An unavailable optional mechanism is not failed implementation, but it does not waive a required project check.

| Changed behavior | Verification and evidence |
| --- | --- |
| Browser/frontend, including API-dependent flows | Use the playwright-cli skill. Exercise the real user flow and assert its result. Retain current screenshots, video, DOM snapshots or network evidence as appropriate. |
| TUI/terminal | Use tmux on supported hosts, native Windows psmux, or herdr where available and appropriate. Exercise actual interactive input and inspect pane output or a terminal recording. These tools do not have interchangeable CLIs. |
| Desktop/simulator/emulator | Use suitable PyAutoGUI or native platform tools against a real visible app scenario. Capture screenshots/video from that environment, not a browser recording labeled as desktop or iOS proof. |
| Non-UI | Run relevant unit, integration, build, type or command-line scenarios. Do not manufacture a UI or video requirement. |

### Terminal contracts

[psmux](https://github.com/psmux/psmux) is a native Windows ConPTY multiplexer using tmux-style commands. Its [scripting guide](https://github.com/psmux/psmux/blob/master/docs/scripting.md) documents `psmux capture-pane -p -t %0` for stdout capture. Verify installed help and use the actual pane identifier rather than assuming `%0` belongs to the test.

[herdr's CLI](https://herdr.dev/docs/cli-reference/) talks to a running server. Discover your isolated test pane with `herdr pane list`. `herdr pane run <pane_id> <command>` submits a command with Enter; `herdr pane send-text` alone does not submit. `herdr pane read <pane_id> --source visible` returns the screen text. For bounded waits use `herdr pane wait-output <pane_id> --match <text> --timeout 10000`. Do not confuse pane output with an agent lifecycle status or infer success from `idle`. Check installed version/help and host support before use. Do not take over unrelated panes.

### Desktop safety

The [OpenAI CUA sample](https://github.com/openai/openai-cua-sample-app#first-run) distinguishes JavaScript Playwright browser control from Python PyAutoGUI desktop input. It is an optional sample requiring API/model access, not a prerequisite for every GUI test. Follow its [Python quickstart and interruption guidance](https://github.com/openai/openai-cua-sample-app/blob/main/python-app/README.md).

Use a dedicated desktop/session with controlled fixtures. macOS needs Accessibility and Screen Recording permissions for the launching app; Linux PyAutoGUI needs an appropriate X11 desktop and dependencies; Windows needs a graphical session. Screenshots may include other windows and PyAutoGUI controls real mouse and keyboard input. Keep failsafes enabled, inspect privacy before saving/sharing, release held keys/buttons after interruption, and check for leftover processes before restarting. Do not install the sample's pnpm dependencies into an npm repository.

A visible simulator/emulator or suitable native automation/mirroring setup is required for mobile UI. PyAutoGUI does not directly control an arbitrary physical iPhone. Use native platform tooling where it provides better assertions or safer input.

## qlty setup and fallback

Use the qlty skill to choose reliable, low-noise checks and useful metrics based on user priorities and repository evidence. Preserve existing `.qlty/qlty.toml`, the project's chosen tools such as Biome, and authoritative package/CI checks. Do not add competing formatters or run wholesale formatting by habit. Record command/output, scope and a relevant baseline; numbers without a decision are not useful verification.

During authorized coding, absent config permits `qlty init --no` or a hand-authored `.qlty/qlty.toml`; inspect generated suggestions. Missing config alone is not a blocker. For offline/restricted installation or a missing binary, use the skill's bundled manual-configuration reference to prepare TOML without network when configuration edits are in scope. Use source-backed options, omit unknown optional plugin versions rather than inventing them, and validate syntax/schema with available tools. Read-only tasks stay read-only or use isolated scratch config.

Installed built-in metrics/smells may work offline. Cached plugins may work too, but uncached source/plugin/runtime resolution can require downloads. Report configuration prepared separately from lint/security/metrics actually run. TOML parsing is not proof of plugin availability or a passing quality check. Continue available repository checks without making optional qlty installation a universal blocker.

## Native GitHub media

Only publish to an authorized target. Detect the provider first and inspect/redact artifacts for secrets, personal information and unrelated windows. Name the verified commit and scenario in the accompanying evidence. Collection alone is not upload authorization.

[GitHub CLI >=2.99.0](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/) supports repeatable `--attach` on `gh issue create`, `edit`, `comment` and `gh pr create`, `edit`, `comment`. Check `gh --version` and the specific command's `--help` before using it. For an authorized PR comment:

```sh
gh pr comment 123 --repo owner/repo --body-file evidence.md --attach proof.mp4
```

Use actual target and file values. Attach each file once. A body-local path reference is rewritten to the hosted URL; other attachments append in flag order. Images can use `--attach 'screen.png#Image alt text'`; videos do not support alt text. A standalone `![](proof.mp4)` paragraph is rewritten to an embedded player. See [official attachment documentation](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).

Supported media include PNG, JPEG, GIF, WebP, SVG, MP4, MOV and WebM. Images/GIFs have a 10 MB limit; video limits are 10 MB on Free and 100 MB on paid plans. Repository write access and supported OAuth/classic PAT authentication are required; this release does not support GitHub Enterprise Server. Recheck current limits for the chosen host/account.

Read back the created or edited issue/PR/comment and confirm usable GitHub-hosted links before reporting success. Unsupported versions, hosts, providers, auth or sizes require a truthful fallback: retain the local artifact and explain authorized manual attachment or supported provider tooling. Do not claim a `file://` reference is uploaded evidence or send artifacts to unrelated third-party hosts.
