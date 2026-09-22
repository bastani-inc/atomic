# Claude Sonnet 5 prompting

Use this reference for Sonnet 5 effort and thinking behavior, tool triggering, and migration from Sonnet 4.6. Distilled from [Anthropic's Sonnet 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5), checked September 22, 2026. Existing Sonnet 4.6 prompts are a starting point. The prompt snippets below are adaptations for reuse in your own prompts, not verbatim quotes from Anthropic's guide.

## Response length follows perceived complexity

Sonnet 5 sizes its answer to task complexity rather than a fixed verbosity: short for simple lookups, longer for open-ended analysis. Where a product needs a specific style regardless, give a positive example of the target concision rather than a list of prohibitions:

```text
Provide concise, focused responses. Skip non-essential context, and keep examples minimal.
```

Adapt the wording to the specific over-elaboration you actually observe.

## Lower effort narrows investigation; thinking is on by default

At lower effort, the model scopes tightly to what was asked and can under-think moderately complex work. Raise effort before adding reasoning instructions; if effort must stay low for latency, add a targeted nudge:

```text
This task involves multistep reasoning. Think carefully through the problem before responding.
```

Unlike Sonnet 4.6, Sonnet 5 thinks adaptively by default. If a workload that used to run without thinking now thinks more than you want, steer triggering directly and measure the effect:

```text
Thinking adds latency and should only be used when it will meaningfully improve answer quality, typically for problems that require multistep reasoning. When in doubt, respond directly.
```

Conversely, for hard workloads showing under-thinking, raise effort first; prompt for more thinking only if that is insufficient.

## Tool use is more readily triggered, except with thinking off

Sonnet 5 reaches for tools and self-verification more readily than 4.6 by default. With thinking disabled, it is less likely to reach for tools; add an explicit nudge in the system prompt if you rely on tool calls there. Higher effort also increases tool use in agentic search and coding. For an under-used specific tool, explain concretely when and why it applies instead of adding a blanket instruction.

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

## Tone and output variety need direct prompting

Prose style may shift from a prior model's baseline; re-evaluate an inherited voice prompt against actual output.

```text
Use a warm, collaborative tone. Acknowledge the user's framing before answering.
```

Sampling settings no longer provide output variety on Sonnet 5, so drive tone and variety through the prompt.

## Design defaults toward one house style

Open-ended frontend and design briefs can settle into a single default style that reads fine for some products but wrong for dashboards, dev tools, fintech, healthcare, or enterprise apps. A generic ban ("don't use that color") tends to swap in another fixed default instead of real variety. Two approaches work more reliably:

**Give a concrete alternative spec:**

```text
Use a cold monochrome atmosphere: pale silver-gray tones deepening into blue-gray and near-black. Sharp, controlled, restrained. A square angular sans-serif with wide letter-spacing in headings; short, sparse body copy. 4px corner radius across cards, buttons, inputs, and media frames. Generous margins. Palette limited to #E9ECEC, #C9D2D4, #8C9A9E, #44545B, #11171B.
```

**Ask for options before building**, when the user should choose, since sampling settings cannot supply run-to-run variety here:

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

## Validate the prompt change

Hidden thinking now uses part of the output allowance, so a long answer tuned for Sonnet 4.6 can be cut off mid-answer; ask for the deliverable first and keep instructions from inflating it. Test a required-retrieval task, a long answer, and a code-review case. Check truncation, actual tool calls, scope, and supported findings. Compare one prompt or effort change at a time.
