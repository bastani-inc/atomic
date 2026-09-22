# Claude Sonnet 5 prompting

Use this reference for Sonnet 5 effort, adaptive-thinking defaults, tool triggering, and migration from Sonnet 4.6. Distilled from [Anthropic's Sonnet 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5), checked September 22, 2026. Existing Sonnet 4.6 prompts are a starting point, but unchanged request parameters can behave differently. The prompt snippets below are adaptations for reuse in your own prompts, not verbatim quotes from Anthropic's guide.

## Response length follows perceived complexity

Sonnet 5 sizes its answer to task complexity rather than a fixed verbosity: short for simple lookups, longer for open-ended analysis. Where a product needs a specific style regardless, give a positive example of the target concision rather than a list of prohibitions:

```text
Provide concise, focused responses. Skip non-essential context, and keep examples minimal.
```

Adapt the wording to the specific over-elaboration you actually observe.

## Effort defaults unchanged; thinking default does not

Effort defaults to `high`, the same as Sonnet 4.6. Use `xhigh` for the hardest coding and agentic tasks, `medium` for cost-sensitive work, and `low` for short, scoped, latency-sensitive work. As a rough migration anchor, the source reports Sonnet 5 at `medium` comparable in intelligence to Sonnet 4.6 at `high`, and Sonnet 5 at `high` comparable to Sonnet 4.6 at `max`; benchmark against observed thinking length on your own tasks rather than trusting the name alone.

At `low` and `medium`, the model scopes tightly to what was asked and can under-think moderately complex work. Raise effort before adding reasoning instructions; if effort must stay low for latency, add a targeted nudge:

```text
This task involves multistep reasoning. Think carefully through the problem before responding.
```

The real behavior change from Sonnet 4.6: a request that omits `thinking` now runs with adaptive thinking on by default, where the same omission ran without thinking on Sonnet 4.6. If a former thinking-disabled workload now emits more than you want, steer triggering directly and measure the effect:

```text
Thinking adds latency and should only be used when it will meaningfully improve answer quality, typically for problems that require multistep reasoning. When in doubt, respond directly.
```

Conversely, for hard `medium`-effort workloads showing under-thinking, raise effort first; prompt for more thinking only if that is insufficient. Manual extended thinking (`budget_tokens`) is not supported on Sonnet 5; adaptive thinking plus effort is the only control.

## Tool use is more readily triggered, except with thinking off

Sonnet 5 reaches for tools and self-verification more readily than 4.6 by default. With thinking explicitly disabled, it is less likely to reach for tools; add an explicit nudge in the system prompt if you rely on tool calls under that configuration. Higher effort also increases tool use in agentic search and coding. For an under-used specific tool, explain concretely when and why it applies instead of adding a blanket instruction.

```text
Use the available retrieval tool when the answer depends on current external facts, and the execution tool for requested checks rather than predicting their output. Do not call tools for facts already established by the supplied evidence. Report when a needed tool is unavailable.
```

## Progress updates are usually adequate without forcing

Sonnet 5 already gives regular, reasonably detailed updates during long agentic traces. Remove inherited scaffolding like "after every 3 tool calls, summarize progress." If updates are still miscalibrated for your use case, describe the desired content and cadence explicitly, with one example.

## Instructions are read literally, especially at low effort

The model does not silently generalize an instruction from one item to a set, and it does not infer requests you did not make. State the full intended scope:

```text
Update each affected section using the supplied specification. Retrieve current API documentation only where the specification leaves compatibility unresolved. Keep changes within this request, run the required checks, and report any blocking mismatch with evidence. Deployment is not authorized.
```

Front-load intent and constraints so routine work can proceed without avoidable confirmation turns, while preserving actual approval gates.

## Tone and sampling-based variety both need direct prompting

Prose style may shift from a prior model's baseline; re-evaluate an inherited voice prompt against actual output.

```text
Use a warm, collaborative tone. Acknowledge the user's framing before answering.
```

`temperature`, `top_p`, and `top_k` at non-default values are rejected outright on Sonnet 5. Remove those parameters during migration and drive tone and output variety through the prompt instead of sampling settings.

## Design defaults toward one house style

Open-ended frontend and design briefs can settle into a single default style that reads fine for some products but wrong for dashboards, dev tools, fintech, healthcare, or enterprise apps. A generic ban ("don't use that color") tends to swap in another fixed default instead of real variety. Two approaches work more reliably:

**Give a concrete alternative spec:**

```text
Use a cold monochrome atmosphere: pale silver-gray tones deepening into blue-gray and near-black. Sharp, controlled, restrained. A square angular sans-serif with wide letter-spacing in headings; short, sparse body copy. 4px corner radius across cards, buttons, inputs, and media frames. Generous margins. Palette limited to #E9ECEC, #C9D2D4, #8C9A9E, #44545B, #11171B.
```

**Ask for options before building**, when the user should choose, since `temperature` is unavailable for run-to-run variety here:

```text
Before building, propose 4 distinct visual directions tailored to this brief (each as: background hex / accent hex / typeface, plus a one-line rationale). Wait for the user's selection before implementing.
```
Use this selection pause only when the user wants to choose. Otherwise follow the approved design direction without inventing another approval gate.

A short generic-pattern guard can still help alongside a concrete spec:

```text
Choose typography, spacing, and components from the supplied design references rather than default decorative patterns. Avoid ornamental gradients and repetitive nested cards unless they serve this brief. Keep accessibility and existing design-system constraints.
```

## Review recall drops under vague severity filters

Phrasing such as "be conservative" or "don't nitpick" can make Sonnet 5 investigate just as thoroughly but withhold findings below that vague bar, lowering measured recall without a real capability loss. If a separate stage filters or ranks findings, tell the discovery stage its job is coverage:

```text
Report supported issues within scope with their trigger, evidence, location, and impact. Include lower-severity findings when the request allows them. Keep uncertain candidates separate from confirmed bugs so a downstream pass can verify and rank them.
```

For a single pass with no separate filter, define the bar concretely (incorrect behavior, failing test, misleading result) and exclude pure style or naming preferences. Preserve any severity limit the user explicitly requested; do not expand review scope beyond it in pursuit of recall.

## Compatibility notes

The migration guide (linked from the source) removes accepted sampling parameters and manual extended thinking, and changes the default `max_tokens` accounting to include thinking tokens; a limit tuned for thinking-disabled Sonnet 4.6 output can now truncate a response mid-answer with `stop_reason: "max_tokens"`. Raising `max_tokens` or lowering effort resolves that. The source also reports a new tokenizer producing roughly 30% more tokens for equivalent text, so an inherited budget may need retuning independent of thinking.

Computer use follows the same tool versions and resolution guidance as Opus 4.8: `computer_toolset_20260801` or the earlier `computer_20251124`, plus `browser_toolset_20260801`, on the Claude API and Google Cloud; 1080p is reported as a good performance/cost balance, with 720p/1366×768 for cost-sensitive work. Confirm actual host and provider support before depending on any of these; API availability is not Atomic support.

Test a migrated request payload, a required-retrieval task, and a code-review case. Check budget exhaustion, structured tool calls, scope, and supported findings. Compare one prompt or effort change at a time.
