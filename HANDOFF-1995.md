# Handoff — Atomic issue #1995 (Pi v0.82.1 parity)

**Written:** 2026-07-26 ~11:30 PDT
**Author:** orchestrating Atomic session (Claude Opus 5), after the user asked to stop the run
**Worktree:** `/Users/tonystark/Documents/projects/atomic-issue-1995`
**Issue:** https://github.com/bastani-inc/atomic/issues/1995

> This file is untracked scratch. Delete it before committing, or keep it out of the PR.

---

## 1. What happened

The work ran as a single `ralph` workflow run:

- **runId:** `50e61fc1-e984-4bf7-a61b-8ae7548ba1e8`
- **Started:** 2026-07-26 01:35 PDT · **Killed:** 2026-07-26 11:21 PDT (~9h50m)
- **State:** quit by user request; resumable via `/workflow resume 50e61fc1-e984-4bf7-a61b-8ae7548ba1e8`
- **Progress at kill:** 12 stages completed, `orchestrator-3` interrupted

| # | Stage | Model | Result |
|---|---|---|---|
| 1 | research-prompt-refinement-1 | gpt-5.6-sol | completed |
| 2 | research-1 | gpt-5.6-sol | completed — port matrix 63/63 commits, 257/257 files |
| 3 | orchestrator-1 | gpt-5.6-sol | completed (3h45m) — bulk implementation |
| 4–5 | reviewer-a (kimi/k3), reviewer-b (gpt-5.6-sol) | — | **rejected**: 2 + 4 findings |
| 6–7 | refinement-2, research-2 | gpt-5.6-sol | completed |
| 8 | orchestrator-2 | gpt-5.6-sol | completed (2h) — repaired round-1 findings, corrected 65 matrix rows |
| 9–10 | reviewer-a (claude-fable-5), reviewer-b (gpt-5.6-sol) | — | **split**: A approved, B rejected with 5 findings |
| 11–12 | refinement-3, research-3 | — | completed |
| 13 | orchestrator-3 | gpt-5.6-sol | **interrupted** — had already landed the round-2 repairs (last source edit 10:44, last docs edit 10:51); appeared to be in final validation when killed |

One detached `codebase-online-researcher` subagent failed with a transient Codex 500 during `research-1`; the stage completed on its remaining researchers.

---

## 2. Independently verified state (I ran these myself, after the kill)

All commands run in the worktree between 11:21 and 11:30 PDT. Logs under `/tmp/atomic-issue-1995/handoff-*.log`.

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | **exit 0** |
| Lint | (same `tsc --noEmit` as typecheck) | **exit 0** |
| Unit | `bun run test:unit` | **4243 pass, 0 fail** (553 files, 108s) |
| Integration | `bun run test:integration` | **264 pass, 0 fail** (29 files) |
| coding-agent vitest | `bun run --cwd packages/coding-agent test` | **3014 pass, 30 skipped** (375 files) |
| File length | `bun run check:file-length` | **pass** — 2445 tracked files, max 500 |
| Shrinkwrap | `bun run check:shrinkwrap` | **pass** — up to date |
| Docs links | `bun run --cwd packages/coding-agent docs:check` | **pass** — 38 MD/MDX pages |
| Frozen install | `bun install --frozen-lockfile` | **exit 0** — 503 installs, no changes |
| Installed Pi | `node_modules/@earendil-works/*/package.json` | `pi-agent-core` **0.82.1**, `pi-ai` **0.82.1**, `pi-tui` **0.82.1** |
| Manifests | grep across `packages/*/package.json` | **11/11** declarations at `^0.82.1` |
| Workspace versions | all 7 packages | all **`0.0.0`** |
| Conflict markers | grep `<<<<<<<`/`>>>>>>>` | none |

I also re-ran the three reviewer-authored failure probes that blocked round 2. **All three now report fixed behavior:**

```
$ bun /tmp/atomic-issue-1995/reviewer-llama-stale-probe.ts
{"firstErrors":[],"firstModels":["cached-on-restart"],
 "restartErrors":["llama.cpp"],"restartedModels":["cached-on-restart"]}   ← cache survives failed refresh

$ bun /tmp/atomic-issue-1995/reviewer-rpc-session-swap-probe.ts
{"updates":[{"id":"long-bash","delta":"before"},{"id":"long-bash","delta":"after"}], ...}  ← both deltas delivered

$ bun /tmp/atomic-issue-1995/reviewer-isolated-custom-oauth-probe.ts
{"descriptor":{"id":"corp-oauth",...},"credentialTransported":false,
 "persistedAndRefreshed":true,"correlatedCancelPreservedCredential":true,"logoutRemovedCredential":true}
```

And the focused regressions for those repairs pass (46 tests / 7 files, `handoff-focused.log`):
`rpc-bash-session-replacement`, `rpc-bash-streaming`, `oauth-cancellation`, `pi-0.82.1-auth`,
`model-registry-hot-reload`, `constrained-sampling-capabilities`, `bash-session-metadata`,
plus `test/unit/llama-extension-parity.test.ts:120` ("keeps a validated cached catalog visible when the
first online refresh after restart fails").

---

## 3. Honest gaps — what is NOT done

1. **Nothing is committed.** `HEAD` is **detached at `e5c80d6a3`, identical to `origin/main`**. The entire
   delta is uncommitted working tree: **126 modified, 1 deleted, 43 untracked** (127 files changed,
   +1993 / −860 in tracked files). A `git checkout` or worktree removal destroys ~10 hours of work.
   **Do this first.** No branch exists yet.
2. **No PR.** The `create_pr` stage never ran.
3. **No round-3 reviewer verdict.** The last recorded verdict is round 2, where reviewer A approved and
   reviewer B rejected. Reviewer B's five findings look repaired (§2), but *no independent reviewer has
   confirmed that*. My checks are suite-level and probe-level, not adversarial.
4. **Two live tmux captures are still pending**, self-declared in
   `/tmp/atomic-issue-1995/evidence/SUMMARY.md` and in the port-matrix front matter
   (`status: lifecycle-repairs-final-tree-green-kimi-and-built-rpc-captures-pending`):
   - a quiet Kimi Code login-cancellation capture (the existing `06b-kimi-route-cancelled.txt` shows the
     old raw `AbortError` behavior, now fixed in code);
   - a built-CLI RPC session-swap capture proving the bash-ownership fix end to end.
5. **I did not re-verify** these stage-reported results after the kill: clean `bun run build` from scratch,
   `build:binary` / standalone binary smoke, Darwin arm64 archive smoke, the secret audit, and any live
   real-model run. They were reported green by stages and by reviewer B's own independent run, but the
   tree has changed since some of them.
6. **Stale status wording.** `research/pi-0.82.1-port-matrix.md` front matter, its intro paragraph, and
   `evidence/SUMMARY.md` still describe in-flight status ("captures pending", "Earlier 'all literal
   requirements passed' wording is historical"). Clean these up before the PR — they read as
   self-contradictory in a review.

---

## 4. Contract discrepancies found during research (decide before closing the issue)

The issue text does not perfectly match upstream reality. Current handling:

| Issue text | Reality | Current treatment |
|---|---|---|
| "12 source declarations", incl. `packages/cursor` | `packages/cursor` no longer exists | 11 declarations updated; cursor row recorded **N/A** in the matrix |
| `supportsGrammarTools` | upstream exposes `supportsOpenAIGrammarTools` | implemented under the upstream name |
| RPC bash events with stdout/stderr separation | upstream emits combined `{ id?, delta }` | Atomic added channel-aware events (superset of upstream) |
| `build:binary` script | referenced absent workspaces | adjusted in `scripts/build-binaries.sh` / package script |

---

## 5. Where things are

**Implementation** (uncommitted, in the worktree):

- Manifests: `packages/{coding-agent,intercom,mcp,subagents,web-access,workflows}/package.json`
- Locks: `bun.lock`, `package-lock.json`, `packages/coding-agent/npm-shrinkwrap.json` (protobufjs 7.6.5)
- New source: `src/core/{model-capabilities,model-registry-extension-refresh,agent-session-runtime-auth}.ts`,
  `src/core/tools/bash-session-environment.ts`, `src/modes/rpc/{rpc-bash-request-owners,rpc-oauth-client,rpc-oauth-interaction,rpc-provider-auth}.ts`,
  `src/modes/interactive-engine/isolated-auth.ts`, `src/modes/interactive/external-editor.ts`
- New tests: 20 files under `packages/coding-agent/test/` and `test/unit/`, incl. `pi-0.82.1-*`,
  `constrained-sampling-capabilities`, `rpc-bash-*`, `oauth-cancellation`, `interactive-engine-oauth`,
  `remote-catalog-etag`, `model-registry-hot-reload`, `test/types/` (compile-level RPC type probes)
- Deleted: `test/unit/pi-0.81.1-artifacts.test.ts` → replaced by `test/unit/pi-0.82.1-artifacts.test.ts`
- Docs: 14 modified under `packages/coding-agent/docs/` + new `docs/environment-variables.md`,
  README, `CHANGELOG.md` (`[Unreleased]` only), `docs/changelog.mdx`
- Build/CI: `scripts/build-binaries.sh`, `scripts/generate-coding-agent-shrinkwrap.mjs`,
  `packages/coding-agent/scripts/assert-pi-runtime-assets.ts`, `.github/workflows/publish.yml`

**Research/evidence** (untracked in worktree, plus `/tmp`):

- `research/pi-0.82.1-port-matrix.md` — 63/63 commits, 257/257 files, 324 table rows
- `research/2026-07-26-...-1995-....md` — main research report
- `research/web/2026-07-26-pi-0.82.1-primary-sources.md` — cited sources
- `research/upstream-v0.81.1-v0.82.1-*.{diff,txt}` — upstream inventories
- `/tmp/atomic-issue-1995/evidence/` — tmux captures `01`–`18` + `SUMMARY.md` + `validation/` logs
- `/tmp/atomic-issue-1995/reviewer-*-probe.ts` — reviewer failure probes (all now passing)
- `/tmp/pi-src` — upstream Pi clone with `v0.81.1` / `v0.82.1`

**Live E2E already captured** (real models, current worktree build):
startup/version, a real `github-copilot/claude-opus-5` tool turn, all five `ATOMIC_*`/`PI_*` bash
metadata pairs equal, `/model` layered hot reload, OpenRouter + Kimi login routes, Opus 5 catalog
selection, correlated RPC bash, and bearer-only `ANTHROPIC_AUTH_TOKEN` across normal / isolated / RPC /
branch-summary / Verbatim paths (Opus itself hit a provider 429; real requests completed on Anthropic Haiku).

---

## 6. Recommended next steps

1. `git switch -c feat/1995-pi-0.82.1-parity` in the worktree, review `git status`, drop this handoff file
   and any scratch, then commit. **Highest priority — the work is currently one bad command from gone.**
2. Refresh the stale status wording in `research/pi-0.82.1-port-matrix.md` and `evidence/SUMMARY.md`.
3. Capture the two pending tmux proofs (quiet Kimi cancellation, built-CLI RPC session swap).
4. Re-run the artifact-level checks I skipped: clean build, `build:binary`, standalone/archive smokes.
5. Get one adversarial review pass on the round-2 repairs (or resume the killed run, which would go
   straight into `reviewer` round 3 — `/workflow resume 50e61fc1-e984-4bf7-a61b-8ae7548ba1e8`).
6. Open the PR against `main`, referencing #1995, and attach the tmux evidence.

## 7. Confidence

- **High** that the tree is internally consistent and green on every check listed in §2 — I ran them.
- **Medium** that the issue's full 155-item acceptance ledger is genuinely satisfied. The suites and
  probes pass, but the last independent adversarial review rejected, and its successor never reported.
  Treat §3 items 3–6 as real risk, not paperwork.
- **Not verified by me at all:** binary/archive artifacts, and any claim in stage summaries not restated
  in §2 above.
