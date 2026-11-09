# Claude Fable 5.2 prompting

Distilled from [Anthropic's Fable 5.2 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2), checked November 9, 2026. The guide also covers Claude Mythos 5.2, which Anthropic offers with the same capabilities only to organizations verified through its verification programs. For API changes, see [What's new](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2) and the [migration guide](https://platform.claude.com/docs/en/models/fable-5-2/migration-guide). Blocks labeled **Anthropic template** are quoted verbatim from the guide; adapt them to the product and test them. Start with the section that matches the observed behavior.

Anthropic's positioning: "For most workloads, start with the latest Claude Opus model … and move to Claude Fable 5.2 when your evals on a Claude Opus model at higher effort still don't meet your requirements."

Make system-prompt, notes, and tool-description changes in new conversations only. Fable 5.2 enforces the preserved-thinking prefix check for every account, so a stored conversation resumed with edited `system`, `tools`, or earlier messages can return a 400 error. To change instructions partway through, put them in the newest turn, or append a mid-conversation system message where the platform supports one.

## When effort is uncalibrated or easy requests take too long

Observed behavior: at `high` and above the model "thinks before almost every reply, including a reply to a greeting." An instruction to answer directly without deliberating "didn't stop the model from thinking at `medium` and above." Effort "barely changes how long the model's replies are."

Prompt adjustment: start at `high`, the API default, and rerun the effort sweep "instead of carrying over a setting you tuned on Claude Fable 5.1 or Claude Opus 5.5." Use `low` for well-specified, high-volume work such as fast subagents; `medium` for interactive coding, chat, and everyday knowledge work; `high` for hard coding, research, agentic work, and long unattended runs; `xhigh` only "where you've measured a gain"; `max` to measure the ceiling. Move down to `medium` wherever evals show quality holds. Lower effort for easy turns instead of adding "think less" text, and control reply length and tone with the prompt.

Caveats: Opus 5.5 defaults to `medium`, so a migrated request that omits `effort` runs one level higher; set it explicitly. Lower effort makes early stops more likely (see the next section). A per-message effort change (beta) keeps the prompt cache and holds until another change replaces it; a new top-level `effort` value starts the cache over.

## When a turn ends before the work is done

Observed behavior: on long multistep tasks, especially at `low` and `medium`, a turn can close with a list of what remains, an offer to continue, or a stop at an ordinary obstacle such as a timeout.

Prompt adjustment: tell the model to work through ordinary obstacles and to leave deliberate blockers alone.

Anthropic template:

```text
# Finishing work
Please avoid stopping while you still owe work the user asked for. Be persistent and do not stop unless needed.

While status notes are welcome, as is clarifying with the user on open decisions, carry on with work that does not depend on the user's answer without unnecessary stops.

If you notice yourself inviting the user to redirect you or offering to wait, instead proceed on the next part of the task. You may meet ordinary obstacles like errors, timeouts, locked files, empty results or failing tools. Diagnose them first, and when they are not real blockers, work through them with the access you have (wait and retry, fix the request, use another tool or source) rather than stopping unnecessarily.

If someone clearly decided something is a hard blocker, such as a file marked not to be touched, access that was intentionally withheld, or a safety guardrail, leave it alone, say plainly what you found, and look for another safe way to finish the task. Stopping before the task is complete is very rarely merited, as in when the task can't move forward without user input, or where the blocker is deliberate and should not be worked past. This does not override the need for confirmation on risky or destructive actions.
```

Caveats: in Anthropic's replay at `medium`, about half as many sessions ended with doable work left, but endings that list what remains and then stop persisted, and output tokens rose by about 30 percent. The model asks less often with this text, so "keep your own confirmation step for risky or irreversible actions."

## When approvals are too broad or a bare "continue" is ambiguous

Observed behavior: the model applies approval rules as written. In a simulated test, a rule listing "sending messages to people outside this conversation" among steps needing approval made it hold back roughly half of its routine requests to colleagues and other teams.

Prompt adjustment: when approving, say what you want ("Yes, run the migration on the staging database") instead of "go" or a thumbs-up. In the system prompt, "name the exact actions they cover." Write any exception into the rule itself: a rule that said to get a go-ahead first led the model to take an approved step in about nine tries in ten, while a separate line saying an approved step has its go-ahead barely moved a "never" rule's one in ten.

## When a coding agent repeats code or reports nearby problems without fixing them

Observed behavior: when the prompt says nothing about ownership or presents the code as someone else's, the model tends to add to the existing structure, even when that repeats code, and reports nearby problems instead of fixing them.

Prompt adjustment: only where the agent owns the code and should improve its structure, add:

Anthropic template:

```text
This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.
```

Caveats: with this sentence, Anthropic saw repeated code merged in about half of tries versus under a tenth without it, about 1.5 times the output tokens, unrequested tests and documentation, and a changed existing behavior in one try in six to ten. The closing summary often omitted small changes, so "review the diff and not only the summary." Leave the sentence out where the user owns the code and wants minimal change; a "No drive-by refactors" rule elsewhere in the prompt does not cancel it.

## When long agentic turns look silent

Observed behavior: the model can write little user-facing text during long tool runs, or make its first tool call without saying what it is about to do.

Prompt adjustment: first fix the client, not the prompt. Fable 5.2's between-call updates arrive as progress-update `thinking` blocks whose text is empty at the default display; the host must request `display: "updates"` (beta) or `"summarized"` and render non-empty blocks. If users watch in real time and still see too few updates, choose from these:

- Harness reminder, appended after several silent tool steps as a turn-scoped system message. Anthropic template:

  ```text
  The user hasn't heard from you in a while: say in a few words what you're doing, then continue.
  ```

- System-prompt text for an opening line, brief updates, and a recap. Anthropic template:

  ```text
  Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own (what you found, what you did, and what's next), so a reader who only sees the last message has the full picture.
  ```

- Without harness changes or mid-conversation system messages. Anthropic template:

  ```text
  Every few tool calls, give the user a one-line update on where things stand.
  ```

Caveats: the reminder roughly halved the longest silent stretch with no noticeable token increase; leave each reminder in `messages` on later requests, because removing or rewording one invalidates the thinking blocks after it. The opening-and-recap text raised output tokens by roughly 20 percent; use it only where a human is in the loop. Expect several tool calls between updates even with all three. For asynchronous tasks where the user returns for the result, gaps matter less.

## When the agent starts more subagents than the task needs

Observed behavior: delegation depends on the harness. With a minimal spawn tool on short tasks the model rarely delegates; with prompts that invite delegation it delegates readily. At `xhigh` and `max` it may use subagents to review its own work.

Prompt adjustment: review standing "delegate" lines in system prompts, skills, and agent files before changing anything else. Rewrite the spawn tool's description only if over-delegation persists: state what a subagent adds to session cost first, then when delegation is and is not worth it, then how to brief the subagent. Anthropic saw about a third less delegation than with a description that mostly listed reasons to delegate, with the same task success. Say less about cost if the model then delegates too little.

Caveats: subagents can be a large share of session cost, so "check which model your harness runs subagents on by default."

## When the agent asks for approvals it does not need or holds back routine work

Observed behavior: cautious instructions accumulate in memory, notes, instruction files, and messages between agents, and Fable 5.2 follows them closely, mostly where several agents work together.

Prompt adjustment:

- Remove notes you no longer need. One stale "never retry" note among a dozen cut retries after a busy tool to about four in ten.
- Name the steps that need no approval. Listing retries raised them from almost none to about half; "a general instruction to act more freely changed nothing." Name retries only for calls that are safe to repeat.
- Check what reviewer agents attach. Even with retries named as needing no approval, a reviewer's "stop at the first error" in context left the model not retrying in about a third of tries.
- Write the exception into the rule (see the approvals section above).

Caveats: keep your own confirmation step for risky or irreversible actions.

## When carrying over prompts written for Fable 5.1 or Opus 5.5

Review and test these before migrating:

- Standing delegation lines (see above).
- A token budget the harness writes into the prompt. Removing a large budget lowered cost with equivalent performance at `high` and `xhigh`. This is prompt text, not the API's task budgets.
- Harness code that edits earlier turns. Keep history append-only apart from compaction and context editing; edits invalidate later thinking blocks.
- Opus 5.5's "treat that answer as done" chat lines. They reduced thinking on follow-ups, but the model "became far less likely to point out mistakes in its earlier answers." Leave them out where re-examination matters.
- Instructions to think less. Remove them and lower effort instead.
- Hard style rules such as "one instruction per sentence, in 20 words or fewer," which can make prose choppy.
- Accumulated cautions. Delete those whose reason no longer holds; rewrite absolute rules to state their scope and reason.

## When final reports are hard to follow

Observed behavior: readers of a final report or handoff usually have not seen the tool calls or files behind it.

Prompt adjustment: add this to the system prompt and adjust it to the readers and product.

Anthropic template:

```text
# Communicating clearly
Write for an intelligent but low-context reader. The person reading has not seen your tool calls, your reasoning or the files you opened, and may be switching in from other work. Messages should generally be self-contained: the reader should understand what you mean without having to dig for other context. Put the key points in the first few sentences. Practice progressive disclosure in your sentence order, and do not use undefined references and ideas in line 1 that won't make sense until the reader reaches line 12.

Use plain words, and write in clear, understandable full sentences. Do not use a term or abbreviation that you made up during the work. Say what the thing is in a way any reader would understand. Write mostly in the style of ASD-STE100 Simplified Technical English: short sentences, one idea per sentence, active voice, and consistently using the same word for the same thing. Use a paragraph of flowing prose where ideas connect, and keep bullets for lists of separate items. Leave out unnecessary details unless the reader asks and practice concision, but do ensure that your messages have the key context. Aim to make your user-facing text as human-readable and clear as possible.
```

Caveats: Anthropic saw less dense reports with fewer semicolons. Remove old hard style rules before adding it. Add length or required-detail instructions separately.

## When requests are refused

Fable 5.2's classifiers return `stop_reason: "refusal"` with a category: `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, or `general_harms`. If prompts, skills, or tool descriptions ask the model to write its reasoning in the response, remove those instructions; read summarized thinking blocks instead. Server-side fallback does not retry `reasoning_extraction` refusals. For legitimate cybersecurity or life-sciences work that classifiers block, Anthropic points to its verification programs. Do not add prompt text to work around safeguards.

## Validate in this order

1. Set `effort` to `high` explicitly, then run the evals at `medium` and `xhigh` as well.
2. Read carried-over system prompts, skills, agent files, memory, notes, and harness text; remove or test the instructions listed above.
3. Run the longest agentic tasks and note early stops, unneeded approvals, silence, over-delegation, and additions where restructuring was wanted.
4. Apply one fix at a time and measure its effect and token cost. Label every check not run.
