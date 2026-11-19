---
title: "Verification and evidence"
description: "Choose checks that exercise the change, reproduce a result, and show reviewers what passed and what remains unverified."
---

# Verification and evidence

Verify the behavior that changed. A test and its output may be enough for a library fix. For a change to what someone sees or does, also exercise that interaction. A recording helps when motion or timing matters; it does not replace a required test.

<a id="select-the-verification-environment" />

## Choose checks that answer the question

Start with the project's required tests, build, typecheck, and lint. Then ask what could still be wrong *if all of those pass*:

| Change | Useful check | Evidence to keep |
| --- | --- | --- |
| API, CLI, or library | Run the affected entry point with a representative input and a failing or boundary case. | Exact command, exit status, expected and actual output. |
| Terminal interface | Send the actual keys in a real terminal at the affected size. | Before and after pane contents, focus or cursor state if relevant, exit status. |
| Browser or desktop UI | Exercise the visible action and verify the resulting state, preferably after reopening or reloading. | Snapshot or accessibility result, screenshot, and the checked postcondition. |
| Documentation | Follow the directions from the stated starting point. Run the example and check navigation, links, and anchors. | Which example ran, the result, and any prerequisites. |

### Reuse past verification

Past sessions, commits, and PRs can suggest useful checks. They don't prove the current revision works. Use [Computer use](/computer-use) for tool setup, operating-system permissions, and coverage limits.

## Define a reproducible scenario

Record the candidate (commit or artifact, including local changes), environment (OS, app version, terminal dimensions or browser), and starting fixture. Use non-production data and a dedicated session. Specify the action and what you expect to observe **before** running it. For example: “With notifications off, switch them on, press Save, reopen Settings, and check that the toggle is still on.” A successful click is not proof of persistence.

Wait for an observable result with a deadline, not a fixed sleep. Save failure output before cleanup. After a repair, rerun the affected checks against the new candidate; label before and after evidence so a reviewer can tell which revision produced it.

## Capture evidence appropriate to the change

<a id="terminal-contracts" />
<a id="reproduce-stage-skill-terminal-evidence" />

### Terminal changes

Use Herdr when explicitly requested and running in a Herdr-managed pane. Otherwise use a dedicated tmux session, or native psmux on Windows. Set the relevant size, send the input, wait for a fresh result, and capture the pane before leaving the alternate screen. For example, when testing a shortcut, capture the selection before and after pressing it and check which item actually opened. An idle indicator or successful `send-keys` is not the result. A browser showing terminal text is not TUI evidence; WSL is not native Windows terminal coverage. See [terminal automation](/computer-use#terminal-automation-with-herdr).

### Browser changes

Use [agent-browser](/computer-use#browser-automation-with-agent-browser) for a supported browser or CDP app. Inspect a fresh snapshot, perform the action, and assert the resulting DOM or saved state. Keep a screenshot for layout or a short recording for a multi-step interaction. For a session named `pr-check` that you own:

```sh
agent-browser --session pr-check snapshot > after.yaml
agent-browser --session pr-check screenshot after.png
```

For motion, start `agent-browser --session pr-check record start flow.webm` before the actions and run `agent-browser --session pr-check record stop` afterward. Open the saved file and check that the final state is visible.

#### Mobile Safari

For Mobile Safari use a real iOS Simulator (`agent-browser -p ios`); `set device` in Chromium changes the viewport, not the browser engine. Use `simctl` for a simulator recording. For a native mobile app, use tooling for the device or emulator (such as XCUITest or UI Automator), not a browser capture.

<a id="desktop-safety" />

### Native desktop changes

Use the [agent-desktop skill](/computer-use#desktop-automation-with-agent-desktop) in a dedicated graphical session. Check `agent-desktop status` first. Observe the app, act on a ref from that snapshot, wait for the intended postcondition with a timeout, then read it back. Keep the snapshot, action, and wait JSON and before/after screenshots. A partial accessibility tree (`data.complete: false`) needs another observation. If a click or save times out, inspect the app and any saved file before retrying: the action may already have landed. Never drive an OS consent dialog on the user's behalf.

<a id="use-evidence-in-a-workflow" />

## Verify delegated work

Give subagents the same scenario and acceptance criteria that the parent will use. Ask for the tested revision, commands, observed results, and artifact paths. After a completion notice, the parent inspects that evidence or reruns the check through codemode. The receipt for a launch, a filename, and agreement between reviewers are not substitutes for the result. Feed an actual failure into a bounded repair attempt; verify the new candidate before accepting it. Approval of a change is separate from permission to publish it.

### Execution mode

Use the same checks when working inline. If a user switches from delegated work to direct execution, reconcile the children, files, and any in-flight side effects before repeating a command.

## When a tool or environment is unavailable

Check installed tools and cached runtimes first. Install missing dependencies only when permitted. If setup is blocked, record the missing prerequisite, the error or restriction, the narrower checks that actually ran, and what still needs the target environment. For example, a passing test in a headless browser does not verify a native file dialog. Do not mark a skipped or simulated scenario as a real-platform pass.

### qlty setup and fallback

If `qlty` is used, preserve the repository's existing `.qlty/qlty.toml` and run the relevant `qlty check`. Don't add a competing formatter or initialize configuration for a read-only review. If configuration changes are in scope and no config exists, use `qlty init --no` and review what it generated, or use the bundled `qlty` skill's manual configuration guide. Cached plugins or built-in metrics such as `qlty metrics` can work offline; uncached plugins may need downloads. Valid TOML is not evidence that a linter ran. Report what actually executed, continue available repository checks, and flag any required check still blocked.

## Include evidence in a PR

State the revision and environment, actions taken, expected and actual outcome, checks, and coverage limits. Put each image or clip next to the scenario it demonstrates. Give reproduction steps even when media is attached. Label local-only artifacts as local; reviewers cannot open a path on your machine.

### Native GitHub media

Only upload to an authorized repository. Review and redact personal data, credentials, private source, and unrelated windows first. Local capture does not authorize publication. On a supported GitHub host, check `gh --version` and `gh pr create --help` for [attachment support](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) (`gh` 2.99.0 or newer). For example, in a POSIX shell:

```sh
gh pr create --title "Fix settings save" --body-file body.md \
  --attach 'before.png#Settings before saving' \
  --attach 'after.png#Settings after reopening' \
  --attach flow.webm
```

Use a single line or PowerShell continuation syntax on Windows. To add evidence later, use `gh pr edit` or an authorized `gh pr comment` with `--body-file` and `--attach`. `#…` supplies image alt text; omit it for video. Read back the PR or comment and confirm that the hosted links work before reporting an upload. If the CLI, host, permissions, or file size prevent attachment, keep the artifacts local, state the limitation, and offer the normal manual attachment path. Do not upload to an unrelated service.
