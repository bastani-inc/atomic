## 1. Relevant external facts

- `@bastani/workflows` is currently **raw TypeScript** and loaded directly (`package.json` points `main`/`exports` at `./src/*.ts` and `./builtin/*.ts`).
- Workflow discovery uses **`jiti/static`** with `tryNative: false` and `virtualModules` for `@bastani/workflows` / `@bastani/workflows/builtin`.
- Workflow definitions are authored through **`defineWorkflow(...).description().input().output().run().compile()`** and branded with a private sentinel (`__piWorkflow`) plus a `WeakSet` brand check.
- Inputs/outputs are modeled with **TypeBox** schemas, and runtime validation/type inference depend on that schema shape.
- Builtin workflows (`goal`, `ralph`, `deep-research-codebase`, `open-claude-design`) are not just examples; they encode reusable orchestration patterns using `ctx.task()`, `ctx.parallel()`, `ctx.chain()`, stage prompts, and structured outputs.
- Execution semantics are split across **foreground** and **background** runners, with supporting pieces for cancellation, status, concurrency limiting, and worktree setup.

## 2. Local implications

- A Rust migration cannot just translate the builtin workflow files; it must replace the **workflow authoring/runtime contract** exposed by `defineWorkflow`, `WorkflowRunContext`, and the task primitives.
- The biggest compatibility boundary is **dynamic workflow loading**:
  - today: JS/TS modules loaded through `jiti`
  - in Rust: you’ll need a new discovery/registration mechanism or a JS compatibility layer.
- If you want to keep existing workflow files usable, Rust would need to preserve:
  - module shape (`default` export + named exports),
  - the `__piWorkflow`/brand validation concept,
  - schema-driven inputs/outputs,
  - task composition semantics (`task`, `parallel`, `chain`),
  - background resume/cancellation behavior.
- The builtin workflows show the repo’s “orchestration semantics” are not a thin wrapper; they are a **mini DSL + runtime**. So migration is likely a **runtime rewrite**, not a file-by-file port.
- Since `@bastani/workflows` is bundled into Atomic and consumed via extension loading, Rust migration also has to address the **extension ABI** in the host package.

## 3. Version/API assumptions

- Assumed current package: `@bastani/workflows@0.8.24-alpha.3`.
- Assumed runtime target: **Bun >= 1.3.14** today; Rust replacement would need to decide whether Bun remains as a host for JS glue or is removed entirely.
- Assumed key APIs that matter for parity:
  - `defineWorkflow()`
  - `ctx.task()`
  - `ctx.parallel()`
  - `ctx.chain()`
  - workflow module loader / discovery
  - foreground/background runner APIs
  - TypeBox schema validation

## 4. Unverified or unnecessary research

- I did **not** need external web research to reach the main conclusion; the local code already shows the migration surface.
- I did **not** verify any Rust ecosystem library choices yet (e.g. workflow engines, serde schema tooling, plugin loading). That would be the next step if you want an implementation plan.
- I also haven’t confirmed whether you want:
  - a full Rust rewrite,
  - a Rust core with JS compatibility shims,
  - or just the builtin workflows moved first.