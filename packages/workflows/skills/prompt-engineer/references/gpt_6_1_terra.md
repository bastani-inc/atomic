# GPT-6.1 Terra prompting and migration

Use this reference when targeting `gpt-6.1-terra` or migrating from GPT-5.6 Terra. Distilled from the GPT-6.1 Terra section and migration checklist of [OpenAI's GPT-6 guide](https://developers.openai.com/api/docs/guides/prompt-guidance#gpt-61-terra), the [model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra), the [GPT-6.1 Terra announcement](https://openai.com/index/introducing-gpt-6-1-terra), and [A model guide for the GPT-6 family](https://openai.com/index/practical-guide-building-gpt-6/), all checked October 26, 2026.

The guide's shared prompt templates address behavior observed with GPT-6 Astra, not independently established Terra behavior. OpenAI gives no Terra-specific prompt wording. Apply the shared templates only to failures you observe on Terra. The snippets below are adaptations, not verbatim OpenAI quotations.

## When to choose Terra

OpenAI positions Terra as a fast, efficient model for visual reasoning, precise computer use, and clear, natural writing. Its stated uses are matching product photos to catalog entries, comparing or interpreting technical drawings, acting on application screens, and drafting and revising text. The announcement also names high-volume automation, such as reading incoming invoices and entering their details into accounting software, and says GPT-6.1 Sol and GPT-6 Astra remain the better choice for the most complex coding tasks. Terra accepts text and image input and returns text.

This positioning is not a measured result for your workload. Compare Terra with the model you would otherwise use on representative inputs before routing work to it.

## Start with the task contract

State the result, who it is for, the relevant context and constraints, and what counts as done. For visual work, name the inputs and what to compare them against. Begin with the prompt that already works, then change one prompt or configuration variable at a time.

```text
Complete [requested outcome] using [images, screens, or documents provided].
Compare against [criteria or reference entries]. Stay within [scope].
Preserve [binding constraints] and stop before [actions requiring approval].
Return [required format], including [evidence and validation results].
If a required detail is not present or legible in the input, identify it
rather than inventing it.
```

Replace the placeholders with the actual task. A request to read or extract does not authorize submitting forms, and a drafting request does not authorize sending the text.

## Choosing reasoning effort

Terra supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`. OpenAI's advice is to start with `medium` and increase effort only if the quality improvement is worth the added time and tokens. Unlike GPT-6 Astra and GPT-6.1 Sol, Terra supports `none`.

The family model guide maps effort to work type across GPT-6 models: `low` for routine tasks such as extracting facts or making small edits, `medium` for work requiring judgment such as planning or comparing options, `high` for difficult debugging, deeper analysis, or careful review, and `xhigh` or `max` to test when `high` falls short, kept only if the improvement justifies the time and cost. The sources do not describe how sensitive Terra is to effort, so measure it rather than assuming the Sol and Luna behavior in the [GPT-6 family reference](gpt_6.md#sol-and-luna-differences) applies.

Keep the prompt fixed while comparing efforts. Do not compensate for a lower effort by adding repeated instructions; that hides which change caused the result. A prompt cannot select effort; the application's request does.

## When migrating from GPT-5.6 Terra

OpenAI's migration advice is specific: compare both models on representative images and workflows using the same reasoning effort. Preserve the current effective effort where Terra supports it. If the existing request uses `minimal`, start with `low` and compare representative tasks.

Run the unchanged prompt on both models first. Measure task success, answer correctness on your images, completion of screen workflows, tool behavior, latency, tokens, and cost per successful task. Change the prompt only for a regression you can point to, and retest after each change.

Two host changes are not prompt fixes. If the application calls tools through Chat Completions, move those requests to the Responses API; Terra supports Chat Completions only for requests without tools. When effort is not `none`, sampling and logprob parameters must be removed; see the source's [API and model parameters checklist](https://developers.openai.com/api/docs/guides/prompt-guidance#update-api-and-model-parameters).

## Computer use and screen work

OpenAI points to the [computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use) for acting on screens and the [image inputs guide](https://developers.openai.com/api/docs/guides/images-vision) for visual analysis. The family model guide, whose model and computer-use sections name Astra, Sol, and Luna but not Terra, recommends choosing the simplest reliable way to do each step: use an API or connected tool when it can do the job directly, and use computer use when the model needs to read a screen, click buttons, or fill in a form. It also recommends replacing blanket "always ask" rules with explicit boundaries for what can proceed independently.

```text
For each step, use [API or connected tool] when it can complete the step
directly. Use the screen only to read information, click, or fill in fields
that no tool covers. You may [independent actions]. Before [submitting,
sending, purchasing, or deleting], stop and show what you will submit.
```

Computer use requires the host to provide the tool and a harness that controls the browser or desktop. Naming it in a prompt does not enable it.

## Writing and revision

For drafting and revision, the family model guide recommends describing what a useful response looks like, for example plain language, technical detail suited to the audience, and a short handoff covering what changed, what was checked, and what still needs attention. Name the audience, register, length, and the facts the text must keep. The sources do not say whether Terra shares Astra's tendency toward formatted, detailed answers; use the [writing-style templates](gpt_6.md#when-responses-are-too-formatted-or-too-long) only if you observe it.

## When an Astra template addresses an observed failure

| Observed failure on your Terra task | Selective reference | Boundary to preserve |
| --- | --- | --- |
| Stops before completing authorized work, or asks non-blocking questions | [Initiative and follow-through](gpt_6.md#when-it-asks-before-doing-authorized-work) | Real approval gates, especially form submissions and external writes |
| A skill or repository instruction causes an unexplained pause | [Instruction following](gpt_6.md#when-skills-or-repo-instructions-change-behavior) | System, security, permission, and higher-priority repository rules |
| Answers are too detailed, formatted, or repetitive | [Writing style](gpt_6.md#when-responses-are-too-formatted-or-too-long) | Required fields, citations, evidence, and parser format |
| Useful independent work is not delegated | [Delegation](gpt_6.md#when-it-under-delegates-or-over-serializes-work) | Actual host capabilities, concurrency, cost, and file ownership |
| Small changes trigger repeated or unrelated verification | [Testing and verification](gpt_6.md#when-it-tests-too-broadly-or-repeats-checks) | Required project checks, safety checks, and user-requested validation |

Do not treat these as Terra tendencies merely because the templates are shared. Test the smallest applicable adjustment first.

Async tool calling, mid-turn steering, and changing effort with `configuration_update` are shared GPT-6 features that need application support. Check the [async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling), [steering](https://developers.openai.com/api/docs/guides/steering), or [reasoning configuration](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation) contract before relying on one. Fast mode and data-residency availability are deployment choices, not prompting recommendations.

## Validate one adjustment

Use representative cases for your workload: an image-matching or extraction case with a known answer, a drawing or document comparison, a screen workflow that reaches an approval boundary, a drafting or revision task, an early-stop case, and a format-sensitive answer. Compare the unchanged baseline with one adjustment at the same effort. Verify correctness against the known answers, completed workflows, output validity, respected approval boundaries, and cost per successful task. Then compare effort separately if needed. Report checks that were not run; do not claim an improvement without observed results.
