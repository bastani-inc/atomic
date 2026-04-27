# Registry and Validation

## `createRegistry()`

Factory for an empty, immutable, chainable workflow registry.

```ts
import { createRegistry } from "@bastani/atomic/workflows";

const registry = createRegistry()
  .register(myClaudeWorkflow)
  .register(myCopilotWorkflow);
```

Each `.register()` call returns a **new** registry — the original is unchanged.
This makes the registry safe to share and compose.

## Key scheme

Every registered workflow is identified by the composite key:

```
${agent}/${name}
```

Examples: `"claude/ralph"`, `"copilot/gen-spec"`, `"opencode/deep-research-codebase"`.

- `agent` — `"claude"` | `"copilot"` | `"opencode"` (set via `.for(agent)` on the builder — pass the agent name as a runtime string argument)
- `name` — from `defineWorkflow({ name })` — must be non-empty

## Validate-on-register

`registry.register(wf)` runs provider-specific validation immediately:

- **Source validation** — regex checks for anti-patterns in the workflow's
  `.run()` function body (e.g. direct `createClaudeSession` usage instead of
  `s.session.query()`). Warnings are printed to `console.warn`; they do not
  block registration.
- **Brand check** — the runtime checks `__brand === "WorkflowDefinition"` at
  execution time. Always end the builder chain with `.compile()` to produce
  the correct brand.

## Same-name / different-type collision detection

Registering the same `${agent}/${name}` key twice throws at registration time:

```
[atomic] Duplicate workflow registration: "claude/my-workflow" is already registered.
Each (agent, name) pair must be unique.
```

No silent overwriting. No precedence rules. Pick distinct names.

Two workflows with the **same name but different agents** (`"claude/ralph"` and
`"copilot/ralph"`) are distinct keys and register without conflict — that is the
intended pattern for cross-agent workflows.

## Input flag-name conflicts at `runWorkflow` time

`createRegistry()` + `listWorkflows` inspects all registered workflows and builds a
union of their declared inputs. If two workflows declare the same input name
with **different types**, `runWorkflow` throws immediately:

```
[atomic/worker] Input name conflict: "focus" is declared as "enum" in
"claude/gen-spec" but as "string" in "copilot/gen-spec".
Workflows sharing an input name must agree on the type.
```

Same name + same type: the flag is shared silently (one `--focus` covers
both workflows).

Note: `runWorkflow({ workflow })` is bound to a single workflow, so it
performs no union. Only the cli faces this class of conflict.

## Reserved flag names

The following input names are rejected by `defineWorkflow` because they
conflict with worker CLI flags:

```
name, agent, detach, list, help, version
```

Attempting to declare an input with one of these names throws at definition time:

```
[atomic] Input name "name" is reserved by the worker CLI.
Rename it. Reserved names: name, agent, detach, list, help, version.
```

This is enforced at `defineWorkflow` time — it cannot be registered into a
registry.

## `Registry` API

| Method | Signature | Behaviour |
|---|---|---|
| `register(wf)` | `(wf: WorkflowDefinition) → Registry` | Returns new registry with wf added. Throws on duplicate key. |
| `get(key)` | `(key: "${agent}/${name}") → WorkflowDefinition` | Typed retrieval. Throws if key not found. |
| `has(key)` | `(key: string) → boolean` | Returns `true` if key is registered. |
| `list()` | `() → readonly WorkflowDefinition[]` | All registered definitions as a frozen array. |
| `resolve(name, agent)` | `(name, agent) → WorkflowDefinition \| undefined` | Looks up by name + agent pair. Returns `undefined` if not found. |

## SDK version compatibility

Workflows may opt in to a minimum Atomic CLI version by declaring
`minSDKVersion` on `defineWorkflow()`. The field is **optional and
unset by default**.

```ts
defineWorkflow({
  name: "uses-new-stage-option",
  source: import.meta.path,
  minSDKVersion: "0.6.0", // refuse to load on older CLI
})
```

Set it when the workflow calls a newly-added SDK surface. Omit it when
using stable APIs. An unrecognised or unparseable value is silently
ignored — the workflow loads as compatible.

When the gate trips (`minSDKVersion > installed CLI`), the workflow is
surfaced as **incompatible** in the list and picker with a visible badge
(`⚠ needs v<X>`) rather than silently vanishing.

## TypeScript configuration

Standard module resolution handles all imports. Use `"moduleResolution":
"bundler"` in `tsconfig.json` (Bun's default). Type-check with:

```bash
bun typecheck
```

The TypeScript compiler catches:
- Invalid `SessionContext` / `WorkflowContext` field access
- Wrong session callback signatures
- Missing required fields (`name`, `run`)
- SDK type mismatches (`s.save()` wrong shape)
- Incorrect provider-specific method calls
