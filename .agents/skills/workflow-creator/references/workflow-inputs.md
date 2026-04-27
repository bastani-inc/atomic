# Workflow Inputs

Workflows collect structured data from the user at invocation time through
a single uniform API: `ctx.inputs` (and `s.inputs` inside stage
callbacks). This reference covers how the inputs pipe works, how to
declare input schemas, and how values reach the workflow from the CLI
and the interactive picker.

## The inputs pipe

Every workflow run receives a typed inputs object. When the workflow
declares an `inputs` schema, only the declared field names are valid
keys — accessing undeclared fields is a compile-time error. The
runtime populates it from whichever invocation surface the user chose.

### Input precedence (highest → lowest)

CLI flags always win. Under them, the order depends on the composition shape:

- **Single-workflow worker** (`runWorkflow({ workflow })`):
  ```
  CLI flags > runWorkflow({ workflow, inputs }) > defineWorkflow defaults
  ```
- **Multi-workflow cli** (`iterating registry, with inputs })`):
  ```
  CLI flags > runWorkflow({ workflow, inputs }) > runWorkflow({ inputs }) > defineWorkflow defaults
  ```

With ``, the CLI-flags layer is skipped entirely — `inputs`
become the top-of-chain value. Use this from tests or any programmatic
caller that doesn't want its host process argv parsed.

`defineWorkflow` field `default` is always the final fallback if no
higher-precedence value supplies one.

### Invocation surfaces

| Surface | How values are supplied | How they land in `ctx.inputs` |
|---|---|---|
| **Single-worker, positional** — `bun run src/claude-worker.ts "fix the bug"` | The dev wires a `[prompt...]` Commander argument; the collected string is passed as `prompt` | `{ prompt: "fix the bug" }` |
| **Single-worker, structured** — `bun run src/claude-worker.ts --research_doc=notes.md --focus=standard` | The dev registers one `--<field> <value>` option per declared input via `getInputSchema(wf)` | `{ research_doc: "notes.md", focus: "standard" }` |
| **Multi-workflow CLI** — `bun run src/cli.ts gen-spec --research_doc=notes.md` | The dev registers one Commander subcommand per workflow; the subcommand's `--<field>` options match the workflow's declared inputs | Same as above |
| **Interactive picker** — `atomic workflow -a claude` (atomic builtins only) | User fills in a form rendered from the declared schema | Whatever the user typed, keyed by field name |
| **Picker in user app** — dev mounts `WorkflowPickerPanel` from `@bastani/atomic/workflows/components` | Same form-based collection, against the dev's own registry | Same as above |
| **Programmatic** — `runWorkflow({ workflow, inputs })` | Plain `Record<string, string>` passed directly — no argv parsing | Top-of-chain value; falls back to `defineWorkflow` defaults |

Workflow code is the same either way — it always reads
`ctx.inputs.<name>`. The invocation surface is a CLI concern, not a
workflow concern.

### CLI flags in user-app CLIs

`runWorkflow` and `createRegistry`/`listWorkflows` are pure SDK primitives —
they do not auto-register CLI flags. It is the developer's responsibility to
wire flags using whatever CLI library they prefer. The canonical pattern is to
iterate `getInputSchema(wf)` and call `.option(--<name> <value>)` for each
declared input. See §"Scaffold a new workflow from scratch" in `SKILL.md` for
the full template.

The atomic CLI builds its own per-input flags internally by iterating
`getInputSchema(wf)` when the user passes `-n <name> -a <agent>`. That is
atomic's own implementation, not an SDK feature.

## Reading inputs

Workflows that accept a user prompt should declare it explicitly as an
input. Destructure it once at the top of `.run()` so every stage can
close over a bare string:

```ts
defineWorkflow({
    name: "answer",
    source: import.meta.path,
    description: "Single-turn answer",
    inputs: [
      { name: "prompt", type: "text", required: true, description: "question to answer" },
    ],
  })
  .for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    await ctx.stage({ name: "answer" }, {}, {}, async (s) => {
      await s.session.query(prompt);
      s.save(s.sessionId);
    });
  })
  .compile();
```

For structured workflows, read each declared field by name. Pull them
out of `ctx.inputs` once for readability and so downstream stages can
close over locals:

```ts
defineWorkflow({
    name: "gen-spec",
    source: import.meta.path,
    description: "Convert a research doc into a detailed execution spec",
    inputs: [
      { name: "research_doc", type: "string", required: true },
      {
        name: "focus",
        type: "enum",
        required: true,
        values: ["minimal", "standard", "exhaustive"],
        default: "standard",
      },
      { name: "notes", type: "text" },
    ],
  })
  .for("claude")
  .run(async (ctx) => {
    const { research_doc, focus } = ctx.inputs;
    const notes = ctx.inputs.notes ?? "";

    await ctx.stage({ name: "write-spec" }, {}, {}, async (s) => {
      await s.session.query(
        `Read ${research_doc} and produce a ${focus} spec.` +
          (notes ? `\n\nExtra guidance:\n${notes}` : ""),
      );
      s.save(s.sessionId);
    });
  })
  .compile();
```

The nullish coalescing on `notes` handles the optional field case —
declared-but-unset inputs resolve to `undefined` unless they have a
`default`.

**Style convention.** Inside a stage callback, both `s.inputs.<name>` and
`ctx.inputs.<name>` resolve to the same value. Either of these patterns
works:

- **Destructure once at the top of `.run()`** so each stage closes over a
  bare local. Best when many stages reference the same input.
- **Inline access** with `(s.inputs.<name> ?? "")` at each call site. Best
  for short workflows or when each stage uses a different field.

Pick whichever reads cleaner for your workflow. Examples in other reference
files use the inline form for brevity in focused snippets.

## Declaring an input schema

Pass an `inputs` array to `defineWorkflow({ ... })`. Each entry is a
`WorkflowInput`:

```ts
interface WorkflowInput {
  /** Field name — becomes the CLI flag (`--<name>`) and form label. */
  name: string;
  /** Input kind: string | text | enum */
  type: "string" | "text" | "enum";
  /** Whether the field must be non-empty before the workflow can run. */
  required?: boolean;
  /** Short description shown as the field caption. */
  description?: string;
  /** Placeholder shown when the field is empty. */
  placeholder?: string;
  /** Default value — enums use this to pick their initial value. */
  default?: string;
  /** Allowed values — required when `type` is `"enum"`. */
  values?: readonly string[];
}
```

### Picking a field type

| Type | Use when | Picker renders as | Example |
|---|---|---|---|
| `string` | Short single-line values — identifiers, file paths, branch names | Single-row text input | `research_doc: "notes.md"` |
| `text` | Longer free-form prose — specs, prompts, extra context | Multi-row text area | `spec: "Build a..."` |
| `enum` | A fixed set of allowed values | Radio-button row | `focus: "standard" \| "minimal" \| "exhaustive"` |

Rule of thumb: use `enum` whenever there's a closed set of options — it
gives users discoverable choices instead of making them remember magic
strings, and the CLI will reject invalid values at parse time.

### Validation enforced by the runtime

The `defineWorkflow` builder validates the schema at compile time and
rejects authoring mistakes immediately — you won't discover them in
production:

- **Input names must be valid CLI flag tails** — start with a letter,
  then letters/digits/underscores/dashes. `1bad` is rejected because
  `--1bad` isn't a parseable flag.
- **Enum inputs must declare `values`** — an enum with no choices is
  always invalid.
- **Enum `default` must be in `values`** — prevents drift between the
  default and the allowed set.
- **No duplicate names** — two inputs with the same `name` shadow each
  other and are rejected.

At invocation time, the CLI does a second pass to catch runtime errors
before spinning up any tmux session:

- **Required fields must be non-empty** (whitespace-only strings are
  treated as empty). Missing required fields produce a clear
  `Missing required input --<name>` error and exit non-zero.
- **Enum values must be in the allowed list.** `--focus=bogus` produces
  `Invalid value for --focus: "bogus". Expected one of: minimal, standard, exhaustive.`
- **Unknown flags are rejected.** A `--random_flag=value` that isn't in
  the schema produces `Unknown input --random_flag` with the valid
  flag list appended.

This validation runs before any workflow code, so a malformed
invocation can never reach your `.run()` callback in a half-filled
state.

## Declaring a prompt input

Workflows that accept a user prompt should declare it explicitly in their
`inputs` array rather than relying on an implicit key:

```ts
inputs: [
  { name: "prompt", type: "text", required: true, description: "task to perform" },
]
```

Declaring `prompt` explicitly gives compile-time safety — `ctx.inputs.prompt` is typed and accessing an undeclared key is a type error. For atomic builtins you can still pass a positional string (`atomic workflow -n ralph -a claude "fix the bug"`); user-app workers handle positional args however the dev wired their Commander entrypoint (e.g., `program.argument("[prompt...]", ...)`), and the collected string is passed as the `prompt` input value.

For workflows that need both a free-form prompt AND structured parameters,
declare all fields in the schema:

```ts
inputs: [
  { name: "prompt", type: "text", required: true, description: "what to build" },
  { name: "focus", type: "enum", required: true, values: ["minimal", "standard", "exhaustive"], default: "standard" },
  { name: "notes", type: "text", description: "extra context" },
]
```

## Reserved input names

The following input names are rejected by `defineWorkflow` because they
collide with the atomic CLI's `workflow` subcommand flags and management
subcommands:

```
name, agent, detach, list, help, version, session, status
```

The first six (`name`, `agent`, `detach`, `list`, `help`, `version`) collide
with the atomic CLI's `workflow` subcommand flags (`-n/--name`,
`-a/--agent`, `-d/--detach`, `-l/--list`, `-h/--help`, `-v/--version`).
The last two (`session`, `status`) collide with the atomic CLI's management
subcommands (`atomic workflow session …`, `atomic workflow status`).

Declaring an input with any of these names throws at `defineWorkflow` time
(before the workflow can be registered into any registry):

```
[atomic] defineWorkflow: input name "name" is reserved by the worker CLI.
Rename it. Reserved names: name, agent, detach, list, help, version, session, status.
```

This is enforced in `defineWorkflow`, not at runtime, so the error surfaces
at workflow authoring time — the workflow cannot be registered.

User-app CLIs built on the SDK primitives are **not** bound by these
reservations at runtime. The check exists only to keep workflows portable
to the atomic CLI without needing to rename inputs later.

## The interactive picker

### Atomic builtins — `atomic workflow -a <agent>`

`atomic workflow -a <agent>` (no `-n`) launches the interactive picker for
atomic builtins (TTY only — non-interactive contexts skip straight to
`--help`). All direct attached or detached builtin runs should include
`-n <workflow-name>` explicitly; omitting `-n` is the intentional
picker-discovery path.

The picker is the `WorkflowPickerPanel` component from
`@bastani/atomic/workflows/components`. It:

1. Calls `registry.list()` and filters to workflows whose `agent` field
   matches `<agent>`. No source labels — registry entries are just
   workflows someone registered; where they came from is irrelevant.
2. Shows a Telescope-style fuzzy list. The user types to filter,
   arrows (or ⌃j/⌃k) to navigate, ↵ to lock in a selection.
3. Renders the selected workflow's form. One field per declared input,
   type-specific rendering (`string` → single-row input, `text` →
   multi-row textarea, `enum` → radio row). Free-form workflows
   (no declared inputs) fall back to a single `prompt` text field.
4. Validates required fields on ⌃d. If any are empty, focus jumps to
   the first invalid field.
5. Confirms with a y/n modal, then tears down the picker and hands
   off to the workflow executor — same live-run surface users see
   when they invoke the workflow with `-n` directly.

The picker is the preferred discovery path for users who don't remember
flag names. Structured workflows benefit the most from it because the
form teaches the schema as the user fills it in.

### User apps — mount `WorkflowPickerPanel` yourself

`runWorkflow` does **not** auto-launch a picker. If a user app wants a
picker UX, the developer mounts `WorkflowPickerPanel` from
`@bastani/atomic/workflows/components` against their own registry:

```ts
import { WorkflowPickerPanel } from "@bastani/atomic/workflows/components";

const panel = await WorkflowPickerPanel.create({ agent: "claude", registry });
const result = await panel.waitForSelection();
panel.destroy();
if (result) {
  await runWorkflow({ workflow: result.workflow, inputs: result.inputs });
}
```

Single-workflow workers have no picker — the file already identifies the
workflow, so the user just passes the declared `--<input>` flags directly.

## Duplicate registration

Registering the same `${agent}/${name}` key twice throws at composition-root
time (before any workflow runs):

```
[atomic] Duplicate workflow registration: "claude/my-workflow" is already registered.
```

There is no silent shadowing. Pick distinct `(agent, name)` pairs across all
workflows in the registry. For the full key-scheme and validate-on-register
contract see `registry-and-validation.md`.

## Invocation details

See SKILL.md §"Invocation surfaces" for the full table. This section covers
flag-parsing nuances specific to structured inputs.

Both `--flag=value` and `--flag value` forms are accepted by Commander. Short
flags (`-x value`) are NOT parsed as structured inputs — only long-form
`--<name>` flags resolve against the schema.

For user-app CLIs, the dev wires the flags via `getInputSchema(wf)` and
Commander; there is no `-n`/`-a`/`-d` built into user-app workers. If the
dev wants detached runs, they pass `detach: true` to `runWorkflow` or wire
their own `--detach` Commander option.

```bash
# User's own app — single-workflow worker
bun run src/claude-worker.ts --focus=standard --research_doc=notes.md
bun run src/claude-worker.ts --focus standard --research_doc notes.md

# User's own app — multi-workflow CLI
bun run src/cli.ts gen-spec --focus=standard --research_doc=notes.md

# Atomic builtins — use atomic CLI's -n/-a/-d flags
atomic workflow -n gen-spec -a claude --focus=standard --research_doc=notes.md
atomic workflow -n gen-spec -a claude -d --focus=standard    # detached
```

## Pitfalls

### Declare every field you access

With typed inputs, accessing `ctx.inputs.foo` when `foo` is not declared
in the workflow's `inputs` array is a compile-time error. If your workflow
needs a prompt field, declare it:

```ts
inputs: [
  { name: "prompt", type: "text", required: true, description: "task prompt" },
]
```

If the developer has wired a `[prompt...]` Commander argument in their
entrypoint, the collected string is passed as the `prompt` input value —
but only if the workflow actually declares a `prompt` input. Accessing
`ctx.inputs.prompt` without declaring it is a compile-time error. The
atomic CLI applies the same rule for builtins: a positional string is
rejected if the builtin workflow does not declare a `prompt` input.

### Don't rename inputs across workflow versions

Declared input names are part of the workflow's public API — they map
directly to `--<name>` flags and field identifiers in the picker.
Renaming a field is a breaking change for any script that invokes the
workflow. If you need to rename, add the new name alongside the old,
migrate callers, then remove the old name in a later change.

### Don't put secrets in `default`

Defaults are visible in the picker and printed in CLI errors. They're
fine for values like `"standard"` but not for API keys or auth tokens.
Read those from environment variables inside the workflow instead.
