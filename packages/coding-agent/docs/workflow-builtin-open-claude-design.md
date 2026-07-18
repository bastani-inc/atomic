# `open-claude-design`

Use this builtin for guided UI and design work with reference discovery, browser previews, iterative feedback, and a rich handoff.

### `open-claude-design`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | What to design (dashboard, page, component, prototype, …). The discovery stage refines this into a confirmed brief and asks for the output type and references. |
| `discover_references` | boolean | no | `true` | Discover beautiful, current reference designs (Awwwards, recent.design, Dribbble, Monet, Motionsites) and feed them to generation. Set `false` to skip the network/browser reference pass. |
| `max_refinements` | number | no | `3` | Maximum generate/user-feedback loop iterations. |

The output type (`prototype`, `wireframe`, `page`, `component`, `theme`, `tokens`) and any reference designs are **not** inputs — the discovery stage asks for them. There is no `design_system` input; the project's `DESIGN.md`/`PRODUCT.md` are established/loaded automatically.

Result fields:

| Field | Meaning |
|---|---|
| `output_type` | Kind of design artifact produced (chosen during the discovery interview). |
| `design_system` | Design system source used for generation: the project-derived design system. |
| `artifact` | Latest final design summary from the approved preview artifact. |
| `handoff` | Final rich HTML spec and implementation handoff summary. |
| `approved_for_export` | Whether the latest user-feedback stage reported no further changes before export. |
| `refinements_completed` | Number of refinement iterations completed. |
| `import_context` | Reference-import context used during generation. |
| `run_id` | Per-run design workflow artifact identifier. |
| `artifact_dir` | Directory containing preview and spec artifacts. |
| `preview_path` | Absolute path to the generated `preview.html` file. |
| `preview_file_url` | `file://` URL for the generated `preview.html` file. |
| `spec_path` | Absolute path to the generated `spec.html` file. |
| `spec_file_url` | `file://` URL for the generated `spec.html` file. |
| `playwright_cli_status` | Outcome of the initial deterministic step that ensures the `playwright-cli` skill's `playwright-cli` command is installed. |

`open-claude-design` has no `result` output; it exposes only the declared fields listed above. Use the declared `artifact` and `handoff` fields for generated content.

**Combined discovery/init.** The workflow's first and only front-door stage runs `/skill:impeccable shape` and `/skill:impeccable init` together. It interviews you (via the structured question tool) about what you want to build, the **output type** (`prototype`, `wireframe`, `page`, `component`, `theme`, or `tokens`), and which **references** to emulate (URLs, local file paths, screenshots, or design docs). Then, in the same `discovery` stage, impeccable init performs its own `PRODUCT.md`/`DESIGN.md` detection and creates or reconciles those files as needed. The references you name take **precedence over `DESIGN.md`/`PRODUCT.md`** during generation (the design system fills gaps the references don't cover, and `PRODUCT.md` still governs strategic register/voice). Headless runs infer a defensible brief, output type, references, and project-context assumptions rather than blocking.

**Context and reference phase.** Design-system/reference research runs first, then gallery reference discovery uses those findings before the generator consumes the combined context:

- *Design-system/reference research* — three parallel passes (`ds-locator` / `ds-analyzer` / `ds-patterns`) extract the project's design-system evidence and also handle user-provided references. URL references are captured with browser/screenshot tooling where available; local files, screenshots, and design docs are parsed by the applicable `ds-*` pass. Their extracted requirements feed the generator and **take precedence over `DESIGN.md`/`PRODUCT.md`**. There are no separate `web-capture-*`, `file-parser-*`, or `design-system-builder` stages.
- *Reference discovery* (gated by `discover_references=true`, the default) — after the `ds-*` passes complete, the `reference-discovery` stage receives their evidence plus the `PRODUCT.md`/`DESIGN.md` init summary. It uses the `playwright-cli` skill to browse five curated galleries — [Awwwards](https://www.awwwards.com/websites/), [recent.design](https://recent.design/), [Dribbble recents](https://dribbble.com/shots/recent), [Monet](https://www.monet.design/c), and [Motionsites](https://motionsites.ai/) — then **clicks into the standout work** and, ideally, **records a scroll-through video of each real design page so its animations are captured** (with a full-page screenshot as a supplement/fallback) plus the real destination URL (it does not just screenshot the gallery thumbnails; web-search fallback when the browser is unavailable). It then asks which curated reference direction you prefer; if none align, it asks you to provide a reference image, screenshot, URL, or local path for best results. The curated **references brief** is persisted to `<artifact_dir>/references.md` and threaded into the generator (`reference_inspiration`) and refinement. Set `discover_references=false` to skip it.

**Generate/user-feedback loop.** Refinement is intentionally simple and mirrors Ralph's implement/reviewer rhythm: `generate-1` writes the first `preview.html`, `user-feedback-1` opens that preview with `/skill:impeccable live`, and any captured `live_changes`, `user_notes`, or `annotated_snapshot` feed the next forked `generate-*` stage. Generator and feedback stages keep separate session lineages: each later `generate-*` forks from the previous generate session, `user-feedback-1` starts its own feedback chain, and each later `user-feedback-*` forks only from the previous feedback session rather than falling back to generator sessions. When a `user-feedback-*` stage captures no meaningful feedback, the loop exports immediately. Export is deliberately just `exporter` followed by `final-display`; there is no pre-export scan, forced-fix stage, or export gate. Captured feedback is persisted as durable artifacts under `<artifact_dir>/feedback/iteration-<n>.md` / `.json` (plus a best-effort copy of the annotated snapshot, constrained to files within the project/artifact dir). If captured notes fail to thread into the next generate prompt, the run fails loudly rather than silently generating without user feedback.

**Browser requirement.** open-claude-design is browser-centric (the discovery/preview review and the `live` QA loop need the `playwright-cli` skill's browser). If the browser cannot be made available, the workflow exits cleanly up front — surfacing the would-be artifact paths and install instructions — rather than generating a design you could not review interactively. (This early exit is skipped under the test harness so headless test runs still complete.)

Run examples:

```text
/workflow open-claude-design prompt="Refresh the settings page hierarchy"
/workflow open-claude-design prompt="Design a billing page like Stripe's"
/workflow open-claude-design prompt="Generate spacing and color tokens"
/workflow open-claude-design prompt="Design a marketing landing page" discover_references=false
```

The discovery interview asks for the output type and any reference URLs/files, so you no longer pass `output_type`, `reference`, or `design_system` on the command line.


## Package-reference details

The following details were previously maintained in the package README and are preserved here as part of the canonical builtin reference.

### `open-claude-design`

Combined discovery/init → design-system/reference research → curated reference discovery with user preference check → separate forked generate and user-feedback chains → export/handoff pipeline. The `discovery` stage asks for output type and references, then runs impeccable init in the same stage so PRODUCT.md/DESIGN.md are detected, created, or reconciled. `ds-*` stages handle user-provided URL/file reference extraction directly, then `reference-discovery` uses that context and asks which curated direction you prefer (or asks for a reference image/path/URL if none fit). Export is only `exporter` plus `final-display`.

```text
/workflow open-claude-design prompt="Design a kanban board component"
```

| Input                 | Type      | Required | Default | Description                                                                 |
| --------------------- | --------- | -------- | ------- | --------------------------------------------------------------------------- |
| `prompt`              | `text`    | ✓        | —       | Design brief or description.                                                |
| `discover_references` | `boolean` | —        | `true`  | Discover current gallery references with browser tooling; set false to skip. |
| `max_refinements`     | `number`  | —        | `3`     | Maximum generate/user-feedback loop iterations.                              |

Child workflow outputs: `output_type`, `design_system`, `artifact`, `handoff`, `approved_for_export`, `refinements_completed`, `import_context`, `run_id`, `artifact_dir`, `preview_path`, `preview_file_url`, `spec_path`, `spec_file_url`, and `playwright_cli_status`. `open-claude-design` has no `result` output; it exposes only the declared fields listed here.
