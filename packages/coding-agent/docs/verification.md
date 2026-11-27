---
title: "Verify changes with evidence"
sidebarTitle: "Verify changes"
description: "Choose real checks for code, terminal, browser, and desktop changes, capture reproducible evidence, and attach it to pull requests."
---

Good verification exercises the exact behavior that changed. A unit test and its output may be enough for a library fix; when a change affects what a user sees or does, test that interaction directly. A screen recording helps when motion or timing matters, though it does not replace required automated tests.

## Choose checks that answer the question

Start with the project's required tests, build, typecheck, and lint. Then ask what could still fail if all of those pass:

| Change | Useful check | Evidence to keep |
| --- | --- | --- |
| API, CLI, or library | Run the affected entry point with a representative input plus a failing or boundary case. | Exact command, exit status, expected output, and actual output. |
| Terminal interface | Send real keystrokes in a real terminal at the affected dimensions. | Before and after pane contents, focus or cursor state if relevant, and exit status. |
| Browser or desktop UI | Exercise the visible action and verify the resulting state—ideally after reopening or reloading. | Accessibility snapshot, screenshot, and the checked postcondition. |
| Documentation | Follow the instructions from the stated starting point, run examples, and check links and anchors. | Which example ran, the outcome, and any prerequisites. |

<Tip>
Past sessions, commits, and pull requests can suggest useful checks, but they never prove the current revision works. Always re-verify against your current candidate. For tool setup, OS permissions, and coverage limits, see [Automate apps, browsers, and terminals](/computer-use).
</Tip>

## Define a reproducible scenario

<Steps>
  <Step title="Record the revision and environment">
    Note the tested commit or artifact (including local changes), OS, app version, terminal size or browser, and starting fixture. Use non-production data and a dedicated session.
  </Step>
  <Step title="State the action and postcondition upfront">
    Write down what proves success before acting—for example, "With notifications off, enable them, click Save, reopen Settings, and confirm the toggle stays on." A successful click alone does not prove persistence.
  </Step>
  <Step title="Wait for observable state and preserve failures">
    Wait for an observable condition with a deadline rather than using a fixed sleep, and save failing output before cleaning up.
  </Step>
  <Step title="Rerun and label before/after evidence">
    After a fix, rerun the affected checks against the updated revision and label before and after files clearly so reviewers know which revision produced each capture.
  </Step>
</Steps>

## Capture evidence appropriate to the change

### Terminal changes

Use Herdr when explicitly requested inside a Herdr-managed pane; otherwise use a dedicated `tmux` session (macOS/Linux) or native `psmux` (Windows). See [Terminal automation with Herdr](/computer-use#terminal-automation-with-herdr) for setup and commands.

Set the relevant terminal dimensions, send real keystrokes, wait for a fresh result, and capture the pane before leaving the alternate screen. For a shortcut change, capture selection before and after pressing it and confirm which item opened. An idle indicator or successful `send-keys` call is not proof. A browser rendering terminal text is not TUI evidence, and WSL is not native Windows terminal coverage.

### Browser changes

Use [`agent-browser`](/computer-use#browser-automation-with-agent-browser) for supported browsers, Electron apps, and other Chrome DevTools Protocol targets. Inspect a fresh snapshot, perform the action, and verify the resulting DOM or saved state.

Keep a screenshot for layout checks or a short recording for multi-step motion:

```bash
agent-browser --session pr-check snapshot > after.yaml
agent-browser --session pr-check screenshot after.png
```

For motion, run `agent-browser --session pr-check record start flow.webm` before the steps and `agent-browser --session pr-check record stop` afterward, then open the recording to confirm the final state is visible.

**Mobile Safari and native mobile apps.** Run `agent-browser -p ios` against a real iOS Simulator for Mobile Safari (`set device` in Chromium changes viewport size, not the WebKit engine), and record video with `xcrun simctl`. For native mobile apps, use device or emulator tooling such as XCUITest or UI Automator instead of browser captures.

### Native desktop changes

Use [`agent-desktop`](/computer-use#desktop-automation-with-agent-desktop) in a dedicated graphical session after confirming readiness with `agent-desktop status`. Observe the app, act on a ref from that snapshot, wait for the postcondition with a timeout, and read it back.

Keep the snapshot, action, and wait outputs alongside before and after screenshots. If a desktop snapshot is incomplete, capture a fresh snapshot before acting. After a timeout on a click or save, inspect the app and saved files before retrying because the action may already have landed. Approve OS consent dialogs yourself; Atomic pauses rather than clicking through system permission prompts.

## Run static analysis and linting with `qlty`

[`qlty`](https://qlty.sh) coordinates repository linters, formatters, and built-in static analysis (Atomic ships a bundled `qlty` skill; see [Skills](/skills)). Project scripts and CI checks remain authoritative—use `qlty` alongside them rather than replacing repository tooling.

- **Install.** On macOS and Linux, review the installer and run `curl https://qlty.sh | sh` (installs to `~/.qlty/bin`; override with `QLTY_NO_MODIFY_PATH=1` or `QLTY_INSTALL_BIN_PATH`). If you verify release attestations before installing, use `gh` 2.67.0 or newer so missing attestations are rejected.
- **Run scoped checks.** `qlty check` and `qlty fmt` inspect changed files by default. Pass `--all` for the whole repo, `--upstream origin/main` to compare against a branch, or `--filter` / `--skip` with plugin names (or `plugin:rule` on `check`) to narrow scope. Built-in `qlty metrics` and `qlty smells` run offline once installed:

```bash
qlty check
qlty check --upstream origin/main
qlty metrics --functions path/to/file.ts
qlty smells path/to/file.ts
```

- **Config and offline use.** Keep an existing `.qlty/qlty.toml` intact rather than re-initializing over it or adding competing formatters during a read-only review. If config changes are in scope and no `.qlty/qlty.toml` exists, run `qlty init --no` and review the generated file. Cached plugins and built-in metrics work offline, while uncached plugins require network downloads. Valid TOML does not prove a linter ran—record which checks executed and flag any required check that stayed blocked.

## Verify delegated work

When delegating verification to [subagents](/subagents), give them the same scenario and acceptance criteria you want checked directly. Require the tested revision, exact commands, observed results, and saved artifact paths.

After a subagent finishes, inspect its evidence or rerun key checks directly through [codemode](/codemode). A task confirmation, filename, or agreement between reviewers never replaces an actual check result. Fix real failures and rerun against the updated revision before accepting the change. Approving a change stays separate from permission to publish it, which Atomic confirms explicitly (for example via [`ask_user_question`](/tools#ask_user_question)).

If you switch from delegated verification to direct execution in your main session, finish or stop running subagents and inspect modified files and background tasks before repeating commands.

## When a tool or environment is unavailable

Check installed tools and cached runtimes first, and install missing dependencies only when permitted. When setup is blocked, report:

- the missing prerequisite and exact error or restriction;
- the narrower checks that did run and passed;
- what still requires the target environment.

For example, a passing headless-browser test does not verify a native file dialog. Report skipped or simulated scenarios clearly instead of counting them as full-platform passes.

## Include evidence in a pull request

State the tested revision and environment, actions taken, expected and actual outcomes, checks run, and coverage limits. Place each screenshot or clip next to the scenario it proves, with reproduction steps alongside it. Label local-only artifacts clearly because reviewers cannot open paths on your machine.

<Warning>
**Review captures before uploading.** Local capture does not authorize publication. Upload evidence only to an authorized repository after checking and redacting personal data, credentials, private source, and unrelated windows.
</Warning>

### Attach media with GitHub CLI

On a supported GitHub host, verify `gh --version` (`gh` 2.99.0 or newer) and `gh pr create --help` for [GitHub CLI attachment support](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli):

```bash
gh pr create --title "Fix settings save" --body-file body.md \
  --attach 'before.png#Settings before saving' \
  --attach 'after.png#Settings after reopening' \
  --attach flow.webm
```

Use a single line or PowerShell line-continuation syntax on Windows. To add evidence to an existing pull request, use `gh pr edit` or an authorized `gh pr comment` with `--body-file` and `--attach`. The `#text` suffix sets image alt text (omit it for video).

Read back the pull request or comment to confirm the hosted links render before reporting an upload. If the CLI, host, permissions, or file size prevent attachment, keep the artifacts local, explain the limitation, and use the manual GitHub upload path instead of uploading to an unrelated service.

## Related docs

<Columns cols={2}>
  <Card title="Automate apps and browsers" href="/computer-use">
    Set up and safely operate `agent-desktop`, `agent-browser`, Herdr, and `tmux`.
  </Card>
  <Card title="Subagents" href="/subagents">
    Delegate bounded implementation and verification tasks to isolated contexts.
  </Card>
  <Card title="Codemode" href="/codemode">
    Run quick JavaScript verification scripts directly from your main session.
  </Card>
  <Card title="Skills" href="/skills">
    Use bundled skills such as `qlty`, `tmux`, and `herdr` or author reusable check scripts.
  </Card>
</Columns>
