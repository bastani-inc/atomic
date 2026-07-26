# Prompt optimization rubric — GPT-5.6, Claude Opus 5, Claude Fable 5

Source of truth for this rubric (fetched 2026-07-26, cached beside this file):

- `claude-best-practices.md` — https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices
- `claude_build-with-claude_prompt-engineering_prompting-claude-opus-5.md` — Prompting Claude Opus 5
- `claude_build-with-claude_prompt-engineering_prompting-claude-fable-5.md` — Prompting Claude Fable 5
- `claude_build-with-claude_effort.md`, `claude_build-with-claude_thinking.md`, `claude_build-with-claude_thinking-steering-and-cost.md`
- `openai-gpt56-prompting.md` — https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md
- `openai-gpt56-upgrade.md`, `openai-latest-model.md`

## 0. Why this matters here

Atomic's subagents pin `openai-codex/gpt-5.6-*` as primary with `claude-opus-5` / `claude-fable-5`
fallbacks. Builtin workflow stages pin `anthropic/claude-opus-5:high` primary with `gpt-5.6-sol`
and `claude-fable-5` fallbacks. **Every prompt in this repo runs on all three families.** Optimize
for the intersection, not for one vendor.

OpenAI measured leaner system prompts scoring ~10–15% higher while cutting tokens 41–66% and cost
33–67% on internal coding-agent evals. Anthropic says the same thing from the other side: Fable 5
guidance states prompts and skills "developed for prior models are often too prescriptive for
Claude Fable 5 and can degrade output quality."

**The default edit is deletion.** Additions must earn their place.

---

## 1. Hard preservation contract (violating any of these is a defect)

These are behavior-bearing and must survive byte-identical unless the rubric explicitly names them:

1. **Exported symbol names and signatures** in `packages/workflows/builtin/*.ts`
   (`LITERAL_OBJECTIVE_CONTRACT`, `renderReviewerPrompt`, `renderWorkerPrompt`, …). Rewrite the
   *string contents*; never rename, remove, merge, or re-sign an export.
2. **Structured-output field names and enum values** referenced in prose:
   `stop_review_loop`, `objective_alignment`, `required_by_objective`, `consistent_with_objective`,
   `beyond_objective`, `contradicts_objective`, `requirements_traceability`, `overall_correctness`,
   `reviewer_error`, `overall_explanation`, `code_location`, `findings`, priority values `P0`–`P3`
   and numeric `0`–`3`. These are parsed by `goal-reducer.ts`, `goal-review.ts`,
   `ralph-review-gate.ts`, `review-convergence.ts`.
3. **Gating semantics.** The reducer/gate reads `stop_review_loop` deterministically. Any clause
   that tells the model *how to derive* that flag is load-bearing. Compress its wording; do not
   drop a derivation rule.
4. **Agent frontmatter** in `packages/subagents/agents/*.md`: `name`, `description`, `tools`,
   `model`, `fallbackModels`, `skills`, `systemPromptMode`, `inheritProjectContext`,
   `inheritSkills`, `defaultContext`, `defaultProgress`. Descriptions drive routing — tighten only.
5. **Template variables** in `packages/subagents/prompts/*.md` and chain task strings:
   `{task}`, `{previous}`, `{chain_dir}`, `{item}`, `{outputs.name}`.
6. **Tool, skill, command, and path literals**: `contact_supervisor`, `intercom`, `playwright-cli`,
   `tmux`, `tdd`, `fetch_content`, `research/web/`, `progress.md`, `git status --porcelain`,
   `bun run typecheck`, artifact paths, `send_to_user`.
7. **Every distinct semantic rule.** Trimming means removing *repetition, hedging, and prescriptive
   process narration* — not removing a rule that has no other statement in the prompt.

If unsure whether a clause is load-bearing: grep the repo for the concept. If a runtime file reads
it, it stays (compressed).

---

## 2. Cross-model rules (apply to every prompt in scope)

### 2.1 Delete over-prompting

| Delete | Why |
| --- | --- |
| The same rule stated twice in one prompt | GPT-5.6: "repeated statements of the same rule"; contradictions destabilize prompt-contract followers |
| "double-check", "re-verify before responding", "verify your own work" | Opus 5 self-verifies natively; these compound into over-verification, cost, and latency with no quality gain |
| "CRITICAL: you MUST use X", "ALWAYS use X", "If in doubt, use X" | Anthropic: anti-undertriggering language now *over*triggers. Use plain "Use X when …" |
| Step-by-step process narration for behavior the model already does | Both guides: prescriptive scaffolding degrades current-gen output |
| Examples that do not change behavior | GPT-5.6 trim list |
| Tool descriptions for tools the stage cannot call | GPT-5.6 trim list |

### 2.2 Keep (never trim these categories)

Per GPT-5.6 guide, keep: the user-visible outcome; success criteria and stopping conditions; safety,
business, evidence and permission constraints; tool-routing rules whose route depends on context;
required output shape and validation requirements.

### 2.3 Absolutes discipline

Reserve `ALWAYS` / `NEVER` / `MUST` / `only` for true invariants — safety, required fields, actions
that must never happen, and the gating-flag derivation rules in §1.3. For judgment calls (when to
search, ask, delegate, keep iterating) write a **decision rule** instead:

> Not: "ALWAYS check `research/web/` before fetching."
> Yes: "Check `research/web/` for a recent cached copy first; fetch only when it is missing or stale."

### 2.4 Outcome-first shape

Prefer the GPT-5.6 suggested structure, trimmed to what the stage needs. Not every prompt needs
every section:

```
Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules
```

State the destination and completion bar; leave the path to the model.

### 2.5 Give the reason, not only the request

Fable 5 and the general Anthropic guidance both improve when motivation is present. One clause of
*why* beats three clauses of *what not to do*. Example: "Your output is read by a reviewer who never
saw your session" outperforms a list of banned formatting.

### 2.6 XML/section tags for complex prompts

Wrap distinct content kinds in consistent, descriptive tags (`<objective>`, `<acceptance_criteria>`,
`<receipts>`, `<review_findings>`). Nest for hierarchy. Applies to the long composed prompts in
`goal-prompts.ts`, `ralph-reviewer-prompt.ts`, `goal-orchestrator-prompts.ts`.

### 2.7 Long-context ordering

Put long inputs (ledgers, receipts, prior findings, diffs, research artifacts) **near the top**, and
the instruction/query **at the end**. Anthropic measures up to ~30% quality improvement from
query-last ordering on multi-document inputs. Several render helpers currently interleave — fix the
order without changing what is rendered.

### 2.8 Grounded progress claims (highest-value single addition)

Fable 5 guidance: auditing claims against tool results "nearly eliminated fabricated status reports."
Any stage that reports progress, receipts, or completion gets one compact clause:

> Before reporting progress, audit each claim against a tool result from this session. Report only
> work you can point to evidence for; say so explicitly when something is unverified.

This replaces — not supplements — longer evidence-nagging passages.

### 2.9 Delegation damping

Opus 5 and Fable 5 both over-delegate. Orchestrator prompts get one decision rule, not a taxonomy:

> Delegate only work that is genuinely independent and too large to finish in a handful of tool
> calls. Do not use subagents to verify or double-check your own work. Prefer one subagent over
> several.

### 2.10 Autonomy, approval, and no-promise endings

One compact policy, stated once (repeating "ask first" causes spurious approval requests):

- read/explain/review/diagnose/plan → inspect and report; do not implement
- change/build/fix → make in-scope local edits and run non-destructive validation without asking
- external writes, destructive actions, scope expansion → confirm first

For autonomous stages add the Fable 5 no-promise check: if the final paragraph is a plan, a
question, or "I'll now…", do that work with tool calls instead of ending the turn.

### 2.11 Conciseness must be explicit

Opus 5's visible responses run long and **effort does not shorten them**. Any stage with a
user-facing or downstream-consumed report states its length contract explicitly. Prefer the
selective form over the compressive one:

> Lead with the outcome. Keep the facts, decisions, caveats, and next steps; drop background,
> repetition, and detail that would not change what the reader does next. Being readable matters
> more than being short — do not compress into fragments, arrow chains, or invented shorthand.

### 2.12 Do not ask a model to reproduce its reasoning ⚠️

**Fable 5 hazard.** Instructions to echo, transcribe, narrate, or explain internal reasoning as
response text can trigger the `reasoning_extraction` refusal category and force fallback to Opus 4.8.
Audit every prompt for "explain your reasoning", "show your thinking", "walk through your thought
process", "narrate your reasoning". Rewrite as a request for *evidence and conclusions*:

> Not: "Explain your reasoning for each finding."
> Yes: "For each finding, give the file:line, the observed behavior, and the command or test that
> shows it."

Asking for analysis, justification against a spec, or cited evidence is fine. Asking for the
model's internal deliberation is not.

### 2.13 Thinking-word caution

With thinking disabled, Opus 4.5-era models are sensitive to "think" and variants. Prefer
"consider", "evaluate", "assess", "reason through" in instruction text.

### 2.14 Parallel tool calls

Where a stage does independent reads, one clause is enough (GPT-5.6: parallelize independent reads,
stay sequential when one result determines the next; synthesize after parallel retrieval).

### 2.15 Context-budget silence

Fable 5 can wrap up early when shown a remaining-token countdown. Never surface budget counts in a
prompt; where a harness must, add: "You have ample context remaining. Do not stop, summarize, or
suggest a new session on account of context limits."

### 2.16 Scope and over-engineering

One clause, not a section: no features, refactors, abstractions, defensive validation, or
compatibility shims beyond what the task requires; validate only at system boundaries.

### 2.17 No prefill

Prefilled assistant turns 400 on Claude 4.6+. Remove any guidance recommending response prefilling
(this currently appears in the `prompt-engineer` skill and its references).

---

## 3. Per-surface application

### 3.1 `packages/subagents/agents/*.md` (9 files)

Primary GPT-5.6, fallback Opus 5 / Fable 5.

- Keep frontmatter exactly (§1.4); tighten `description` only if it improves routing.
- Restructure the body toward Role / Goal / Success criteria / Constraints / Tools / Output / Stop
  rules. Keep each agent's distinctive voice where it carries meaning (`code-simplifier`'s door
  metaphor is its rubric, not decoration — compress it, do not flatten it).
- `debugger.md`: keep the tdd-before-tests and never-suppress-a-failing-test invariants (true
  invariants, §2.3 permits the absolutes). Remove any generic double-check language.
- Locator/analyzer/pattern-finder agents: these are read-only reporters. Add §2.8 grounding, add the
  §2.11 length contract, delete process narration.
- `codebase-online-researcher.md` (301 lines): heaviest trim candidate. Convert `ALWAYS check
  research/web/` into a decision rule; collapse the troubleshooting table to rows that change
  behavior.
- `worker.md`: add §2.10 no-promise ending; keep the `contact_supervisor` escalation contract intact.

### 3.2 `packages/subagents/prompts/*.md` (7 files)

Preserve `{task}` / `{previous}` / `{chain_dir}` variables. These are chain-step task templates:
make each one outcome-first with an explicit output contract and stop rule.

### 3.3 `packages/workflows/builtin/*prompts*.ts` + `shared-prompts.ts`, `ralph-core.ts`,
`ralph-reviewer-prompt.ts`, `goal-*.ts`, `open-claude-design-*.ts`, `review-convergence.ts`

Primary Opus 5, fallback GPT-5.6 / Fable 5.

- Highest-value trims: `shared-prompts.ts` (147 lines of dense contract prose),
  `goal-prompts.ts` (386), `ralph-reviewer-prompt.ts` (182), `goal-orchestrator-prompts.ts` (133).
- `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT` is a genuine anti-circularity contract — keep every
  distinct rule, compress the wording, and convert the "conditional probe playbook" from an
  enumerated checklist into a shorter risk-class list with the selection rule stated once.
- `CONTRACT_FIDELITY_AUDIT` and `ACCEPTANCE_MATRIX_CONTRACT` overlap with reviewer contracts and
  with Opus 5's native self-verification. Deduplicate across files: state each rule in exactly one
  constant and compose, rather than restating.
- Reviewer prompts must **not** ask for internal reasoning (§2.12); they should ask for commands
  run, observed output, and file:line evidence.
- Apply §2.7 ordering in every `render*Prompt` helper: rendered artifacts first, instruction last.
- Keep the E2E/QA-video evidence contract — it is an evidence constraint (§2.2) — but state each
  rule once across `shared-prompts.ts` and `ralph-core.ts` instead of twice.

### 3.4 `packages/workflows/skills/prompt-engineer/` (SKILL.md + 3 references)

Currently teaches a pre-4.6 playbook: it recommends **response prefilling** (now a 400 error),
frames chain-of-thought as a primary technique (superseded by adaptive thinking), and has no
guidance for agentic prompts, tool routing, stopping conditions, effort/verbosity, delegation
damping, or the `reasoning_extraction` hazard.

Rewrite it to teach this rubric, with model-family sections for GPT-5.6, Opus 5, and Fable 5, and a
"delete first" workflow. Keep the three-reference progressive-disclosure structure and the
`references/` filenames so existing `Read references/...` instructions keep working.

---

## 4. Acceptance gates

- `bun run typecheck`
- `bun run lint`
- `bun run check:file-length` (500-line ceiling; several targets are near it)
- `bun run test:unit`
- No exported symbol added, removed, or renamed in `packages/workflows/builtin/`
- No agent frontmatter key or value changed except `description`
- Repo-wide grep shows zero remaining instances of: response-prefill guidance, "double-check your
  work"-style self-verification nagging, and reasoning-echo instructions (§2.12)
- `packages/coding-agent/docs` updated where user-facing behavior is described
- `packages/*/CHANGELOG.md` `[Unreleased]` updated for the packages that changed shipped prompts
