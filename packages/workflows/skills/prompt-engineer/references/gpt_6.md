# GPT-6 family prompting and migration

Use this reference when targeting `gpt-6-astra`, `gpt-6-sol`, or `gpt-6-luna`, migrating a prompt to the GPT-6 family, or diagnosing early stops, excessive verification, under-delegation, or writing-style drift. Guidance checked on September 22, 2026 against [OpenAI's GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model). The prompt blocks labeled **OpenAI template** are quoted verbatim from that guide. Start from them, then edit the wording to fit the product's approval gates and house style.

OpenAI positions the three models by reasoning demand, latency, and cost: Astra for the highest capability and long multi-step work across code, browsers, and professional software; Sol for strong reasoning on demanding tasks; Luna for efficient, repeatable work at scale. OpenAI offers the templates below as a starting point for the whole family, but the behaviors they address were observed on Astra. Evaluate them on the chosen model and workload. See [Sol and Luna differences](#sol-and-luna-differences) before choosing effort or a tool-calling API.

## When it asks before doing authorized work

Observed behavior: Astra stays coherent through long tasks, and it is more likely than GPT-5.6 Sol and earlier models to ask for clarification where they would have made assumptions. By default it also asks non-blocking questions while it works. That helps with risky ambiguity, but it can stall work the conversation already authorizes.

Prompt adjustment: tell the model to infer scope and act, treat "can you…" requests as instructions, and leave approval until a concrete, reviewable result exists. Pick the templates that match the autonomy your application needs.

OpenAI template, for autonomous work:

```text
You should infer the user's intent and task scope from the instructions and prior conversation context. Your job is to bias towards action and carry the user's intended task to completion.

When the user expresses intent to perform new work or fix an existing issue, persist until the user's intended goal is complete. Progress autonomously towards the user's goal (e.g. creating isolated worktrees / checkouts if needed, resolving merge conflicts, read-only actions, creating draft PRs etc.) unless they are clearly destructive or irreversible.
```

OpenAI template, for follow-through when the request implies authorization:

```text
When the user's prompt indicates a request for action, such as "can you...", "I want to...", "help me..." and similar expressions, treat these as instructions to do the work and take action. Do not stop at acknowledging capability (e.g. "Yes…"), proposing a plan, or offering to continue. Do not settle for a partial or "helpful enough" solution that does not fully satisfy the user's task to save time, effort or tokens. If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.
```

OpenAI template, for asking approval only after the work is reviewable:

```text
Before asking the user clarifying questions, you should complete the work that is already authorized from context and necessary to make the proposed action concrete and reviewable. The user should be approving a concrete, reviewable result. For example, before deploying a change, writing to an external application, merging a PR or publishing a site, do all the required work first so that user approval is the final step. You don't need user permission for reversible tasks, read-only actions, reviews or fixes, or anything for which authorization is provided earlier in the session or strongly implied from the task instruction.

Do not introduce unsolicited warnings, disclaimers, approval flows, or safety/compliance checklists due to hypothetical risk.
```

Caveats: these templates widen autonomy. Keep the product's real approval gates for deployment, publishing, merging, external writes, purchases, credential changes, and irreversible actions, and state them next to the template. If the user asked for review-only work, the model must not edit. For broad exploration, name the questions and the stopping point instead of asking the model to persist indefinitely. The last sentence of the third template removes hypothetical-risk warnings; it does not remove warnings the user needs about real risks.

## When skills or repo instructions change behavior

Observed behavior: Astra follows long instructions well and is more sensitive to what is in context, including `AGENTS.md`, skills, and other files it can read. Unclear or conflicting guidance in a skill can make it pause and block work early. OpenAI strongly recommends auditing every skill and instruction file the model can access.

Prompt adjustment: state the priority between user instructions and skills, and ask the model to name the instruction that made it pause or change direction.

OpenAI template, for instruction priority:

```text
The user's instructions take precedence over guidelines provided in a skill. If explicit user instructions conflict with a skill's instructions, prioritize the user's instructions.
```

OpenAI template, for surfacing the instruction behind a pause:

```text
If a skill causes you to ask for permission or confirmation, pause, leave requested work unfinished, or diverge from the user's intent, name and link to the exact SKILL.md file you read, quote the relevant instruction, and briefly explain how it applies. Distinguish explicit skill requirements from your interpretation of guidelines.
```

Caveats: the priority template covers advisory skill text. It must not let a user instruction override system, security, permission, or repository rules that rank above the user; say so when the harness has such rules. The second template is the one to use when an application loads many skills and instruction files and you need to find silent or conflicting guidance. Use `quality_improvement.md` when conflicts repeat.

## When responses are too formatted or too long

Observed behavior: Astra tends to use lists, tables, and Markdown to make responses scannable, writes detailed answers, and can reuse the same phrases across sessions. It responds well to an explicit house style.

Prompt adjustment: specify the structure and register the application needs. Use the templates below as the starting style contract.

OpenAI template, for prose with less formatting:

```text
Default to using clear, concise paragraphs, each developing one main idea. Use lists only when the information is genuinely parallel, sequential, or easier to compare, and avoid nested lists unless the hierarchy cannot be expressed clearly in prose. Use plain, simple language: familiar words, concrete examples, and precise verbs. Prefer active voice and direct statements.

Make sure to state the main point clearly and early, then develop it with the explanation and detail the reader needs. Let each sentence build on what came before. Develop the points that matter and provide enough support to be useful.
```

OpenAI template, for technical communication:

```text
Use plain language over jargon, and reference technical details only to the degree that it helps illustrate an idea or your work to the user. Communicate complex concepts in a clear and cohesive manner, and calibrate your writing to the level of background knowledge assumed from the user's prompt and context.
```

OpenAI template, for reducing jargon and stock phrases:

```text
Avoid using slop words or phrases like "Bottom Line:" in conclusions, "delve," "foster," "leverage," "it's worth noting," "importantly," "Question? Answer." or "This isn't about X. It's about Y.", "genuinely" or hyphenated compound descriptions and adjectives. Do not use concluding summary statements such as "In short:..", "The simplest mental model is:...".

State the intended action directly. Avoid adding what you won't do, what will remain unchanged, or how you'll separate or categorize results. Do not use contrastive framing such as "X, not Y" or "X—not Y" that introduces an unprompted alternative that the user didn't ask about. Avoid invented compound labels like "exact-head checks" and "editorial-row layouts", vague qualifiers, and canned transitions; use plain verbs and prepositions to state the actual relationship directly.
```

Caveats: do not trim contractual fields, citations, validation evidence, or warnings the reader needs. For technical audiences, plain language still includes exact identifiers, commands, and API names. If a parser or UI requires Markdown, tables, or fixed headings, state that requirement after the style template so it wins.

## When it under-delegates or over-serializes work

Observed behavior: Astra is trained to divide work and delegate it to subagents that run in parallel, but it may delegate less often than a workflow expects. Messages it sends to other agents can contain grammar or spacing errors.

Prompt adjustment: tell it when and how much to delegate, and require legible inter-agent messages. It responds well to specific guidance, so tune the wording to the harness.

OpenAI template, for delegation:

```text
If at any point you can parallelize work by delegating tasks to another agent (no matter if you are the root or subagent), you should do so using collaboration tools if it could save time or improve quality.
```

OpenAI template, for legible inter-agent messages:

```text
Messages that you send to other agents and your final answer may be read by a human, so ensure they are legible. Always put proper spaces between words and/or numbers.
```

Caveats: prompting cannot create subagents or raise concurrency limits; the host must provide the collaboration tools. Add the harness's limits on concurrency, cost, and file ownership, and ask each delegate to return a bounded result with evidence. Do not split a small task only to use parallelism. Delegation does not authorize wider scope or skipped validation.

## When it tests too broadly or repeats checks

Observed behavior: on coding tasks Astra tests thoroughly before calling the work complete. On small changes that can mean broader or repeated tests than the task needs.

Prompt adjustment: calibrate how much testing a change requires and when to broaden it.

OpenAI template:

```text
Do not write tests for reversible, low-impact changes that mirror the implementation. If you do choose to verify your work with tests, make sure that the tests are meaningful and necessary to verify implementation.

Run tests appropriate to the change and complete required checks. Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it; otherwise, continue toward completing the task.
```

Caveats: this does not replace required CI-equivalent checks, safety checks, release gates, repository test rules, or validation the user asked for. Ask the model to report checks it did not run.

## Sol and Luna differences

The templates above are shared, but two things change when the target is `gpt-6-sol` or `gpt-6-luna`.

Effort sensitivity: effort moves Sol and Luna much more than it moves Astra, and both can run with no reasoning at all, which Astra cannot. Treat effort as a prompt variable: a Luna prompt tuned at medium effort may need high or max effort before it is comparable to a Sol prompt at medium, and a prompt run with no reasoning behaves like a different model. Do not compensate for a lower effort with longer instructions.

Scope of the behavior guidance: OpenAI wrote the initiative, instruction-following, writing-style, delegation, and verification templates against Astra's behavior. Sol and Luna are cheaper to sweep, so measure whether the early-stop and over-testing templates are needed at all before adding them. A Luna prompt that carries Astra's autonomy language without the matching capability can keep going on work it cannot finish. Keep the same approval gates.

## Prompt structure notes

- Caching: keep the prompt prefix stable. When effort changes between turns, change it without rewriting the original instructions so the cached prefix survives.
- Async tool calls and mid-turn steering need host support. Mentioning them in a prompt does not enable them.
- Approval pauses after migration: if the model keeps asking for approval, apply the templates in [When it asks before doing authorized work](#when-it-asks-before-doing-authorized-work) first.

## Validate the prompt change

Compare a normal task, an early-stop case, a style-sensitive answer, a permission-boundary case, and a small coding change. Check whether the model completes authorized work, asks only blocking questions, names instruction conflicts, delegates only where useful, verifies proportionately, and respects forbidden actions. Change one template, model, or effort variable at a time so regressions have an identifiable cause. Do not claim measured improvement without running representative comparisons.
