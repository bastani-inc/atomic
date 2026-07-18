# Built-in workflows

Atomic bundles four workflows. Use this index to choose one, then open its dedicated page for exact inputs, outputs, lifecycle semantics, and examples.

## Built-in Workflows

Atomic bundles four workflows that cover the most common multi-stage jobs. They are available in every session — no install step required. Use `/workflow list` to confirm they are loaded, and `/workflow inputs <name>` to see the exact inputs in your environment.

These same builtin workflows are also available to workflow authors as workflow definitions. Import them from `@bastani/workflows/builtin` and pass the definition directly to `ctx.workflow(...)` when one workflow should call `deep-research-codebase`, `goal`, `ralph`, `open-claude-design`, or another builtin as a nested child workflow. See [Workflow Composition](/workflow-composition#workflow-composition) for full examples alongside user-defined child workflows.

For the builtin result tables below, `deep-research-codebase`, `goal`, and `ralph` explicitly declare an optional `result` output with `Type.Optional(Type.String(...))` and return a `result` key from `run`, so `result` is part of their declared output contract. Every output a workflow exposes — including `result` — must be declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`; Atomic no longer adds any automatic `result` output.

| Workflow | What it does | When to use |
|---|---|---|
| `deep-research-codebase` | Scout + research-history chain → parallel specialist waves → aggregator. Indexes the whole repo and synthesizes findings. | Broad or cross-cutting research before you decide what to change. Prefer `/skill:research-codebase` for one subsystem. |
| `goal` | Persisted goal ledger → bounded worker turns → receipts → three-reviewer gate → deterministic reducer → final report → optional final-stage PR handoff after approval. | Clearly delegated autonomous work that materially benefits from a durable goal ledger, bounded worker turns, named validation, and reviewer-gated completion; optionally allow only the final `pull-request` stage to attempt PR creation with `create_pr=true` after Goal reaches `complete`. |
| `ralph` | Raw prompt → research-prompt-refinement → codebase/online research → sub-agent orchestration → multi-model parallel review → optional final-stage PR handoff. | Clearly delegated autonomous work that materially benefits from a durable research-first pipeline, delegated implementation, and iterative review; optionally allow only the final `pull-request` stage to attempt PR creation with `create_pr=true`. |
| `open-claude-design` | Combined discovery/init (`/skill:impeccable shape` + `/skill:impeccable init` in one `discovery` stage) → design-system/reference research (`ds-*`) → curated gallery reference-discovery using that context → separate forked `generate-*` and `user-feedback-*` chains → rich HTML handoff (`exporter` → `final-display`). The discovery stage asks what to build, the output type, and which references to emulate, then lets impeccable init detect/create/reconcile `PRODUCT.md` and `DESIGN.md` (references take precedence over project context). Renders a live `preview.html` you can iterate against in the browser (opens through impeccable `live` / the `playwright-cli` skill when available). | UI, page, component, theme, or design-token work that benefits from a guided brief, beautiful references, and generation + user feedback loops. |


## Builtin guides

- [`deep-research-codebase`](/workflow-builtin-deep-research-codebase)
- [`goal`](/workflow-builtin-goal)
- [`ralph`](/workflow-builtin-ralph)
- [`open-claude-design`](/workflow-builtin-open-claude-design)
