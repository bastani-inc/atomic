# Verification and evidence

Verify the behavior that changed, then give the reviewer enough evidence to understand the result. A small fix may need a focused test and a short explanation. An interactive change usually needs a real user scenario as well. A video is useful when it shows something a test log or screenshot cannot; it is not required for every PR.

For tool installation, automation techniques, platform permissions, and general work in applications, read [Computer use](/computer-use). That guide covers Herdr for terminals, agent-browser for browsers, and PyAutoGUI with uv for desktop CUA on macOS, Linux, and Windows. It also covers native accessibility and application tools when they are easier or more reliable.

<a id="select-the-verification-environment" />

## Choose checks that answer the question

Start with the project's existing tests, build, typecheck, and lint commands. Add an interactive scenario when the change affects what a user sees or does. Do not replace required checks with a recording, or create a UI solely to demonstrate a non-UI change.

| Changed behavior | Preferred mechanism | What to check |
| --- | --- | --- |
| Interactive terminal or TUI | **Herdr**, under its explicit-request and managed-pane requirements; tmux or native Windows psmux as fallbacks | Actual input, rendered output, navigation, resizing, and exit behavior relevant to the change. |
| Browser/frontend | **agent-browser** | The user flow and its visible result, with DOM or network assertions where useful. |
| Desktop app, simulator, or emulator | **PyAutoGUI with uv**, supplemented by native/app APIs | The visible app scenario and its saved or exported result. |
| API, library, script, or other non-UI behavior | Existing test runner and shell commands | Inputs, outputs, error handling, and relevant build/type contracts. |
| Documentation | Documentation checks and example review | Links, navigation, command accuracy, and whether a reader can follow the instructions. |

See [tool selection](/computer-use#choose-the-right-tool) before operating a session. Herdr is the terminal priority, but the preference does not authorize control from outside a Herdr-managed pane. Install missing tools when permitted; otherwise use the available fallback and describe any coverage gap.

## Define a reproducible scenario

Before running it, write down:

- The behavior being verified and the expected result.
- The commit or artifact under test, plus any uncommitted changes.
- The environment that matters, such as OS, app/browser version, terminal dimensions, display scaling, and test fixtures.
- The actions and assertions, including a relevant failure or edge case.

Use dedicated sessions and non-production data. Wait for observable completion with a deadline instead of assuming that a submitted command or a fixed delay means success. Preserve useful failure output before cleanup.

After a repair, rerun the affected checks on the new candidate. Label before/after evidence and keep it clear which commit produced each result. Do not present an earlier passing run as verification of later edits.

## Capture evidence appropriate to the change

### Browser changes

Use agent-browser to exercise the actual flow. A screenshot can show layout; a DOM snapshot can show control state; console and network output can help establish why a flow failed. Pair captures with assertions about the result, such as a saved record appearing after reload.

For a named browser session you own, the CLI supports captures such as:

```sh
agent-browser --session pr-check snapshot > after.yaml
agent-browser --session pr-check screenshot after.png
```

For behavior best shown in motion, check the installed CLI's help, start recording before the relevant actions, and stop afterward:

```sh
agent-browser --session pr-check record start flow.webm
# Exercise the scenario here.
agent-browser --session pr-check record stop
```

Open the saved artifact and confirm it includes the final state. Keep recordings short and focused. Inspect authentication state and network output for secrets before sharing. See [browser setup and best practices](/computer-use#browser-automation-with-agent-browser).

<a id="terminal-contracts" />

### Terminal changes

Use Herdr to send real interactive input and inspect the resulting pane, or use tmux/psmux when Herdr cannot be used. Keep the terminal dimensions and shell relevant to the change. Test narrow layouts or modified keys when those are affected.

Retain screen captures or transcripts that show the input and result. For cursor movement, redraws, colors, or timing, a terminal recording or video may explain more than plain text. Capture important states during the run; alternate-screen content may not remain in scrollback. Check exit status or explicit assertions rather than treating an agent's `idle` indicator as a passing result.

See [terminal setup and capture commands](/computer-use#terminal-automation-with-herdr). A browser rendering of terminal text is not proof that the real TUI accepted input. WSL tmux does not establish native Windows terminal coverage.

<a id="reproduce-stage-skill-terminal-evidence" />

<a id="desktop-safety" />

### Desktop, simulator, and emulator changes

Run PyAutoGUI through uv in a dedicated graphical session, using [the desktop guide](/computer-use#desktop-automation-with-pyautogui-and-uv). Native accessibility tools or application APIs can give more reliable assertions than pixel matching. For example, check a saved document through the app API after exercising the visible Save flow.

Capture the actual application or simulator. A browser recording is not desktop or iOS evidence. PyAutoGUI can interact with a visible simulator/emulator window, but does not directly control an arbitrary physical phone. Use supported native tooling where needed, and name the device or emulator actually exercised.

Keep failsafes enabled and release held keys/buttons after interruption. Inspect saved files and exports rather than assuming a completed click means a completed operation. Screenshots show appearance, not necessarily persistence or correctness.

## Use evidence in a workflow

Give workers, reviewers, and the final handoff the same scenario and success criteria. A verification stage should produce commands, observed results, and artifact paths. The reviewer should inspect those results, not just accept the worker's summary or a filename.

For workflow-owned checks, use durable `ctx.tool` calls with finite timeouts and cancellation. Pass scripts and larger evidence through files. After a failed check, send the actual failure to a bounded repair step and rerun the affected checks. Keep implementation acceptance separate from later PR creation, upload, or publication. See [workflow authoring](/workflows/authoring) and [reliable design](/workflows/reliable-design).

### Execution mode

The same verification standard applies inline. A task-scoped request such as `quickly`, `inline`, or `don't use a workflow` means no workflow creation or launch, including hidden replacements. If switching an active run to inline, stop or hold it safely and reconcile completed work and in-flight effects before continuing. See [when to use workflows](/workflows#when-to-use-workflows).

## When a tool or environment is unavailable

Inspect installed tools and cached runtimes first. Install missing tools or plugins when network access and permissions allow. If installation is restricted, or no suitable graphical session is available, continue the checks that can run and record:

- What was unavailable and the observed error or known restriction.
- Any setup attempt and the narrower checks that actually ran.
- What still needs verification, including missing platform coverage.

Do not require production credentials or bypass permissions to satisfy a generic verification suggestion. An optional tool being unavailable is not an implementation failure, but a required project check remains required. Do not label skipped, mocked, or simulated coverage as a real platform run.

### qlty setup and fallback

Use the qlty skill when it adds useful lint, security, or complexity checks. Preserve the repository's existing tools and `.qlty/qlty.toml`; do not introduce a competing formatter or wholesale formatting changes.

When configuration changes are in scope, missing config can be initialized with `qlty init --no` or prepared manually using the skill's bundled configuration reference. Review generated suggestions. Read-only tasks should remain read-only or use isolated scratch configuration.

Cached plugins and built-in metrics may work offline; uncached plugins or runtimes may need downloads. Report prepared configuration separately from checks actually executed. Valid TOML is not proof that a plugin ran. Optional qlty setup should not block available repository checks.

## Include evidence in a PR

Give the reviewer a short summary before linking logs or media. For example, replace the placeholders in this template with observed results:

```markdown
## Verification

- Candidate: <commit SHA; note any uncommitted changes>
- Environment: <OS, app/tool versions, relevant dimensions>
- Checks: <command and result>
- Scenario: <starting state, actions, expected and observed result>
- Evidence: <hosted links or attached artifacts>
- Limits: <checks/platforms not exercised>
```

Attach a screenshot for a visual state, a short recording for an interaction, or logs for command behavior. Include reproduction steps even when media is available. Label local-only paths as local; reviewers cannot open a file on your machine. CI artifact links are useful when readers have access, but note retention limits where relevant.

Only upload to an authorized repository or destination. Inspect and redact secrets, personal information, private source content, and unrelated windows before attaching files. Permission to collect local evidence is not permission to publish it.

### Native GitHub media

[GitHub CLI 2.99.0 and newer](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/) supports repeatable `--attach` on issue and PR `create`, `edit`, and `comment` commands. Check `gh --version`, the specific command's `--help`, and the host's [attachment support and limits](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).

For an authorized PR comment, replace the target and file paths:

```sh
gh pr comment 123 --repo owner/repo --body-file evidence.md \
  --attach 'after.png#Settings panel after saving' \
  --attach flow.webm
```

The backslashes above are POSIX shell continuations. In PowerShell, use a single line or PowerShell continuation syntax.

Attach each file once. The CLI rewrites body-local attachment references to hosted URLs; otherwise it appends attachments in flag order. Images support `#Image alt text`; videos do not support alt text. A standalone `![](flow.webm)` paragraph in the body becomes an embedded player. These are CLI attachment features, not support for arbitrary local paths in GitHub Markdown.

Supported media include PNG, JPEG, GIF, WebP, SVG, MP4, MOV, and WebM. Uploads require repository push access and supported authentication. Recheck current size limits and authentication support for the target account and host. The 2.99.0 release does not support GitHub Enterprise Server.

Read back the created or edited PR/comment and confirm usable hosted links before reporting an upload as successful. If the CLI, provider, authentication, or file size is unsupported, retain the local artifact and explain the manual attachment path or supported provider tooling. Do not upload to an unrelated host to work around a limitation.
