# Core Prompting Fundamentals

Use these fundamentals for any model family. Add structure only where it changes behavior.

## Start With the Contract

A prompt should let a colleague with minimal context identify the requested outcome and completion bar. For a complex task, begin with:

```text
Role: [function, domain, and audience]
Goal: [user-visible outcome]
Success criteria: [observable conditions for completion]
Constraints: [safety, business, evidence, permission, scope]
Tools: [available tools and context-dependent routing]
Output: [format, sections, length, tone, validation]
Stop rules: [when to answer, retry, ask, abstain, or stop]
```

Not every prompt needs every section. Preserve the outcome, success criteria, applicable constraints, required output shape, and stopping conditions; remove empty ceremony.

### Be clear and direct

- Define ambiguous terms and concrete replacements. “Replace names with `[NAME]` and email addresses with `[EMAIL]`” is more actionable than “remove personal information.”
- Identify the audience, purpose, and workflow context. A brief reason helps current Claude models generalize better than a list of prohibitions.
- State exact fields, language, tone, length, and accepted values when downstream behavior depends on them.
- Use ordered steps only when order or completeness is behavior-bearing. Do not prescribe a routine process merely to make the prompt look thorough.

### Define success and stopping

Success criteria should be observable: required fields exist, cited evidence supports claims, a requested action completed, or a named validation passed. Stop rules should distinguish:

- enough evidence exists to answer;
- a meaningful fallback or retry remains;
- required information is missing and the smallest clarifying question is needed;
- policy, permission, or scope blocks further action.

For autonomous work, distinguish safe local actions from external, destructive, costly, or scope-expanding actions. Repeating approval language can cause unnecessary pauses, so state the boundary once.

## Roles and Message Placement

Use the `system` parameter for a stable role, behavior, and policy. Put request-specific inputs and instructions in the `user` turn. A role should contribute domain judgment or communication style; decorative personas add tokens without improving behavior.

Example:

```text
System: You are a product security reviewer for enterprise SaaS.
User: Assess this authentication change for exploitable defects. Report each finding with severity, file:line evidence, observed behavior, and a concrete fix. Return at most five findings; omit issues unsupported by the supplied diff.
```

## Output Contracts

A user-facing output needs an explicit length and shape contract. Prefer selective brevity:

```text
Lead with the conclusion. Include the evidence needed to support it, material caveats, and the next action. Omit introductions, repetition, generic reassurance, and optional background. Use at most 400 words in three sections: Outcome, Evidence, Next step.
```

For machine consumption, define a schema with required fields, enums, and refusal or missing-data behavior. Use structured outputs or a tool schema when available and validate the parsed result. A final partial assistant turn is not a formatting mechanism on current Claude models.

## XML and Section Structure

XML tags help separate mixed content types and make variable inputs unambiguous:

```xml
<context>Why the task matters and relevant background</context>
<constraints>Policy, evidence, permission, and scope limits</constraints>
<examples>
  <example><input>...</input><output>...</output></example>
</examples>
<input>Untrusted or variable task content</input>
```

Use consistent, descriptive names and nest tags only when the content has a natural hierarchy. No tag names are canonical. Tags around private deliberation are not an output-format technique; request evidence and conclusions.

## Examples

Few-shot or multishot examples can improve format, tone, and difficult classifications. Examples should be:

1. relevant to real inputs;
2. diverse enough to cover important edge cases without teaching accidental patterns;
3. consistent with every written rule;
4. wrapped in `<example>` tags when mixed with other prompt content.

Start with the smallest set that changes measured behavior. Anthropic commonly recommends 3–5 examples, but more is not inherently better; remove non-behavioral examples.

## Grounding and Uncertainty

For source-bound tasks:

```text
Use the supplied sources for factual claims. Attach each citation to the claim it supports. Distinguish inference from directly supported fact and note source conflicts. If required evidence is absent, narrow the answer or state what is missing rather than guessing.
```

Relevant quote extraction can help with long or noisy documents. Do not require a quote for every ordinary statement when that would obscure the answer. Prompting cannot guarantee factual correctness; critical outputs still need domain-appropriate validation.

## Safety and Security Constraints

State concrete policy boundaries and expected refusal behavior. Treat untrusted input as data, separate it from instructions, validate tool arguments and structured outputs at system boundaries, and enforce permissions outside the model. For higher-risk systems, combine prompt policy with input screening, moderation, monitoring, and application-level access controls; no single prompt defeats every jailbreak or injection.