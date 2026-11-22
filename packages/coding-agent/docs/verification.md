---
title: "Verification and evidence"
description: "Choose checks that exercise the change, reproduce a result, and show reviewers what passed and what remains unverified."
---

# Verification and evidence

Good verification tests the exact behavior that changed. A unit test and its output may be enough for a library fix. When a change affects what a user sees or does, exercise that interaction directly. A recording helps when motion or timing matters, though it does not replace a required test.

<a id="select-the-verification-environment" />

## Choose checks that answer the question

Start with the project's required tests, build, typecheck, and lint. Then ask what could still fail if all of those pass:

| Change | Useful check | Evidence to keep |
| --- | --- | --- |
| API, CLI, or library | Run the affected entry point with a representative input and a failing or boundary case. | Exact command, exit status, expected output, and actual output. |
| Terminal interface | Send the actual keys in a real terminal at the affected size. | Before and after pane contents, focus or cursor state if relevant, and exit status. |
| Browser or desktop UI | Exercise the visible action and check the resulting state, preferably after reopening or reloading. | Snapshot or accessibility result, screenshot, and the checked postcondition. |
| Documentation | Follow the directions from the stated starting point. Run the example and check navigation, links, and anchors. | Which example ran, the result, and any prerequisites. |

### Reuse past verification

Past sessions, commits, and pull requests can suggest useful checks, but they do not prove the current revision works. See [Computer use](/computer-use) for tool setup, operating-system permissions, and coverage limits.

## Define a reproducible scenario

Record the candidate (commit or artifact, including local changes), environment (operating system, app version, terminal dimensions, or browser), and starting fixture. Use non-production data and a dedicated session.

State the action and expected outcome before running the check. For example, "With notifications off, switch them on, press Save, reopen Settings, and confirm the toggle stays on." A successful click alone does not prove persistence.

Wait for an observable result with a deadline instead of a fixed sleep, and save failure output before cleanup. After a fix, rerun the affected checks against the new candidate and label before and after evidence so reviewers can tell which revision produced each file.

## Capture evidence appropriate to the change

<a id="terminal-contracts" />
<a id="reproduce-stage-skill-terminal-evidence" />

### Terminal changes

Use Herdr when requested and running inside a Herdr-managed pane. Otherwise use a dedicated tmux session on macOS or Linux, or native psmux on Windows. See [Terminal automation with Herdr](/computer-use#terminal-automation-with-herdr) for setup and commands.

Set the relevant terminal size, send the real keystrokes, wait for a fresh result, and capture the pane before leaving the alternate screen. For a shortcut change, capture the selection before and after pressing it and confirm which item opened. An idle indicator or successful `send-keys` call is not proof. A browser rendering terminal text is not TUI evidence, and WSL is not native Windows terminal coverage.

### Browser changes

Use [agent-browser](/computer-use#browser-automation-with-agent-browser) for supported browsers, Electron apps, and other CDP targets. Inspect a fresh snapshot, perform the action, and verify the resulting DOM or saved state.

Keep a screenshot for layout checks or a short recording for multi-step motion. For example, in a dedicated session named `pr-check`:

```sh
agent-browser --session pr-check snapshot > after.yaml
agent-browser --session pr-check screenshot after.png
```

For motion, run `agent-browser --session pr-check record start flow.webm` before the steps and `agent-browser --session pr-check record stop` afterward, then open the saved file to confirm the final state is visible.

#### Mobile Safari

For Mobile Safari, run `agent-browser -p ios` against a real iOS Simulator (`set device` in Chromium changes the viewport, not the WebKit engine), and record with `xcrun simctl`. For a native mobile app, use device or emulator tooling such as XCUITest or UI Automator instead of browser captures.

<a id="desktop-safety" />

### Native desktop changes

Use [agent-desktop](/computer-use#desktop-automation-with-agent-desktop) in a dedicated graphical session after verifying `agent-desktop status`. Observe the app, act on a ref from that snapshot, wait for the intended postcondition with a timeout, and read it back.

Keep the snapshot, action, and wait JSON together with before and after screenshots. A partial accessibility tree (`data.complete: false`) requires another observation before acting. If a click or save times out, inspect the app and saved files before retrying because the action may already have landed. Always let the human user grant OS consent dialogs directly.

<a id="use-evidence-in-a-workflow" />

## Verify delegated work

When delegating verification to [subagents](/subagents), give them the same scenario and acceptance criteria you plan to check in the parent session. Ask for the tested revision, commands, observed results, and artifact paths.

After a child completes, inspect its evidence or rerun key checks from the parent session through codemode. A launch receipt, a filename, or agreement between reviewers does not replace the actual check result. Pass real failures into a bounded repair round and verify the new candidate before accepting it. Approving a change stays separate from permission to publish it.

### Switching between delegated and direct execution

Apply the same verification rules when working directly in the parent session. If you switch from delegated work to direct execution, reconcile running children, modified files, and any in-flight side effects before repeating a command.

## When a tool or environment is unavailable

Check installed tools and cached runtimes first, and install missing dependencies only when permitted. When setup is blocked, note the missing prerequisite, the exact error or restriction, the narrower checks that ran, and what still needs the target environment.

For example, a passing headless-browser test does not verify a native file dialog. Report skipped or simulated scenarios clearly instead of counting them as real-platform passes.

### qlty setup and fallback

When a repository uses `qlty`, keep its existing `.qlty/qlty.toml` intact and run the relevant `qlty check`. Avoid adding a competing formatter or initializing config during a read-only review. If config changes are in scope and no config exists, run `qlty init --no` and review the output, or follow the bundled `qlty` skill's manual setup guide.

Cached plugins and built-in metrics such as `qlty metrics` work offline, while uncached plugins may need downloads. Valid TOML does not prove a linter ran. Record which checks actually executed, continue with available repository checks, and flag any required check that stayed blocked.

## Include evidence in a PR

State the tested revision and environment, actions taken, expected and actual outcomes, checks run, and coverage limits. Place each image or clip next to the scenario it demonstrates, and include reproduction steps alongside attached media. Label local-only artifacts clearly because reviewers cannot open paths on your machine.

### Native GitHub media

Upload evidence only to an authorized repository after reviewing and redacting personal data, credentials, private source, and unrelated windows. Local capture does not authorize publication.

On a supported GitHub host, check `gh --version` and `gh pr create --help` for [attachment support](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) (`gh` 2.99.0 or newer). In a POSIX shell:

```sh
gh pr create --title "Fix settings save" --body-file body.md \
  --attach 'before.png#Settings before saving' \
  --attach 'after.png#Settings after reopening' \
  --attach flow.webm
```

Use a single line or PowerShell continuation syntax on Windows. To add evidence to an existing pull request, use `gh pr edit` or an authorized `gh pr comment` with `--body-file` and `--attach`. The `#text` suffix sets image alt text; omit it for video.

Read back the pull request or comment to confirm the hosted links render before reporting an upload. If the CLI, host, permissions, or file size prevent attachment, keep the artifacts local, explain the limitation, and offer the normal manual upload path instead of uploading to an unrelated service.
