# Claude Opus 4.8 prompting

Use this reference for Opus 4.8 verbosity, effort, tool triggering, subagent spawning, and design defaults. Distilled from [Anthropic's Opus 4.8 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8), checked September 22, 2026. Existing Opus 4.7 prompts are a starting point; migrating onward to Opus 5 or 5.5 needs their own guides. The prompt snippets below are adaptations for reuse in your own prompts, not verbatim quotes from Anthropic's guide.

## Response length follows perceived complexity

Opus 4.8 sizes its answer to how hard it judges the task to be: short for simple lookups, long for open-ended analysis. If your product needs a fixed style regardless of task, say so and show what "right-sized" means for your use case. A positive example of the target concision works better than a list of things not to do.

```text
Provide concise, focused responses. Skip non-essential context, and keep examples minimal.
```

Adapt the wording to the specific over-elaboration you observe (excess caveats, restating the question, unnecessary background) rather than reusing this verbatim for every product.

## Effort is the main capability/cost/latency lever

Start at `xhigh` for coding and agentic work, and at least `high` for other intelligence-sensitive tasks. `max` can help on the hardest problems but shows diminishing returns and occasional overthinking; `medium` trades capability for lower cost; reserve `low` for short, scoped, latency-sensitive work.

At `low` and `medium`, Opus 4.8 scopes its work strictly to what was asked and can under-investigate moderately complex tasks. If you see shallow reasoning, raise effort before adding reasoning instructions. Where effort must stay low for latency, add a targeted nudge:

```text
This task involves multistep reasoning. Think carefully through the problem before responding.
```

Thinking is off unless the request explicitly sets `thinking: {type: "adaptive"}`, unlike Opus 5 and Sonnet 5. Once adaptive thinking is on, its triggering is steerable; if it thinks more often than the task needs (common with large or complex system prompts), say so directly and measure the effect:

```text
Thinking adds latency and should only be used when it will meaningfully improve answer quality — typically for problems that require multistep reasoning. When in doubt, respond directly.
```

At `max` or `xhigh` effort, leave enough `max_tokens` headroom for thinking plus tool calls and subagent turns; the source suggests starting around 64k and tuning from there. Do not ask the model to expose private reasoning as response text as a substitute for thinking visibility.

## Tool use favors reasoning over calling

Opus 4.8 can reach for reasoning instead of a tool it should have used. Raising effort increases tool use, especially for agentic search and coding at `high`/`xhigh`. If a specific tool (for example, web search) is still under-used, explain concretely when and why it applies rather than adding a blanket "always use tools" rule that fires on tasks needing no current evidence.

```text
Use the available search tool for current API behavior or facts not established by the supplied materials. Read the authoritative source before making a compatibility claim. If retrieval is unavailable, distinguish inference from verified facts instead of claiming you checked.
```

## Progress updates are usually adequate without forcing

Opus 4.8 already gives regular, reasonably detailed updates during long agentic traces. Remove inherited scaffolding like "after every 3 tool calls, summarize progress" and see whether native behavior is sufficient. If the length or content of updates is still miscalibrated for your use case, describe the desired update explicitly and give one example.

## Instructions are read literally, especially at low effort

The model does not silently generalize a rule from one item to a set, and it does not infer requests you did not make. This gives predictable behavior for structured extraction and pipelines, but it means an instruction meant to apply broadly must say so:

```text
Apply the requested formatting to every section of the report, not just the first one. Preserve the factual claims and citations. Return the revised report within 800 words. Ask only if a missing decision prevents that result; do not add sections or change publication state.
```

Front-load goal, constraints, and authorized actions in the initial request instead of assembling the task across later corrections; this reduces avoidable back-and-forth without removing a genuinely required approval.

## Tone defaults direct and opinionated

Prose style may differ from what a prior model produced. Opus 4.8's default voice is direct, minimally validation-forward, and sparing with emoji. If the product needs a warmer or more conversational voice, say so and give an example:

```text
Use a warm, collaborative tone. Acknowledge the user's framing before answering.
```

## Subagent spawning needs explicit permission

Opus 4.8 spawns fewer subagents by default than later Claude models. Where the host supports delegation, name when spawning is worthwhile and when it is not, matching the actual concurrency and ownership rules your harness enforces:

```text
Keep a small task you can finish directly local. If delegation is available, fan out substantial independent investigations with distinct ownership and expected evidence. Keep dependent edits sequential and respect the host's concurrency limits.
```

## Design defaults toward one house style

Open-ended design and frontend briefs can settle into a recognizable default: warm cream backgrounds, serif display type, italic accents, terracotta or amber. This fits editorial or hospitality briefs but reads wrong for dashboards, dev tools, fintech, healthcare, or enterprise apps. Generic bans ("don't use cream," "make it clean") tend to swap in a different fixed style rather than producing real variety. Two approaches work more reliably:

**Give a concrete alternative spec.** Name the actual palette, typography, spacing, and component behavior you want instead of describing what to avoid:

```text
Use a cold monochrome atmosphere: pale silver-gray tones deepening into blue-gray and near-black. Sharp, controlled, restrained. A square angular sans-serif with wide letter-spacing in headings; short, sparse body copy. 4px corner radius across cards, buttons, inputs, and media frames. Generous margins. Palette limited to #E9ECEC, #C9D2D4, #8C9A9E, #44545B, #11171B.
```

**Ask for options before building**, when the user should choose:

```text
Before building, propose 4 distinct visual directions tailored to this brief (each as: background hex / accent hex / typeface, with a one-line rationale). Wait for the user's selection before implementing.
```

Use the options prompt only when the user actually wants to choose; otherwise state the decision rule you already have authorization to apply. A short generic-pattern guard can still help alongside a concrete spec:

```text
Use the supplied visual references to choose typography, spacing, and components deliberately. Avoid decorative gradients, repetitive nested cards, or unusual fonts unless they serve this design. Preserve accessibility and the existing design system.
```

## Review recall drops under vague severity filters

Broad phrasing such as "be conservative" or "only important issues" can make Opus 4.8 investigate just as thoroughly but then withhold findings it judges below that vague bar, lowering measured recall without a capability loss. If a separate stage already filters or ranks, tell the finding stage its job is coverage:

```text
Report supported issues within scope, including lower-severity findings if the request allows them. Give the evidence and estimated impact for each. Label uncertain candidates separately for the downstream verification pass; do not present them as established bugs.
```

For a single pass with no separate filter, give a concrete bar instead of a qualitative one: incorrect behavior, a failing test, or a misleading result, while excluding pure style or naming preferences. Preserve any severity limit the user explicitly requested.

## Compatibility notes

The source lists `computer_toolset_20260801` and the earlier `computer_20251124` computer-use tool, plus `browser_toolset_20260801`, on the Claude API and Google Cloud. A provider capability is not proof Atomic or another host exposes it; verify before writing a tool-dependent prompt. For computer-use screenshots, the source reports 1080p as a good performance/cost balance and 720p or 1366×768 as lower-cost alternatives, with a 2576px/3.75MP maximum; tune resolution and effort against measured task accuracy rather than defaults alone.

Test literal scope, tool triggering, review recall, and design adherence on representative cases, and compare effort changes separately from prompt changes. Preserve required checks and real permission boundaries throughout.
