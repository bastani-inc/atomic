## 1. Behavioral model

This partition is the **dynamic plugin boundary** for the repo.

- `packages/coding-agent/src/core/extensions/loader.ts` loads extension entrypoints with **`jiti`**, not native import.
- It supports two runtime modes:
  - **Bun binary**: uses in-memory `virtualModules` so bundled deps resolve without filesystem packages.
  - **Dev/Node-like mode**: uses `alias` mappings to point extension imports at local workspace/package paths.
- Extension modules are expected to export a **factory function**; non-function exports are rejected.
- The factory receives an `ExtensionAPI` that lets it register:
  - tools, commands, shortcuts, flags
  - event handlers
  - message renderers and UI behaviors
  - provider registrations
- The runtime object starts with **throwing stubs** for action methods, then gets bound later by the runner; some registrations are allowed during load, but stateful actions are intentionally blocked until initialization completes.

The workflow subsystem uses the same pattern:

- `packages/workflows/src/extension/workflow-module-loader.ts` loads workflow files via `jiti`.
- It disables native import fallback and uses in-memory virtual modules for the `@bastani/workflows` SDK and builtins.
- It normalizes module shapes carefully because `jiti` can return proxy-like namespace objects.
- Workflow exports must pass a branded sentinel check (`__piWorkflow === true`) and structural validation.

## 2. Key flows and invariants

### Extension loading flow
1. Resolve candidate path relative to CWD.
2. `createJiti(...)` with mode-specific resolution strategy.
3. `jiti.import(..., { default: true })`
4. Verify default export is a function.
5. Create extension record and API.
6. Execute factory.
7. Return loaded extension or an error string.

### Discovery flow
`discoverAndLoadExtensions(...)` collects paths from:
1. local `.atomic/extensions`
2. global `~/.atomic/extensions`
3. explicit configured paths

Discovery rules:
- direct `*.ts` / `*.js` files are loadable
- directories can expose `index.ts` / `index.js`
- directories with `package.json` may declare `atomic.extensions` or legacy `pi.extensions`
- no recursion beyond one level unless declared in manifest

### Invariants
- **Factory must be callable**; plain objects are rejected.
- **Discovery is deterministic** and de-duplicates by resolved path.
- **Loaded extension state is isolated per extension record**, but runtime actions share one runtime object.
- **Load-time side effects are expected**; this is trusted code execution, not sandboxing.
- **Workflow exports are stricter than extension exports** because they must be branded, not hand-rolled.

### Coupling to migration
This is the main place where TS-to-Rust migration becomes a product decision:
- keep JS/TS plugin support via embedded JS engine or loader bridge
- replace with a new Rust plugin ABI
- or move plugins to subprocess/message-based plugins

A pure Rust rewrite breaks the current assumption that user-authored `.ts/.js` files are directly executable.

## 3. Tests / validation

Good coverage exists for extension behavior:

- `packages/coding-agent/test/extensions-discovery.test.ts`
  - `.ts` and `.js` discovery
  - `index.ts` / `index.js`
  - `package.json` manifest discovery
  - legacy `pi` manifest compatibility
  - precedence rules
  - no recursion beyond one level
  - explicit path loading vs discovery
- `packages/coding-agent/test/extensions-runner.test.ts`
  - shortcut conflict resolution
  - built-in shortcut reservation behavior
  - duplicate shortcut handling
  - runtime/tool wrapping behavior
  - event/input semantics indirectly through runner behavior
- `packages/coding-agent/test/extensions-input-event.test.ts`
  - input event propagation semantics

Workflow loader validation is present in code, but I did not verify a dedicated test file for `workflow-module-loader.ts` in the provided evidence.

## 4. Risks, unknowns, and verification steps

### Risks
- **Highest risk:** preserving the extension/workflow author experience after Rust migration.
- `jiti` is used in **two subsystems**, so replacing only core extensions still leaves another dynamic loader.
- Current extension API surface is broad and UI-heavy; a Rust plugin API would need equivalents for:
  - tool registration
  - commands/shortcuts
  - interactive UI widgets/overlays
  - provider hooks
  - event bus integration
- Binary mode depends on `virtualModules`; Rust will need an alternative dependency packaging story.

### Unknowns
- Whether you want:
  1. Rust core with embedded JS plugin support
  2. Rust core with subprocess plugins
  3. full Rust-native plugin rewrite
- Whether workflow files and extensions must remain authorable in TS/JS.
- Whether compatibility with legacy `pi` manifests must be preserved.

### Verify next
- Audit all consumers of `ExtensionAPI` and `ExtensionRuntime`.
- Trace workflow loading consumers alongside extension loading.
- Decide the plugin boundary before rewriting core runtime.
- Confirm which parts must remain user-scripted vs compiled-native.