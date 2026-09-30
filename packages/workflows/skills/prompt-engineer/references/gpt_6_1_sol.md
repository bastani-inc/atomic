# GPT-6.1 Sol prompting and migration

Use this reference when targeting `gpt-6.1-sol` or migrating from `gpt-6-sol`. Distilled from [OpenAI's GPT-6 Astra and GPT-6.1 Sol guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#gpt-6-astra-gpt-61-sol), checked September 30, 2026. OpenAI recommends Sol 6.1 for complex coding, computer use, and professional work when balancing quality and cost. Compare models on your own tasks; this positioning is not a measured improvement for your workload.

The source separates Sol 6.1 specifications and migration guidance from shared prompt templates. Those templates address behavior observed with Astra, not independently established Sol 6.1 behavior. Apply them only to failures you observe on Sol 6.1. The snippets below are adaptations, not verbatim OpenAI quotations.

## Start with the task contract

Keep the outcome, relevant context, task boundaries, evidence, output format, and completion criteria explicit. Begin with the prompt that already works, then change one prompt or configuration variable at a time. Do not add every Astra template during migration.

```text
Complete [requested outcome] using [relevant context]. Stay within [scope].
Preserve [binding constraints] and stop before [actions requiring approval].
Return [required format], including [evidence and validation results].
If a required fact is unavailable, identify it rather than inventing it.
```

Replace the placeholders with the actual task. A review-only request does not authorize implementation, and a local coding request does not authorize publishing or external writes.

## When migrating effort from GPT-6 Sol

OpenAI says to preserve the current effective reasoning effort where supported. Sol 6.1 supports `low`, `medium`, `high`, `xhigh`, and `max`; its API default is `medium`. It does not support `none` or `minimal`. When migrating either unsupported value, start with `low` and compare representative tasks.

This is migration guidance, not a recommendation to run every Sol 6.1 task at high or max effort. The older [GPT-6 family guide](gpt_6.md#sol-and-luna-differences) discusses the original Sol and Luna models; its no-reasoning advice does not carry over to Sol 6.1. A prompt cannot enable an unsupported effort or substitute for the application's request configuration.

Keep the prompt fixed while comparing supported efforts. Measure completion, answer correctness, tool behavior, latency, tokens, and cost. Avoid compensating for a configuration change by appending repeated instructions, because that obscures what caused the result.

## When an Astra template addresses an observed failure

OpenAI offers the following templates across the GPT-6 family, but explicitly says their underlying behavior was observed on Astra. The existing family reference preserves those official templates and their caveats:

| Observed failure on your Sol 6.1 task | Selective reference | Boundary to preserve |
| --- | --- | --- |
| Stops before completing authorized work, or asks non-blocking questions | [Initiative and follow-through](gpt_6.md#when-it-asks-before-doing-authorized-work) | Real approval gates, review-only scope, and irreversible-action limits |
| A skill or repository instruction causes an unexplained pause | [Instruction following](gpt_6.md#when-skills-or-repo-instructions-change-behavior) | System, security, permission, and higher-priority repository rules |
| Answers are too detailed, formatted, or repetitive | [Writing style](gpt_6.md#when-responses-are-too-formatted-or-too-long) | Required fields, citations, evidence, and parser format |
| Useful independent work is not delegated | [Delegation](gpt_6.md#when-it-under-delegates-or-over-serializes-work) | Actual host capabilities, concurrency, cost, and file ownership |
| Small changes trigger repeated or unrelated verification | [Testing and verification](gpt_6.md#when-it-tests-too-broadly-or-repeats-checks) | Required project checks, safety checks, and user-requested validation |

Do not treat these as Sol 6.1 tendencies merely because the template is shared. Test the smallest applicable adjustment first. For example, an early-stop case can use:

```text
Continue the authorized, in-scope work until [completion criteria] are met.
Ask only when missing information blocks progress, or before [approval boundary].
Report what completed, its evidence, and anything still blocked.
```

For output style, name what the response must retain instead of relying only on "be concise":

```text
Lead with [conclusion]. Include [required facts, evidence, and material caveats].
Use [format and length]. Omit repetition and background that does not affect
what the reader should do next.
```

## When a prompt assumes unavailable tool or conversation support

Sol 6.1 tool calling requires the Responses API; Chat Completions supports requests without tools. If a migrated prompt asks for tools but the application cannot execute them, fix the integration rather than adding stronger tool-use wording. Keep API configuration outside the prompt.

The official guide also describes shared GPT-6 async tool calling, mid-turn steering, and changing reasoning effort while preserving the prompt cache. These require application support. Do not assume Atomic or another host implements each feature because a prompt names it. Check the relevant [async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling), [steering](https://developers.openai.com/api/docs/guides/steering), or [reasoning configuration](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation) contract before relying on it.

For application migration details, consult the source's [API and model parameters checklist](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#gpt-6-astra-migration-quickstart). It covers unsupported sampling and logprob parameters during reasoning, cache configuration changes, and feature compatibility. Those are host changes, not extra prompt instructions. Astra's monitoring and speed-availability descriptions are not Sol 6.1-specific prompting recommendations.

## Validate one adjustment

Use a representative normal task, a multipart coding task, an early-stop case, an instruction-conflict case, a format-sensitive answer, and a permission-boundary case. Compare the unchanged baseline with one adjustment at the same effort. Verify actual completion and output validity, required evidence, tool calls, proportional checking, and respected approval boundaries. Then compare effort separately if needed. Report checks that were not run; do not claim an improvement without observed results.
