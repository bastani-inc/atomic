## 1. Prior decisions

### Rewrite-first, not direct TS-to-Rust, is the clearest historical direction

No dedicated Rust migration ADR/spec was found. The locator explicitly says: “No dedicated Rust-migration ADR/spec was found” in `research/.deep-research-2026-06-04T01-07-19-623Z/01-history-locator.md`.

The strongest prior decision is that Atomic was being rebuilt as a fork/rebrand of `pi-coding-agent`, not as a direct Rust rewrite. The key artifact is `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md`, described as a “Full rewrite spec” where Atomic is rebuilt from `pi-coding-agent` with “tmux/Claude/Copilot/OpenCode deps removed.”

### Simplification and code reduction were already explicit goals

A broader rebuild rationale exists in `specs/2026-03-18-atomic-v2-rebuild.md`, which proposes replacing the “current 82K-line TS app with a simplified architecture and major code reduction.” This is likely still relevant as migration context, but the exact line count and architecture assumptions may be stale.

### Migration planning should be inventory-driven

Multiple prior artifacts focused on mapping the codebase and identifying load-bearing vs removable pieces:

- `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md` — described as a codebase migration map for rewriting onto `pi-coding-agent`.
- `research/docs/2026-05-11-atomic-codebase-inventory.md` — described as a subsystem/dependency inventory.
- `research/docs/2026-03-13-codebase-architecture-modularity-analysis.md` — supporting architecture/decomposition analysis.

These suggest prior work favored understanding subsystem boundaries before rewriting.

### Rust/Tauri exists as a product-level direction, not a repo-wide migration plan

`README.md` says: “Run ralph to port the VS Code desktop shell from Electron to Tauri/Rust…” The locator classifies this as a “strong hint of Rust/Tauri direction” but “product/roadmap-level rather than repo-wide migration plan.”

## 2. Relevant research artifacts

High-confidence, most relevant:

- `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` — primary rewrite decision history.
- `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md` — migration architecture map.
- `research/docs/2026-05-11-atomic-codebase-inventory.md` — subsystem/dependency inventory.
- `specs/2026-03-18-atomic-v2-rebuild.md` — broad rebuild rationale and simplification goal.
- `.atomic/todos/97ca89a1.md` — current open TODO: “Map repository for TS-to-Rust migration research.”

Medium/low-confidence supporting context:

- `research/docs/2026-03-13-codebase-architecture-modularity-analysis.md`
- `research/docs/2026-01-18-atomic-cli-implementation.md`
- `DESIGN.md`
- `research/docs/2026-03-28-ghcr-multi-variant-docker-build.md`

## 3. Open questions

1. Is the desired migration actually TypeScript-to-Rust, or specifically Electron/desktop-shell-to-Tauri/Rust?  
   Evidence: `README.md` references Tauri/Rust for the VS Code desktop shell, but the locator says this is not a repo-wide Rust migration plan.

2. Should the current path continue the `pi-coding-agent` rewrite strategy or supersede it with Rust migration planning?  
   Evidence: `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` is the strongest prior rewrite decision, while `.atomic/todos/97ca89a1.md` shows a newer TS-to-Rust research task.

3. Which subsystems are candidates for Rust first?  
   Existing inventory artifacts exist at `research/docs/2026-05-11-atomic-codebase-inventory.md` and `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md`, but the locator does not say they already classify Rust migration candidates.

4. Which assumptions are stale?  
   The March/May 2026 docs may predate current repo changes, especially `specs/2026-03-18-atomic-v2-rebuild.md` and the May inventory docs.

## 4. How this should steer the new investigation

- Start by reading `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` and `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md`; they are the highest-confidence prior migration/rewrite artifacts.
- Treat Rust/Tauri as a hypothesis, not an established repo-wide migration decision, because only `README.md` hints at it.
- Verify current code against the May 2026 inventories before relying on them.
- Frame the investigation around: “Which parts, if any, should move to Rust?” rather than assuming a full TypeScript-to-Rust rewrite is already decided.