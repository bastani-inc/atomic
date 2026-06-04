No dedicated Rust-migration ADR/spec was found; the strongest evidence is a mix of rewrite specs, research docs, and an open TODO.

| Path | Evidence | Relevance | Confidence |
|---|---|---:|---:|
| `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` | Full rewrite spec; says Atomic is being rebuilt as a fork/rebrand of `pi-coding-agent`, with all tmux/Claude/Copilot/OpenCode deps removed | Highest: primary decision history for a major platform rewrite | High |
| `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md` | Inventory/research artifact mapping the whole CLI/SDK for a planned rewrite onto `pi-coding-agent`; details what is removable vs load-bearing | Highest: codebase migration map and architecture inventory | High |
| `specs/2026-03-18-atomic-v2-rebuild.md` | Rebuild spec; proposes replacing the current 82K-line TS app with a simplified architecture and major code reduction | Very relevant: broader rewrite rationale and target architecture | High |
| `research/docs/2026-03-13-codebase-architecture-modularity-analysis.md` | Architecture analysis likely used to justify decomposition/refactor decisions | Relevant supporting research for migration planning | Medium |
| `research/docs/2026-01-18-atomic-cli-implementation.md` | Early implementation/design history for the CLI | Useful baseline for what exists before rewrite | Medium |
| `research/docs/2026-05-11-atomic-codebase-inventory.md` | Codebase inventory with subsystem breakdown and dependencies | Very relevant for migration scoping and sequencing | High |
| `README.md` | Says: “Run ralph to port the VS Code desktop shell from Electron to Tauri/Rust…” | Strong hint of Rust/Tauri direction, but appears product/roadmap-level rather than repo-wide migration plan | Medium |
| `.atomic/todos/97ca89a1.md` | Open todo: “Map repository for TS-to-Rust migration research” | Direct evidence of current investigation work | High |
| `DESIGN.md` | General Atomic design system / product design doc | Indirect; helps understand app boundaries but not Rust migration specifically | Low |
| `research/docs/2026-03-28-ghcr-multi-variant-docker-build.md` | Mentions Rust devcontainer examples and packaging/distribution concerns | Weakly relevant operational context, not migration decision history | Low |