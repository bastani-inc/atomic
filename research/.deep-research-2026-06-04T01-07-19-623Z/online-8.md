## 1. Relevant external facts

- **JSONL / JSON Lines** is a line-oriented format: one valid JSON value per line, UTF-8 text, newline-delimited. The official docs explicitly frame it as a good fit for append-only logs and streaming processing.  
  Sources: [jsonlines.org](https://jsonlines.org/), [ndjson spec](https://github.com/ndjson/ndjson-spec)

- In Rust, the common pattern is to read JSONL **line-by-line** with buffered I/O, then deserialize each line independently (e.g. `BufReader` + `serde_json`, or a helper crate like `serde-jsonlines`).  
  Sources: [serde_json `from_reader`](https://docs.rs/serde_json/latest/serde_json/fn.from_reader.html), [serde-jsonlines](https://docs.rs/serde-jsonlines/latest/serde_jsonlines/fn.json_lines.html)

- `serde_json` is strict about deserializing a single JSON value from a stream; for JSONL you typically split lines first. This matters because your session files are not a single JSON document.  
  Source: [`serde_json::from_reader`](https://docs.rs/serde_json/latest/serde_json/fn.from_reader.html)

## 2. Local implications

- Your repo’s session files are **append-friendly JSONL logs**, not a normalized database. A Rust port should preserve:
  - header-first layout
  - tolerant per-line parsing
  - skipping malformed lines
  - rewrite-on-branch semantics

- The current TS implementation treats the **file header as compatibility gatekeeper**:
  - no valid `session` header ⇒ file is rejected/repaired
  - malformed lines are ignored, not fatal
  - migration is applied in memory before use

- Branching is not just tree navigation; it also rewrites file state:
  - `createBranchedSession()` copies the root-to-leaf path
  - label entries are re-emitted for entries on that path
  - branch summaries and compaction entries remain part of the path model

- Labels are **derived state plus persisted history**:
  - `label` entries are stored in the JSONL stream
  - latest label wins
  - labels on entries not retained in the branched path are dropped
  - labels are excluded from LLM context

- Compatibility risk for a Rust rewrite is mainly **format fidelity**, not algorithmic complexity:
  - preserve entry shapes exactly
  - preserve version migration behavior
  - preserve path traversal/leaf semantics
  - preserve recovery from partially corrupt files

## 3. Version/API assumptions

- Current session format in this repo is **version 3**.
- Migration chain in TS is:
  - v1 → v2: add `id` / `parentId`
  - v2 → v3: rename `hookMessage` role to `custom`
- The Rust implementation should assume:
  - old sessions may still exist on disk
  - unknown/malformed lines may appear
  - `session` header version may be missing (treated as v1)

## 4. Unverified or unnecessary research

- I did **not** verify a specific Rust crate choice for the migration; the core requirement is line-by-line JSONL compatibility, regardless of whether you use `serde_jsonlines`, manual `BufRead::lines()`, or another helper.
- I did **not** research external standards beyond JSONL/NDJSON because the repo-specific session contract is the dominant source of truth here.
- The exact third-party compatibility surface for consumers outside this repo remains unverified.