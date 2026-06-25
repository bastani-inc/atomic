# First-Run Onboarding: Normal-Session Workflow Handoff

- **Date:** 2026-06-20
- **Status:** Implemented direction after review
- **Area:** `packages/coding-agent` interactive TUI (first-run experience)
- **Pattern:** Capture-and-handoff (capture the user's first work item, hand it to the normal coding-agent session with workflow-routing guidance, and then let the regular agent/workflow paths take over)

## Summary

A first-time Atomic user previously landed on a blank chat. The startup screen showed
the banner, version, model, and cwd, then an empty input box with no guidance. On a
*fresh install* even the changelog is suppressed, so nothing communicated the product's
core value: Atomic can run agent loops as workflows.

This spec replaces that blank slate with a single, opinionated first action. On a true
fresh install, Atomic asks the user to paste a ticket description, GitHub issue, path
to a spec, or task prompt. When the user submits that seed, onboarding does **not** run
a separate internal scope-probe subsystem or launch workflows directly. Instead, it
wraps the seed in a normal-session handoff prompt that tells the coding agent to make a
quick scope-routing pass using Atomic's existing workflow guidance, choose `goal` for
small focused work or `ralph` for larger/cross-cutting work, start the selected
workflow with the original seed, and then continue normally.

The routing rule is intentionally easy to teach and derives from the same workflow
guidance Atomic already injects into the agent system prompt
(`packages/workflows/src/extension/workflow-prompts.ts`):

- Prefer `goal` for small fixes / quick fixes.
- Prefer `ralph` for non-trivial tasks, especially work estimated at **over ~2k lines
  of changed implementation/test/docs code**.
- Use estimated changed lines and the number of unique files/touched areas as scoping
  signals.

Onboarding itself only owns the first-run CTA, `/chat` escape hatch, seed capture,
pre-login in-memory stashing, and handoff to the regular session. The selected
workflow or regular agent path owns research, execution, validation, review, status,
and completion reporting.

## Goals

- Replace the fresh-install blank slate with a clear value statement and one action.
- Teach that Atomic can run observable workflows, not just chat.
- Let first-time users paste real work immediately without learning workflow syntax.
- Hand the first ready ticket/spec/task to the normal coding-agent session with clear
  `goal` vs. `ralph` routing guidance.
- Preserve ordinary slash-command behavior during onboarding.
- Provide `/chat` as an explicit escape hatch for users who want a normal chat first.
- Avoid a separate onboarding-only probe, workflow launcher, completion UI, or auth
  subsystem.

## Non-goals

- No internal onboarding scope probe, model-backed assessment, or durable research
  artifact.
- No direct workflow launch from onboarding; the normal agent/session flow receives the
  handoff prompt and decides what to do next.
- No full implementation planning in the onboarding layer.
- No clarifying questions in the onboarding layer; the normal agent/workflow can ask
  questions when needed.
- No auth handling beyond the CTA reminder and in-memory stashing of a seed until the
  configured model is ready for handoff.
- No completion UI in onboarding; workflows already report progress and completion.
- No auto-mounting of the workflow graph overlay.
- No new "loops for all" tagline or branding copy.

## Background: current behavior anchors

- Startup identity (banner + version + provider/model + cwd):
  `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
- Fresh-install detection and startup state: `interactive-startup.ts`.
- First-run onboarding copy, path seed helpers, seed stashing, and handoff prompt:
  `packages/coding-agent/src/modes/interactive/interactive-onboarding.ts`.
- Input handling for `/chat`, slash commands, absolute path seeds, and normal seeds:
  `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts`.
- Auth completion resumes a pending in-memory seed:
  `packages/coding-agent/src/modes/interactive/interactive-auth-login.ts`.
- Onboarding settings mirror the existing settings accessor pattern:
  `settings-manager-basic-accessors.ts` and `settings-types.ts`.
- Workflow launch/status UX already exists in the workflow extension; onboarding should
  not duplicate it.

## UX flow

### 1. Startup screen (fresh install only)

```txt
        [ ∀ banner ]   Atomic v0.x
                       (anthropic) claude-opus-4.8 · ~/acme/app

  ───────────────────────────────────────────────────────────
  Atomic runs agent loops as workflows you can watch and trust:
  implement a ticket, research a codebase, design a UI, or build
  your own loop.

  Paste a ticket description, GitHub issue, path to a spec, or task prompt to start.
  /chat to chat normally · /atomic for guides
  If you have not logged in yet, first run /login.
  ───────────────────────────────────────────────────────────
```

The existing Atomic editor remains the only input box. Its placeholder while empty is:
`Paste a ticket, issue, path to a spec, or task prompt…`

### 2. User either pastes work or chooses normal chat

While onboarding is active, the first substantive non-slash input is treated as a work
seed. Users who want ordinary chat instead use `/chat`.

Behavior:

- `/chat <message>` removes the CTA, marks onboarding complete, prints the normal-chat
  transition copy, then sends `<message>` through the normal chat path.
- `/chat` with no message removes the CTA, marks onboarding complete, prints the same
  transition copy, restores the normal editor placeholder, and waits.
- Other slash commands (`/login`, `/model`, `/atomic`, etc.) pass through untouched and
  do not mark onboarding complete.
- Existing absolute filesystem paths, including path-like inputs that start with `/`,
  are treated as seeds rather than slash commands. Cwd-local path checks use realpath
  containment for safety; outside-cwd absolute paths can still be handed off as raw
  seed text, but onboarding does not read them.
- Empty/trivial input is ignored.

Suggested `/chat` transition copy:

```txt
You're in a normal coding-agent session now. Atomic can chat and edit like other
coding agents, but it also runs loops and workflows. Ask Atomic to build any loop,
or run a built-in workflow like `goal` for small focused changes or `ralph` for
larger, cross-cutting work. Run `/workflow list` to see built-ins, and use `/atomic`
for help running or building your own loops and workflows.
```

### 3. Atomic hands the seed to the normal session

For the first ready seed, Atomic creates a handoff prompt like:

~~~txt
First-run onboarding handoff: continue as a normal Atomic coding-agent session.

Original task seed:
```text
<raw user seed>
```

Perform a quick scope-routing pass before acting. Use the existing Atomic workflow guidance:
choose `goal` for small focused fixes or quick fixes; choose `ralph` for non-trivial,
broad, cross-cutting, or around-2K+-changed-line work. Start the selected workflow with
the original seed, then continue normally in this session. Slash commands should behave
like normal coding-agent slash commands from here on.
~~~

The raw seed is fenced with enough backticks to preserve arbitrary user text. Atomic
then sends this prompt through the same normal input callback/pending-input path used
by regular chat, shows `Handing your task to the normal coding-agent session.`, and
marks onboarding complete.

### 4. Normal agent/workflow behavior takes over

After handoff, onboarding never speaks again. The normal coding-agent session can run a
quick scope-routing pass, start `goal` or `ralph`, continue in chat, ask clarifying
questions, surface auth/model errors, show workflow status, or connect the workflow
graph using the existing runtime behavior.

## Onboarding state model

Atomic distinguishes these states:

1. **Not onboarded:** `onboardedVersion` is unset. On a true fresh install with no
   initial messages, startup records `firstRunOnboardingStartedVersion`, shows the CTA,
   sets the onboarding placeholder, and enables first-seed interception.
2. **Onboarding in progress:** The same fresh session is still waiting for either a
   substantive seed or `/chat`. Slash commands can pass through without ending
   onboarding, so users can run `/login`, `/model`, or `/atomic` and then return to the
   CTA.
3. **Pending seed before login/model readiness:** If the first seed arrives before the
   selected model is ready for handoff, Atomic stores only the latest seed in memory,
   prompts the user to run `/login`, and resumes the handoff after provider
   authentication completes. This seed is not persisted to settings or disk.
4. **Already onboarded:** `onboardedVersion` is set. Atomic never shows this first-run
   CTA or intercepts the first message again unless a future release intentionally
   changes the onboarding version policy.

The onboarding flag is a product-experience flag, not a changelog flag. It is stored
separately from `lastChangelogVersion`. `firstRunOnboardingStartedVersion` keeps
fresh-install onboarding separate from changelog state and allows copied settings to
re-arm onboarding by deleting the onboarding markers.

## Technical design

1. **Settings flags.** Add `firstRunOnboardingStartedVersion` and `onboardedVersion` to
   settings with typed accessors. Set `onboardedVersion` only after `/chat` or a
   successful handoff to the normal session.
2. **First-run screen.** When onboarding is active, render the value statement + CTA
   beneath the startup identity and set the onboarding placeholder.
3. **Input handling.** While onboarding is active:
   - `/chat` exits onboarding and optionally sends the trailing message as normal chat.
   - Other slash commands pass through and keep onboarding active.
   - Existing absolute paths can be submitted as seeds, even when they start with `/`.
   - Non-slash substantive input is submitted as a seed.
4. **Readiness and stashing.** Before handoff, check whether the current model appears
   ready. If not, stash the latest seed in memory and let the existing login/model UX
   run. After provider authentication completes, resume the pending seed if onboarding
   is still active and the model is ready.
5. **Handoff prompt.** Build a normal-session prompt that includes the exact raw seed
   and the durable `goal`/`ralph` guidance. Use a dynamic Markdown fence so embedded
   backticks do not corrupt the seed.
6. **No probe subsystem.** Do not keep dead `OnboardingRoutingAssessment`,
   scope-probe, follow-up probe, direct workflow-launch, or probe-only test code. If a
   future design wants onboarding-owned routing again, it should be reintroduced as a
   deliberate feature with wired production callers.
7. **Standard runtime ownership.** After handoff, normal coding-agent/workflow behavior
   owns scope decisions, workflow launch/status/connect UI, auth errors, validation,
   and completion reporting.

## Edge cases

- **Slash command as first input:** handled normally; onboarding stays available until a
  seed is submitted or the user enters normal chat with `/chat`.
- **Logged-out first run:** the CTA says to run `/login`. If a seed is submitted first,
  Atomic stores it in memory and resumes after successful provider authentication.
  Onboarding does not write the seed to disk or replace normal auth errors.
- **User wants ordinary chat:** `/chat` or `/chat <message>` marks onboarding complete,
  removes the CTA, restores the normal placeholder, and continues normally.
- **Empty/trivial input:** ignored.
- **Handoff failure:** show the error via existing interactive error handling, restore
  the seed in the editor, and do not mark onboarding complete.
- **Resumed/non-fresh sessions:** onboarding does not render. If a resume command makes
  the current onboarding session ineligible, clear the onboarding UI without setting
  `onboardedVersion`.
- **Initial messages:** startup should not activate onboarding for `initialMessage` or
  non-empty `initialMessages`, but should record the started marker so a later true
  fresh interactive launch can still show the CTA if onboarding was not completed.
- **`NO_COLOR` / narrow terminal:** copy must degrade to plain text and respect the
  existing sidebar-collapse width rules.

## Acceptance criteria

- On a true fresh install, the startup screen shows the value statement, paste-a-task
  CTA, login hint, `/chat` and `/atomic` hints, and onboarding placeholder.
- During onboarding, the first substantive non-slash, non-`/chat` input is treated as a
  seed and handed to the normal coding-agent session with `goal`/`ralph` routing
  guidance.
- The handoff prompt preserves the original raw seed exactly, including multiline text
  and backticks.
- `/chat <message>` exits onboarding, prints the normal-chat transition copy, and sends
  `<message>` through the regular chat path; `/chat` exits onboarding and waits.
- `/atomic`, `/login`, `/model`, and other slash commands entered first are not treated
  as tickets and do not dismiss onboarding.
- Existing absolute path seeds can be handed off even when they start with `/`; cwd path
  detection remains symlink-safe and does not read outside-cwd files.
- Seeds submitted before login/model readiness are stashed in memory only and resumed
  after authentication completes.
- Onboarding renders at most once after completion, guarded by `onboardedVersion`.
- Resumed sessions, non-empty sessions, and initial-message launches do not show the
  first-run CTA.
- No dead internal scope-probe/routing-assessment code or probe-only tests remain.
- User-facing docs and changelog describe normal-session handoff, not a separate
  onboarding-owned scope probe or direct workflow launch.
