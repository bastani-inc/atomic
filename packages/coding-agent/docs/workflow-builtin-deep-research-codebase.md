# `deep-research-codebase`

Use this builtin for broad, parallel codebase research that should end in a durable report and auditable artifacts.

### `deep-research-codebase`

Inputs:

| Input | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | text | yes | — | Research question or investigation focus. |
| `max_partitions` | number | no | `100` | Maximum codebase partitions explored in parallel. Actual partitions scale by one per 10K LoC, capped by this value. |
| `max_concurrency` | number | no | `100` | Maximum workflow stages running concurrently during deep research. |

Run examples:

```text
/workflow deep-research-codebase prompt="How do payment retries work end to end?"
/workflow deep-research-codebase prompt="Map the workflow runtime" max_partitions=8 max_concurrency=4
```

Workflow tool call:

```ts
workflow({
  action: "run",
  workflow: "deep-research-codebase",
  inputs: { prompt: "map workflow runtime", max_concurrency: 4 },
})
```

Output locations and result fields:

| Field | Meaning |
|---|---|
| `result` | Final Markdown research report text, matching `findings`. |
| `findings` | Final Markdown research report text. |
| `research_doc_path` | Public report path under `research/<date>-<topic>.md`. If a file already exists, the workflow writes a suffixed filename. |
| `artifact_dir` | Hidden per-run handoff directory under `research/.deep-research-<run-id>/`. |
| `manifest_path` | Manifest JSON path inside the hidden artifact directory. |
| `partitions` | Codebase partitions the specialists explored. |
| `explorer_count` | Number of partition explorer groups used. |
| `specialist_count` | Number of specialist stages run across the research waves. |
| `max_concurrency` | Concurrency limit used for the run. |
| `history` | Prior-research/history overview included in the final synthesis. |

The dated Markdown report is intended for people to read and commit or share. The hidden artifact directory keeps large scout, history, and specialist handoff files available for audit without cluttering the visible research index.


## Package-reference details

The following details were previously maintained in the package README and are preserved here as part of the canonical builtin reference.

### `deep-research-codebase`

Scout + research-history chain → two parallel specialist waves → aggregator. Ideal for deep investigation of a codebase topic across locator, pattern, analyzer, and ecosystem angles.

```text
/workflow deep-research-codebase prompt="How does session persistence work?"
```

| Input             | Type     | Required | Default | Description                                               |
| ----------------- | -------- | -------- | ------- | --------------------------------------------------------- |
| `prompt`          | `text`   | ✓        | —       | Research question or topic to investigate.                |
| `max_partitions`  | `number` | —        | `100`   | Maximum number of codebase partitions to explore.         |
| `max_concurrency` | `number` | —        | `100`   | Maximum number of workflow stages to run concurrently.    |

Final Markdown research documents are written to dated `research/` paths relative to the current working directory, with a numeric suffix if needed to avoid overwriting an existing document. Hidden run artifacts are written under `research/.deep-research-<run-id>/`.

Child workflow outputs: `result`, `findings`, `research_doc_path`, `artifact_dir`, `manifest_path`, `partitions`, `explorer_count`, `specialist_count`, `max_concurrency`, and `history`.
