# Claude Sonnet 5.5 prompting

Distilled from [Anthropic's Sonnet 5.5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5), [What's new in Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5), and the [migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide), checked September 28, 2026. Anthropic says existing Sonnet 5 prompts should perform well unchanged and the [Sonnet 5 page](claude_sonnet_5.md) remains a reasonable starting point; for the hardest long-horizon work, it recommends an Opus model. The snippets below are adaptations, not verbatim source quotations. Use the section matching the observed behavior, not every snippet at once.

## When coding work stops to check in before it is done

At lower effort on long agentic coding tasks, the model sometimes pauses to confirm a plan, asks a question it could answer itself, or stops after one part of a multipart task. Try a higher effort level first. To keep the effort level, add a completion rule:

```text
Keep working until everything the user asked for is done. Stop to ask only when you cannot continue without the user, or before a risky step.
```

Sessions then run longer and cost more at low and medium effort. The rule does not replace your own rules about risky or irreversible actions; keep those in the system prompt.

## When coding changes include work nobody asked for

The model tends to add tests, documentation, and small supporting files that fit the repository's conventions, at every effort level and more at higher effort. The requested change itself stays close to the request. Many teams want this. If yours does not, add a scope rule:

```text
When the requested work is done and checked, stop and report. Do not add features, tests, files, docs, or refactors that were not requested. If one would help, mention it at the end instead of doing it.
```

At the highest effort levels, this rule also makes changes smaller overall.

## When high-effort runs start their own review rounds

At the highest effort levels, the model can start extra rounds of review and verification after finishing, sometimes through reviewer subagents if the harness provides them, and make related fixes it noticed along the way. Run routine work at a lower effort, where this is rare. To keep the higher effort but aim it at the task:

```text
When the requested work is done and its checks pass, stop and report. Do not start extra rounds of review or hardening on your own, and do not launch reviewer subagents unless the user asked for a review. If a deeper review seems worthwhile, say so at the end.
```

The source reports that this makes self-started review rounds less frequent without removing them entirely.

## When a request for ideas turns into a build

On an open-ended request such as "show me what you can do with this", the model can start building a presentation, report, or video when the user only wanted ideas. Say so in the request, or add:

```text
When the user asks for ideas, options, or a plan, give them that and stop. Do not build or change anything until the user says to go ahead.
```

## When JSON answers to multistep problems are wrong or do not parse

For tasks that need a few steps of working out, such as totaling figures, applying a rule, or ranking items, the model often answers without thinking first, especially at lower effort. When thinking is available, end the system prompt with:

```text
Think the problem through before you answer.
```

The line has no effect when the model runs without up-front thinking in a request without tools; use thinking for these tasks. Raising effort also helps.

If the application asks for JSON only through the prompt rather than an enforced schema, the model often works the problem out in the text and writes the JSON at the end. Have the parser take the last complete JSON value from the text, not everything from the first brace to the last, because a draft can precede the final JSON. Check the expected fields and retry once if they are missing. Treat a response that stopped at the output limit as failed even if it contains valid JSON.

## When long agentic turns look silent

Between tool calls, the model writes short notes on what it found and what it will do next. Longer notes come back as progress-update thinking blocks, which are empty by default, so a client that renders only text can look silent. A prompt cannot fix that; the application must request and render those notes, as the migration guide describes.

Then remove inherited instructions such as "hold all findings for the final response." If you want updates at predictable points, which helps most in human-in-the-loop work, say where:

```text
Before your first tool call, say in one line what you are about to do. End with a short recap of what you did and what remains.
```

If long turns still go quiet, the harness can count consecutive tool steps with no user-visible update and, after several (the source's example is five), append a one-turn system reminder after the latest tool results:

```text
The user has not heard from you in a while. Say in a few words what you are doing, then continue.
```

Stop after the second or third reminder, and leave earlier reminders in the history rather than deleting them. Frequent harness text after tool results can make the model suspect prompt injection. When the model must show exact text mid-turn, such as a code snippet or a question it needs answered, give it a simple tool for messaging the user, declared from the first request, and say to use it only for such content.

## When the model answers from memory instead of searching

On chat and knowledge-work tasks, the model sometimes answers from training knowledge when a search would catch changed details, such as what is allowed, required, or charged. First remove language that discourages tool use, such as "only use tools when strictly necessary" or "minimize tool calls." If the product exposes a search tool, add:

```text
Use the search tool to check specifics that may have changed since your training, such as what is allowed, required, or charged, even when you feel confident. For researched work such as a report or comparison, gather current sources rather than writing from training knowledge.
```

This matters most for research and support products.

## When mid-task user messages are ignored or flagged as injected

The model is trained to resist instructions that arrive through tool results and other content it reads. Text placed right after tool results can therefore be mistaken for injection, and the model may ignore a genuine user message or ask the user to confirm it. Fix the message layout rather than the prompt:

- Never put the user's words inside a tool result.
- Deliver mid-turn user input as user text after the last tool result in the same user message.
- Keep harness notices, such as reminders, in a separate system message after the user's words, never in the same block.
- In interactive sessions where users can type mid-turn, do not append your own token or budget countdown after every tool result.

If an occasional reminder of your own triggers this reaction, send it less often.

## When code changes are reported done without a real check

The model generally checks its work before reporting a change done. At low effort, it sometimes skips a check that exercises the change, for example because dependencies are not installed. If transcripts show completion claims without test or build output, add:

```text
When you change code that can be run, built, or type-checked, run a real check that exercises the change before reporting it done: the project's tests, type-checker, or build, or the changed command itself. A syntax-only check, or a check command that failed to start, does not count. If only the project's declared dependencies are missing, install them with the project's own package manager and lockfile, never with sudo or the system package manager, unless told not to. If no real check can run, say which check you did not run and why instead of reporting the change as done.
```

Drop or adjust the dependency sentence where installation is not authorized.

## When tool calls use the wrong name or parameter spelling

The model occasionally calls a declared tool by a name that differs only in letter case, such as `bash` for `Bash`, or passes a known parameter under a slightly different name. Do not treat this as fatal. The harness can accept an unambiguous match, or return a tool error that names the exact expected spelling; the model usually corrects the call on its next turn.

```text
Unknown tool "bash". Did you mean "Bash"? Call it with that exact name.
```

## When dense charts or technical drawings are misread

Give the model a way to crop, zoom, or run code on the image. For charts, tools help at every effort level and more than raising effort does. For technical drawings, they help only at higher effort. Anthropic's [crop tool recipe](https://platform.claude.com/cookbook/multimodal-crop-tool) has a working definition.

```text
Read the requested values from the supplied image. Use the image tools to inspect the relevant regions, and check axes, units, and legend before reporting a value. If a detail stays unreadable, say which one instead of guessing a precise value.
```

## Thinking, effort, tool, and refusal notes

- Effort is the main control for how much the model thinks. Levels are recalibrated, so re-run your effort evaluation instead of carrying over the Sonnet 5 setting. Anthropic suggests starting at high in general, at medium for well-specified agentic coding and multistep tool use (high for harder or longer tasks), and at medium or low for chat and latency-sensitive work.
- Asking the model in the system prompt to think less does not reliably reduce its thinking; lower effort instead. When running without up-front thinking, remove "don't think" instructions, which make internal XML tags more likely to appear in visible output.
- Forced tool choice is not available. The model decides whether to call a tool, so say in the prompt when each tool applies.
- Keep conversations append-only. Change instructions or tools by appending a system message rather than editing earlier history.
- Prefill is not available. Ask for a direct answer in the system prompt instead of prefilling a preamble, and move continuations into the user turn, for example: "Your previous response was interrupted and ended with [previous response]. Continue from where you left off."
- Remove instructions that ask the model to include its reasoning in the response; they invite reasoning-extraction refusals. Request conclusions and evidence instead. Safety classifiers can also decline requests in cyber, biology, and other usage-policy areas, and benign work occasionally triggers them. The application handles those declines through refusal handling and fallback; removing reasoning requests is the only prompt-side fix the source gives.

## Validate the selected adjustment

Compare representative cases before and after one change: a multipart coding task at your chosen effort, an open-ended request, a JSON answer to a multistep problem, a long tool loop viewed through your client, a question that depends on current facts, and a mid-turn user message. Check task completion, unrequested additions, visible updates, actual tool calls, parse success, latency, tokens, and cost. Label every check not run.
