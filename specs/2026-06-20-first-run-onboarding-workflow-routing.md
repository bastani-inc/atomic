# First-Run Onboarding: Scope-to-Workflow Routing

- **Date:** 2026-06-20
- **Status:** Draft for implementation
- **Area:** `packages/coding-agent` interactive TUI (first-run experience)
- **Pattern:** Classify-and-act (capture the user's work item, do lightweight scope research, route to `goal` or `ralph`, then rely on the existing workflow launch/status UX)

## Summary

A first-time Atomic user currently lands on a blank chat. The startup screen shows
the banner, version, model, and cwd, then an empty input box with no guidance. On a
*fresh install* even the changelog is suppressed, so nothing communicates the product's
core value (workflows) or what to do next.

This spec replaces that blank slate with a single, opinionated first action: the user
pastes a ticket description / GitHub issue / path to a spec / task prompt, Atomic does a lightweight scope assessment,
routes the request to either `goal` or `ralph`, starts the selected workflow through
the existing workflow launch path, and explains the decision in simple terms. The
scope assessment is deliberately brief: it only gathers enough signal to choose the
runner, then avoids duplicating the deeper research/refinement that `goal` or `ralph`
will perform after launch.

The routing rule is intentionally easy to teach and must be derived from the
same workflow guidance Atomic already injects into the agent system prompt
(`packages/workflows/src/extension/workflow-prompts.ts`), rather than from a
separate onboarding-only taxonomy. That guidance defines the durable split:

- Prefer `goal` for small fixes / quick fixes.
- Prefer `ralph` for non-trivial tasks, especially work estimated at **over
  ~2k lines of changed implementation/test/docs code**.
- Use estimated changed lines and the number of unique files/touched areas as
  the scoping signals for that decision.

The estimate is a first-pass scoping heuristic, not a guarantee. The selected workflow
still owns the real research, execution, refinement, validation, and completion
reporting. When `ralph` is selected, onboarding should leave `max_loops` at the
workflow default; Ralph already has its own review loop and can complete early when
reviewers approve.

## Goals

- Replace the fresh-install blank slate with a clear value statement and one action.
- Get a first-time user from "paste my work" to "the right workflow is running on it" in one step.
- Do enough lightweight research to explain whether the request looks small/bounded or large/cross-cutting, without duplicating the selected workflow's later research.
- Route small fixes / quick fixes to `goal` and non-trivial larger/cross-cutting work to `ralph`.
- When routing to `ralph`, leave `max_loops` at its default rather than tuning it in onboarding.
- Teach the user the durable distinction:
  - `goal` is for smaller, focused changes.
  - `ralph` is for larger, research-heavy, cross-cutting changes.
- Teach the real, durable commands (`/workflow connect`, `/workflow status`, `/atomic`).

## Non-goals

- No full implementation planning in the onboarding intake.
- No deep codebase research artifact in the onboarding intake; keep this assessment short and cheap.
- No duplicated implementation research. Onboarding should stop once it can make a reasonable routing decision and let `goal`/`ralph` do the deeper work.
- No clarifying questions in the intake. `goal`/`ralph` handle HIL prompts in their graphs.
- No auth handling in onboarding beyond the CTA reminder. Do not inspect login state, add an auth preflight, branch on logged-in/logged-out state, or duplicate auth-failure UX; missing/expired auth should flow through the existing coding-agent prompt/workflow error path.
- No completion UI in the intake. `goal`/`ralph` already report completion + receipts.
- No auto-mounting of the workflow graph overlay (the overlay is opt-in by design).
- No new "loops for all" tagline or branding copy.

## Background: current behavior (code anchors)

- Startup identity (banner + version + provider/model + cwd):
  `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  → `getStartupIdentityText()` (~line 1186), `renderAtomicAnsiBanner()` in
  `components/atomic-banner.ts`.
- Fresh-install detection currently does nothing user-facing:
  `getChangelogForDisplay()` (~line 1074). The `!lastVersion` branch records the
  version + install telemetry and returns `undefined`. **This is the hook point.**
- Version persistence pattern to mirror for an onboarding flag:
  `settings-manager.ts` → `getLastChangelogVersion()` / `setLastChangelogVersion()`.
- Default editor placeholder is unset; `CustomEditor.setPlaceholder()` exists in
  `components/custom-editor.ts`.
- Existing pull-based guide: `core/atomic-guide-command.ts` (`/atomic`).
- Builtin workflow inputs:
  - `goal` → `objective`
  - `ralph` → `prompt`
- Latest `goal` and `ralph` behavior: both workflows already run their own
  `prompt-refinement` stage after launch. Onboarding should pass the raw user request;
  the selected workflow handles prompt refinement internally.
- The authoritative `goal` vs. `ralph` routing guidance lives in the workflow
  extension's injected system-prompt guidance
  (`packages/workflows/src/extension/workflow-prompts.ts`): use `goal` for small
  fixes / quick fixes, and use `ralph` for non-trivial work, especially when the
  estimated diff is over ~2k LoC. The onboarding scope assessor prompt should
  reuse that system-prompt language as the source of truth rather than inventing
  a separate mental model. `docs/workflow-playbook.md` and
  `packages/coding-agent/docs/workflows.md` are supporting documentation only and
  should stay consistent with the system prompt.
- Workflow launch/status UX already exists: workflow runs are background tasks, status
  and connect affordances are handled by the workflow extension, and the graph overlay
  remains opt-in via `/workflow connect <id>` or `F2`. Onboarding should not duplicate
  or fork this handoff behavior.
- Existing auth/login guidance already lives in the coding-agent runtime:
  `core/auth-guidance.ts` formats `No model selected`, `No API key found`, and
  `Use /login...` messages; `core/agent-session-prompt.ts` validates the selected
  model/provider before a prompt and throws those messages for missing auth; and
  `modes/interactive/interactive-startup.ts` catches prompt errors and renders them
  with `showError()`. `/login` itself is already handled by
  `modes/interactive/interactive-input-handling.ts` and
  `interactive-auth-login.ts`. Onboarding should simply let these existing paths run;
  it should not add auth-specific checks, catches, retries, state transitions, or
  bespoke "please log in" failure copy.

## UX flow

### 1. Startup screen (fresh install only)

```
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

The onboarding CTA defines the mode: while onboarding is active, the first substantive
non-slash input is treated as a workflow seed. Users who want a normal coding-agent
session instead use the explicit `/chat` escape hatch.

Behavior:

- `/chat <message>` removes the CTA, marks onboarding complete, prints the normal-chat
  transition copy, then sends `<message>` through the normal chat path.
- `/chat` with no message removes the CTA, marks onboarding complete, prints the same
  transition copy, restores the normal editor placeholder, and waits for the next
  message.
- Other slash commands (`/login`, `/model`, `/atomic`, etc.) pass through untouched and
  do not mark onboarding complete.
- Any other substantive input becomes the workflow seed. It may include a URL; no
  separate fetch step is required in the onboarding UI unless the lightweight scope
  assessor already supports it.

Suggested `/chat` transition copy:

```txt
You're in a normal coding-agent session now. Atomic can chat and edit like other
coding agents, but it also runs loops and workflows. Ask Atomic to build any loop,
or run a built-in workflow like `goal` for small focused changes or `ralph` for
larger, cross-cutting work. Run `/workflow list` to see built-ins, and use `/atomic`
for help running or building your own loops and workflows.
```

### 3. Atomic performs lightweight workflow routing

Before the probe starts, Atomic should tell the user what is happening:

```txt
Doing a quick read-only scope check so I can choose the right workflow.
I'll read the ticket/spec and look up the likely code areas, but I won't do the full
implementation research here. The selected workflow will handle deeper research after
it starts.
```

Atomic then runs a short, read-only scope probe before launching a workflow. The probe
is modeled on the first step of `research-codebase` — read directly mentioned files and
use codebase discovery to understand where the work likely lands — but it is not the
full `/skill:research-codebase` flow. It does not ask compatibility questions, spawn a
large parallel research plan, or write a durable research report. Onboarding mode
already treats the first substantive non-slash, non-`/chat` input as the workflow seed.
If that seed is a path to a spec, Atomic should read the spec; otherwise it should use
the pasted task/issue text. From that seed, it should do a bounded subagent-backed
scope pass and make its best judgment about likely scope. Use the same grounding roles
Atomic already exposes: `codebase-locator` to find likely files/areas,
`codebase-analyzer` to understand the most relevant current flows,
`codebase-pattern-finder` when the request depends on existing conventions or repeated
patterns, and `codebase-online-researcher` only when an external library/API/version is
central to judging scope. The assessment should identify likely touched areas and
estimate rough change size only enough to choose `goal` or `ralph`.

Time budget: optimize for a fast first-run experience. The expected duration should be
about 1–3 minutes on a typical repo, with an absolute 10-minute cap. If the probe hits
its cap or cannot gather more useful signal cheaply, it should route from partial
findings rather than continue researching.

The assessment output should be structured:

```ts
type OnboardingRoutingAssessment = {
  workflow: "goal" | "ralph";
  estimatedChangedLines: number | null;
  estimatedUniqueFiles: number | null;
  touchedAreas: string[];
  reason: string;
};
```

Routing rule, restating the existing system-prompt guidance for onboarding:

- Small fixes / quick fixes with `estimatedChangedLines < 2000` and localized/bounded
  scope → `goal`.
- Non-trivial tasks with `estimatedChangedLines >= 2000`, many unique files, many
  touched areas, migration/refactor shape, or uncertain broad scope → `ralph`.

Do not introduce additional onboarding-only categories or thresholds. If the
system-prompt guidance changes, onboarding should follow that updated guidance.

If the assessment cannot produce a confident line estimate, choose based on shape:
localized single-issue work defaults to `goal`; broad/cross-cutting/multi-package work
defaults to `ralph`.

When selecting `ralph`, do not tune `max_loops` in onboarding. Use Ralph's default
loop budget and let Ralph's own approval/early-exit behavior stop the run when the
work is complete.

### 4. Atomic explains the decision simply

If `goal` is selected:

```
  ✓ Decision: run goal

    This looks like a smaller, focused change: it appears localized and
    likely under about 2k lines. goal is built for bounded work like this.

    For larger changes — broad refactors, migrations, or work that spans
    many files/packages — use ralph. Ralph does deeper research, delegates
    through sub-agents, reviews, and iterates.

  Starting goal now.
```

If `ralph` is selected:

```
  ✓ Decision: run ralph

    This looks like a larger or cross-cutting change: it may touch many
    areas or require around 2k+ lines of implementation, tests, or docs.
    Ralph is built for bigger work that needs research, delegation,
    review, and iteration.

    For smaller, focused fixes or features, use goal. goal is faster and
    optimized for bounded work.

  Starting ralph now.
```

The explanation should not pretend the estimate is exact. Use phrases like "looks
like," "appears," and "about 2k lines" unless the assessor measured something concrete.

### 5. Existing workflow launch/status behavior takes over

After the decision copy, onboarding starts the chosen workflow through the existing
workflow launch path and then gets out of the way. The workflow extension already owns
background-run status, connect/watch affordances, graph overlay behavior, and final
completion reporting. Onboarding should not implement a separate handoff UI; it should
reuse whatever the standard workflow launch path already prints or renders.

After this, onboarding never speaks again; `goal`/`ralph` own prompt refinement,
execution, validation, review, and completion.

## Onboarding state model

Atomic must distinguish three states:

1. **Not onboarded:** `onboardedVersion` is unset. Show the first-run onboarding CTA,
   use the onboarding placeholder, and enable the one-time scope-to-workflow routing
   behavior for the first non-slash-command message.
2. **Onboarding in progress:** the user is still in the same first-run session and has
   not submitted a real work item yet. Slash commands can pass through without ending
   onboarding, so a user can run `/login`, `/model`, or `/atomic` and then return to
   the onboarding CTA and placeholder. The CTA remains the active empty-state guidance
   until the user either submits a substantive non-slash, non-`/chat` input as the
   workflow seed, or explicitly chooses normal chat with `/chat`. Choosing `/chat`
   removes the CTA, sets `onboardedVersion`, prints the normal-chat transition copy,
   and then continues normally.
3. **Already onboarded:** `onboardedVersion` is set. Never show this first-run CTA or
   intercept the first message again. Startup should behave like normal Atomic startup.

The onboarding flag is a product-experience flag, not a changelog flag. It should be
stored separately from `lastChangelogVersion` so future changelog behavior does not
accidentally reset onboarding. If the onboarding copy or flow changes in a future
release, the team can decide whether to compare `onboardedVersion` against the current
version and re-show materially new onboarding, but this spec's default is one-time:
once set, do not show again.

## Technical design

1. **Onboarding state flag.** Add `onboardedVersion` to settings (mirror the
   `lastChangelogVersion` get/set pattern in `settings-manager.ts`, but keep it as a
   separate setting). The first-run onboarding renders only when `onboardedVersion` is
   unset. Set it only after the user submits a workflow seed or explicitly enters
   normal chat with `/chat`; do not set it merely because the user ran a slash command
   such as `/login`, `/model`, or `/atomic`.

2. **First-run screen.** In `interactive-mode.ts`, when onboarding is active, render
   the value statement + CTA block beneath the existing startup identity, and set the
   default editor placeholder to `Paste a ticket, issue, path to a spec, or task prompt…` via
   `CustomEditor.setPlaceholder()`.

3. **Onboarding input handling.** While onboarding is active, the first submitted
   non-command work item goes through the lightweight routing assessment:
   - Slash commands (`/atomic`, `/login`, `/model`, etc.) pass through untouched and do
     not mark onboarding complete. After the slash command finishes, onboarding remains
     active: the editor returns to the onboarding placeholder and the first-run CTA is
     still the guidance for the next non-slash input.
   - `/chat <message>` is the explicit normal-chat escape hatch: remove the CTA, set
     `onboardedVersion`, print the normal-chat transition copy, then continue with
     `<message>` through the normal chat path.
   - `/chat` with no message removes the CTA, sets `onboardedVersion`, prints the
     normal-chat transition copy, restores normal editor behavior, and waits for the
     next user message.
   - Empty/trivial input is ignored and keeps the onboarding placeholder.
   - For the first non-slash substantive input, assume the input is the user's pasted
     task/ticket/issue/path-to-spec. Print the quick scope-check notice, then run the
     lightweight model-backed routing assessment only to choose `goal` or `ralph`.
   - Use the assessment's routing result → route to `goal` or `ralph` → print the
     simple explanation → start the chosen workflow through the existing workflow
     launch path.
   - Do not add onboarding-specific auth logic. If the routing assessment, normal chat
     continuation, or workflow launch encounters missing/expired auth, no selected
     model, or no configured API key, let the existing coding-agent prompt/workflow
     error handling render its normal `/login` guidance. Do not replace those messages
     with custom onboarding copy or special-case onboarding state.
   - Set `onboardedVersion` after the selected workflow starts successfully, or after
     the user explicitly chooses normal chat with `/chat`. Failed prompts/launches,
     including ordinary auth/model failures surfaced by the existing runtime, should
     not mark onboarding complete.

4. **Lightweight routing/scope assessment.** Add a small read-only assessment step
   before workflow launch. This should be a `research-codebase`-inspired scope probe,
   not a literal invocation of `/skill:research-codebase`: read the pasted task/issue
   text, read the referenced spec when the input is a spec path, then run a bounded
   subagent-backed pass to identify likely touched areas and make a best-effort scope
   call. Recommended quick grounding:
   - `codebase-locator` first, to identify likely files, packages, docs, tests, and
     entrypoints.
   - `codebase-analyzer` on the most relevant area or two, to understand current flow
     and estimate change breadth.
   - `codebase-pattern-finder` only when existing conventions, examples, repeated
     patterns, or migration shape affect scope.
   - `codebase-online-researcher` only when external API/library/version behavior is
     central to the estimate.

   Runtime budget and anti-duplication guardrails:
   - Expected runtime: about 1–3 minutes on a typical repo.
   - Absolute cap: 10 minutes. On timeout, route from partial findings with an
     explicit low-confidence reason rather than continuing research.
   - Keep fan-out small: start with `codebase-locator`; add at most the targeted
     analyzer/pattern/online passes needed to choose a runner.
   - Do not produce implementation plans, durable research docs, or a full list of
     required changes. The selected workflow owns deeper research after launch.

   It may be an inline model call or a tiny internal workflow/stage, but it must
   return structured routing data and must not create a full research plan, ask the
   research skill's compatibility-posture question, spawn broad parallel documentarian
   agents, or write a durable research artifact. The assessor may inspect filenames,
   package boundaries, docs, tests, and obvious symbols, but should not edit files.
   Keep tools read-only where possible. Its prompt must explicitly quote or summarize
   the existing workflow
   system-prompt guidance from `packages/workflows/src/extension/workflow-prompts.ts`:
   prefer `goal` for small fixes / quick fixes, prefer `ralph` for non-trivial work
   over ~2k LoC estimated diff, and use estimated LoC plus number of unique
   files/touched areas as scope signals. It may also reference
   `docs/workflow-playbook.md` and `packages/coding-agent/docs/workflows.md`, but those
   docs are not the routing source of truth.

5. **Workflow launch mapping.** Pass the original raw pasted text into the chosen
   workflow:
   - `goal` → `objective = <raw pasted text>`
   - `ralph` → `prompt = <raw pasted text>`
   Defaults remain unchanged; for example `ralph.max_loops` stays at the workflow
   default and `ralph.create_pr` stays `false`.

6. **Already-onboarded startup.** When `onboardedVersion` is set, skip all onboarding
   copy, keep the normal editor placeholder behavior, and route the first user message
   through the regular chat/slash-command path. Do not run scope assessment or auto
   launch `goal`/`ralph` unless the user explicitly uses a workflow entrypoint.

7. **Use existing workflow launch/status UX.** Do not add a custom onboarding handoff
   surface. Use the standard workflow launch path and preserve existing behavior for
   background status, `/workflow status`, `/workflow connect <id>`, and graph-overlay
   opt-in.

## Edge cases

- **Slash command as first input:** handled normally; onboarding stays available until
  a real ticket/task prompt is submitted or the user enters normal chat with `/chat`.
  The first-run CTA should remain or be re-rendered as the empty-state guidance after
  the command completes, rather than disappearing merely because a command was run.
- **Logged-out first run:** the CTA includes `If you have not logged in yet, first run
  /login.` There is no separate logged-out onboarding state. Onboarding does not check
  auth, render its own login failure, or recover/preserve prompts specially. If the
  model-backed routing assessment, normal chat continuation, or workflow launch hits
  missing auth/no model/no API key, the existing coding-agent error path shows the
  standard `/login` guidance. Because no routing decision or workflow launch succeeded,
  onboarding is not marked complete.
- **User wants ordinary chat instead of a workflow:** the user types `/chat` or
  `/chat <message>`. Set `onboardedVersion`, remove the CTA for future startups, print
  the normal-chat transition copy, and then either wait for the next message or
  continue with `<message>` normally. If the normal chat continuation later hits an
  auth error, rely on the existing coding-agent login guidance rather than
  reintroducing onboarding-specific auth copy.
- **Empty / trivial input:** do not assess or launch; keep the placeholder and wait.
- **Routing/scope assessment failure or timeout:** fail safe with a concise message and
  let the user retry when no useful signal was gathered. If partial findings are
  usable, route from them with an explicit low-confidence reason. Default to `goal`
  only for clearly localized requests; otherwise default to `ralph` for safety on
  broad/unknown scope.
- **Workflow launch failure:** show a concise error and leave the user's pasted text
  available/recoverable so they can retry or use normal chat.
- **Resumed / non-fresh sessions:** onboarding does not render (gated by
  `onboardedVersion` and existing "skip changelog when messages exist" logic).
- **`NO_COLOR` / narrow terminal:** copy must degrade to plain text and respect the
  existing sidebar-collapse width rules; no fixed-width art beyond the existing banner.
- **Quiet startup setting:** decide whether onboarding still shows when quiet startup
  is enabled (see Open decisions).

## Open decisions for the implementer

1. **Assessment implementation:** inline model call vs. small internal workflow/stage.
   Recommendation: use a small structured stage so the routing decision is
   inspectable.
2. **Assessment tool budget:** choose the smallest read-only tool set that can estimate
   touched areas and rough size without doing full research. Keep the expected runtime
   to roughly 1–3 minutes and enforce the 10-minute cap.
3. **Line threshold interpretation:** treat the system prompt's `over 2K LoC
   estimated diff` guidance as approximate implementation/test/docs change size, not
   raw input size. Use breadth/cross-cutting shape and number of likely unique files
   touched as tie-breakers.
4. **Quiet-startup interaction:** show onboarding regardless, or suppress when quiet
   startup is on. Recommendation: show on true fresh install regardless, since
   `onboardedVersion` guarantees it is one-time.
5. **Dismissal affordance:** implement `/chat` as the explicit "ask anything instead"
   path. `/chat <message>` exits onboarding and sends the message through normal chat;
   `/chat` exits onboarding and waits. Other slash commands should not dismiss
   onboarding.

## Acceptance criteria

- On a true fresh install, the startup screen shows the value statement, the
  "Paste a ticket description, GitHub issue, path to a spec, or task prompt to start" CTA, the
  login hint (`If you have not logged in yet, first run /login.`), the editor
  placeholder, and the `/atomic` hint.
- Pasting a ticket description, GitHub issue, path to a spec, or task prompt prints a
  brief notice that Atomic is doing a quick read-only scope check, then runs exactly
  one lightweight `research-codebase`-inspired scope probe before launching a workflow.
- The scope probe is expected to finish in about 1–3 minutes on a typical repo and is
  capped at 10 minutes; it routes from partial findings rather than becoming a full
  research workflow.
- During onboarding, the first substantive non-slash, non-`/chat` input is treated as
  the workflow seed.
- `/chat <message>` exits onboarding, prints the normal-chat transition copy, and sends
  `<message>` through the regular chat path; `/chat` exits onboarding, prints the same
  copy, and waits for the next message.
- The routing assessor uses the workflow system-prompt guidance as the source of truth
  for choosing `goal` vs. `ralph`; docs may support the prompt but do not define a
  separate onboarding routing taxonomy. When the seed is a spec path, the assessor
  reads the spec, runs a bounded subagent-backed scope pass using `codebase-locator`
  and, when useful, `codebase-analyzer`, `codebase-pattern-finder`, or
  `codebase-online-researcher`, then makes a best-effort decision from likely changed
  lines, files, and touched areas without producing a full research document or
  duplicating the selected workflow's deeper research.
- Requests assessed as small fixes / quick fixes, localized, and under about 2k changed
  lines route to `goal`.
- Requests assessed as non-trivial, about 2k+ changed lines, broad, cross-cutting,
  migration-shaped, many-unique-files, or uncertain-large route to `ralph`.
- When routing to `ralph`, onboarding leaves `max_loops` at the workflow default.
- The decision block explains in simple terms why `goal` or `ralph` was chosen and
  teaches when to use the other workflow in the future.
- The selected workflow receives the original raw pasted request and runs its own
  `prompt-refinement` stage internally.
- Onboarding does not implement a custom handoff block; standard workflow launch/status
  behavior remains responsible for run id display, progress/status, and graph connect.
- The selected workflow runs to completion and reports its own results; onboarding adds
  no completion UI.
- Onboarding renders at most once (guarded by `onboardedVersion`); resumed sessions and
  subsequent launches show the normal startup.
- `/atomic`, `/login`, `/model`, and other slash commands entered first are not treated
  as tickets and do not dismiss onboarding.
- Users who want ordinary chat first can type `/chat` or `/chat <message>`; onboarding
  prints brief `goal`/`ralph` guidance, explains that Atomic can also chat like a
  regular coding agent, and then exits onboarding.
- Onboarding does not implement any custom logged-out failure path or auth preflight.
  Missing auth/no model/no API key errors are surfaced through the existing coding-agent
  prompt/workflow error handling and `/login` guidance, and failed prompts/launches do
  not mark onboarding complete.
