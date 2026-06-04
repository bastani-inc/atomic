## 1. Relevant external facts

- **Rust/Cargo is a different packaging model than TypeScript/Bun**: you’ll need a `Cargo.toml` workspace, crates, and a compiled binary release flow instead of `package.json` + raw TS loading.
- **Rust cannot directly import/execute `.ts` extension modules**. So anything currently relying on `jiti`/runtime TS loading must be replaced by:
  - compiled Rust plugins,
  - embedded JS/Node sidecar,
  - or a new file-based manifest format.
- **Rust binaries are typically native single executables**; cross-platform distribution will shift from Bun compile/build scripts to Cargo release artifacts.

## 2. Local implications

- Your repo has **no Rust baseline** yet, so this is a **greenfield replacement**, not a translation.
- The biggest migration blockers are the same ones your inventory flagged:
  - `packages/coding-agent/src/core/extensions/loader.ts` and workflow loaders that depend on dynamic TS loading.
  - session/state contracts like JSONL persistence and `status.json` read/write behavior.
  - CLI surfaces in `packages/coding-agent/src/cli.ts`, `args.ts`, and `main.ts`.
- The cleanest migration path is to split into layers:
  1. **Rust CLI/runtime core**: command parsing, config, session management, provider/tool orchestration.
  2. **Compatibility boundary**: preserve on-disk formats and CLI flags where possible.
  3. **Extension system redesign**: replace TS-loaded extensions/workflows with a Rust-native plugin model or a separate JS extension host.
- Current CI/build assumptions in `docs/ci.md` will need a full rewrite from Bun scripts to Cargo-based checks/build/release.
- The most fragile part is the repo’s **bundled private packages** model (`workflows`, `subagents`, `mcp`, `web-access`, `intercom`). In Rust, these likely become crates or modules instead of workspace packages.

## 3. Version/API assumptions

- Assume **no compatibility guarantee** with existing TS extension APIs unless you intentionally build one.
- Assume the current `jiti`-based loader cannot survive unchanged.
- Assume current JSONL/session schema and config roots (`.atomic`, legacy `.pi`) are worth preserving only if you want a smoother migration.
- If you want a practical migration, treat `packages/coding-agent/src/core/sdk.ts#createAgentSession` and `AgentSession` as the conceptual API boundary to re-implement in Rust first.

## 4. Unverified or unnecessary research

- I did **not** need external ecosystem docs to answer the repo-specific migration shape.
- I did **not** verify Rust crate choices, async runtime, TUI library, or plugin framework yet.
- Next useful research would be:
  - Rust TUI stack options,
  - Rust plugin/extension patterns,
  - JSONL/session persistence in Rust,
  - and whether you want to keep a JS compatibility layer for existing extensions.